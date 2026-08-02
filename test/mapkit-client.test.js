import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import { contentSecurityPolicyDirectives } from "../app/app.js";
import { loadConfig } from "../app/config.js";

const moneyScriptPath = path.resolve("app/public/js/money.js");
const transactionsViewPath = path.resolve("app/views/transactions.ejs");

async function mapKitHarness({ documentOverrides = {}, windowOverrides = {} } = {}) {
  const source = await readFile(moneyScriptPath, "utf8");
  const initializeMarker = "  function initialize() {";
  assert.ok(source.includes(initializeMarker));
  const instrumented = source.replace(
    initializeMarker,
    `  window.__moneyMapKitTest = {
    fetchMapKitAuthorizationToken,
    configureMapKit,
    loadMapKit,
    validLocationCoordinate,
    directTransactionCoordinate,
    geocodedCoordinate,
    renderTransactionMap,
    transactionLocations,
  };

${initializeMarker}`,
  );
  const document = {
    readyState: "loading",
    addEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    ...documentOverrides,
  };
  const window = {
    addEventListener() {},
    removeEventListener() {},
    clearTimeout,
    setTimeout,
    ...windowOverrides,
  };
  const context = vm.createContext({
    console,
    document,
    fetch: windowOverrides.fetch || globalThis.fetch,
    FormData,
    Intl,
    Math,
    Number,
    Promise,
    URL,
    URLSearchParams,
    window,
  });
  vm.runInContext(instrumented, context, { filename: moneyScriptPath });
  return { document, helpers: window.__moneyMapKitTest, window };
}

function stubMapKit({ geocoderResults = [] } = {}) {
  const state = {
    geocoderLookups: [],
    initializations: [],
    listeners: new Map(),
    maps: [],
  };
  class Coordinate {
    constructor(latitude, longitude) {
      this.latitude = latitude;
      this.longitude = longitude;
    }
  }
  class CoordinateSpan {
    constructor(latitudeDelta, longitudeDelta) {
      this.latitudeDelta = latitudeDelta;
      this.longitudeDelta = longitudeDelta;
    }
  }
  class CoordinateRegion {
    constructor(center, span) {
      this.center = center;
      this.span = span;
    }
  }
  class MarkerAnnotation {
    constructor(coordinate, options) {
      this.coordinate = coordinate;
      this.options = options;
    }
  }
  class MapView {
    constructor(element, options) {
      this.element = element;
      this.options = options;
      this.annotations = [];
      this.destroyed = false;
      state.maps.push(this);
    }

    addAnnotation(annotation) {
      this.annotations.push(annotation);
    }

    destroy() {
      this.destroyed = true;
    }
  }
  class Geocoder {
    async lookup(address) {
      state.geocoderLookups.push(address);
      return geocoderResults;
    }
  }
  const mapkit = {
      addEventListener(name, listener) {
        const listeners = state.listeners.get(name) || new Set();
        listeners.add(listener);
        state.listeners.set(name, listeners);
      },
      Coordinate,
      CoordinateRegion,
      CoordinateSpan,
      FeatureVisibility: { Hidden: "hidden" },
      Geocoder,
      init(options) {
        state.initializations.push(options);
      },
      Map: MapView,
      MarkerAnnotation,
      removeEventListener(name, listener) {
        state.listeners.get(name)?.delete(listener);
      },
    };
  return {
    emit(name, event = {}) {
      for (const listener of state.listeners.get(name) || []) {
        listener(event);
      }
    },
    mapkit,
    state,
  };
}

function locationFixture(dataset = {}) {
  const mapElement = { hidden: false };
  const listeners = new Map();
  const dialog = {
    open: true,
    addEventListener(name, listener) {
      listeners.set(name, listener);
    },
  };
  const root = {
    dataset,
    isConnected: true,
    closest(selector) {
      return selector === "dialog" ? dialog : null;
    },
    querySelector(selector) {
      return selector === "[data-mapkit-map]" ? mapElement : null;
    },
  };
  return { dialog, listeners, mapElement, root };
}

async function settleAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("CSP allows only the MapKit script and service origins needed by the client", () => {
  const config = loadConfig({
    NODE_ENV: "test",
    DEMO_MODE: "true",
  });
  const directives = contentSecurityPolicyDirectives(config);

  assert.deepEqual(
    directives.scriptSrc.filter((source) => source.includes("apple")),
    ["https://cdn.apple-mapkit.com"],
  );
  assert.deepEqual(
    directives.connectSrc.filter((source) => source.includes("apple")),
    ["https://*.apple-mapkit.com"],
  );
  assert.equal(
    Object.entries(directives)
      .filter(([name]) => !["scriptSrc", "connectSrc"].includes(name))
      .flatMap(([, sources]) => sources || [])
      .some((source) => source.includes("apple-mapkit")),
    false,
  );
});

test("CSP allows the remote Calibre stylesheet and font files", () => {
  const config = loadConfig({
    NODE_ENV: "test",
    DEMO_MODE: "true",
  });
  const directives = contentSecurityPolicyDirectives(config);

  assert.ok(directives.styleSrc.includes("https://fonts.yaboiii.com"));
  assert.ok(directives.fontSrc.includes("https://fonts.yaboiii.com"));
});

test("MapKit loader stays lazy, requests all three libraries, and configures dynamic authorization", async () => {
  let appendedScript;
  const authorizationRequests = [];
  const script = {
    dataset: {},
    listeners: {},
    addEventListener(name, listener) {
      this.listeners[name] = listener;
    },
    remove() {
      this.removed = true;
    },
  };
  const { helpers, window } = await mapKitHarness({
    documentOverrides: {
      createElement(name) {
        assert.equal(name, "script");
        return script;
      },
      head: {
        append(element) {
          appendedScript = element;
        },
      },
    },
    windowOverrides: {
      async fetch(url, options) {
        authorizationRequests.push({ url, options });
        return {
          ok: true,
          async json() {
            return {
              token: `dynamic-token-${authorizationRequests.length}`,
              expiresAt: "2026-08-01T12:00:00.000Z",
            };
          },
        };
      },
    },
  });

  const loading = helpers.loadMapKit();
  assert.equal(appendedScript.src, "https://cdn.apple-mapkit.com/mk/6/mapkit.core.js");
  assert.equal(appendedScript.crossOrigin, "anonymous");
  assert.equal(appendedScript.dataset.libraries, "map,annotations,services");
  assert.equal(appendedScript.dataset.token, undefined);

  const stub = stubMapKit();
  window.mapkit = stub.mapkit;
  window[appendedScript.dataset.callback]();
  assert.equal(await loading, stub.mapkit);
  assert.equal(stub.state.initializations.length, 1);

  const authorizationCallback =
    stub.state.initializations[0].authorizationCallback;
  const firstToken = await new Promise((resolve) =>
    authorizationCallback(resolve),
  );
  const refreshedToken = await new Promise((resolve) =>
    authorizationCallback(resolve),
  );
  assert.equal(firstToken, "dynamic-token-1");
  assert.equal(refreshedToken, "dynamic-token-2");
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        authorizationRequests.map(({ url, options }) => ({ url, options })),
      ),
    ),
    [
      {
        url: "/api/mapkit-token",
        options: {
          method: "GET",
          headers: { Accept: "application/json" },
          credentials: "same-origin",
          cache: "no-store",
        },
      },
      {
        url: "/api/mapkit-token",
        options: {
          method: "GET",
          headers: { Accept: "application/json" },
          credentials: "same-origin",
          cache: "no-store",
        },
      },
    ],
  );

  const failedScript = {
    dataset: {},
    addEventListener(name, listener) {
      if (name === "error") this.fail = listener;
    },
    remove() {
      this.removed = true;
    },
  };
  const failedHarness = await mapKitHarness({
    documentOverrides: {
      createElement() {
        return failedScript;
      },
      head: {
        append() {
          failedScript.fail();
        },
      },
    },
  });
  await assert.rejects(
    failedHarness.helpers.loadMapKit(),
    /did not load/,
  );
  assert.equal(failedScript.removed, true);
});

test("MapKit authorization failures resolve quietly and do not poison refresh", async () => {
  const responses = [
    { ok: false, json: async () => ({}) },
    {
      ok: true,
      async json() {
        throw new SyntaxError("invalid JSON");
      },
    },
    { ok: true, json: async () => ({ expiresAt: "later" }) },
    { ok: true, json: async () => ({ token: "  refreshed-token  " }) },
  ];
  const stub = stubMapKit();
  const { helpers } = await mapKitHarness({
    windowOverrides: {
      mapkit: stub.mapkit,
      async fetch() {
        return responses.shift();
      },
    },
  });

  await helpers.loadMapKit();
  const authorize = stub.state.initializations[0].authorizationCallback;
  const tokens = [];
  for (let index = 0; index < 4; index += 1) {
    tokens.push(await new Promise((resolve) => authorize(resolve)));
  }

  assert.deepEqual(tokens, ["", "", "", "refreshed-token"]);
});

test("authorization fetch failure hides and destroys the active map", async () => {
  const fixture = locationFixture({
    locationAddress: "123 Main St, San Francisco, CA 94105",
    locationLat: "37.789",
    locationLon: "-122.394",
    locationTitle: "Corner Market",
  });
  const stub = stubMapKit();
  const harness = await mapKitHarness({
    documentOverrides: {
      querySelectorAll() {
        return [fixture.root];
      },
    },
    windowOverrides: {
      mapkit: stub.mapkit,
      async fetch() {
        return { ok: false, json: async () => ({}) };
      },
    },
  });

  harness.helpers.transactionLocations();
  await settleAsyncWork();
  const map = stub.state.maps[0];
  assert.ok(map);
  const authorize = stub.state.initializations[0].authorizationCallback;
  const token = await new Promise((resolve) => authorize(resolve));
  await settleAsyncWork();

  assert.equal(token, "");
  assert.equal(map.destroyed, true);
  assert.equal(fixture.mapElement.hidden, true);
  assert.equal(fixture.root.dataset.mapkitState, "unavailable");
});

test("transaction markup never embeds a MapKit authorization token", async () => {
  const view = await readFile(transactionsViewPath, "utf8");

  assert.doesNotMatch(view, /data-mapkit-token/);
  assert.doesNotMatch(view, /mapkitJsToken/);
});

test("transaction map prefers Plaid coordinates and disables every interaction", async () => {
  const fixture = locationFixture({
    locationAddress: "123 Main St, San Francisco, CA 94105",
    locationLat: "37.789",
    locationLon: "-122.394",
    locationTitle: "Corner Market",
  });
  const stub = stubMapKit();
  const harness = await mapKitHarness({
    documentOverrides: {
      querySelectorAll(selector) {
        return selector === "[data-transaction-location]"
          ? [fixture.root]
          : [];
      },
    },
    windowOverrides: { mapkit: stub.mapkit },
  });

  harness.helpers.transactionLocations();
  await settleAsyncWork();

  assert.equal(stub.state.geocoderLookups.length, 0);
  assert.equal(stub.state.maps.length, 1);
  assert.equal(fixture.mapElement.hidden, false);
  assert.equal(fixture.root.dataset.mapkitState, "ready");
  const map = stub.state.maps[0];
  assert.equal(map.options.isRotationEnabled, false);
  assert.equal(map.options.isScrollEnabled, false);
  assert.equal(map.options.isZoomEnabled, false);
  assert.equal(map.options.showsMapTypeControl, false);
  assert.equal(map.options.showsPointsOfInterest, false);
  assert.equal(map.options.showsUserLocation, false);
  assert.equal(map.options.showsZoomControl, false);
  assert.equal(map.annotations[0].options.title, "Corner Market");
  assert.equal(
    map.annotations[0].options.accessibilityLabel,
    "Corner Market location",
  );

  stub.emit("error", { status: "Unauthorized" });
  assert.equal(map.destroyed, true);
  assert.equal(fixture.mapElement.hidden, true);
  assert.equal(fixture.root.dataset.mapkitState, "unavailable");
});

test("address-only locations geocode once while empty results keep the map hidden", async () => {
  const address = "123 Main St, San Francisco, CA 94105";
  const fixture = locationFixture({
    locationAddress: address,
    locationTitle: "Corner Market",
  });
  const stub = stubMapKit({
    geocoderResults: [
      { coordinate: { latitude: 37.789, longitude: -122.394 } },
    ],
  });
  const harness = await mapKitHarness({
    documentOverrides: {
      querySelectorAll() {
        return [fixture.root];
      },
    },
    windowOverrides: { mapkit: stub.mapkit },
  });

  harness.helpers.transactionLocations();
  await settleAsyncWork();
  assert.deepEqual(stub.state.geocoderLookups, [address]);
  assert.equal(stub.state.maps.length, 1);

  const noMatchFixture = locationFixture({
    locationAddress: address,
  });
  const noMatchStub = stubMapKit({ geocoderResults: [] });
  const noMatchHarness = await mapKitHarness({
    documentOverrides: {
      querySelectorAll() {
        return [noMatchFixture.root];
      },
    },
    windowOverrides: { mapkit: noMatchStub.mapkit },
  });
  noMatchHarness.helpers.transactionLocations();
  await settleAsyncWork();
  assert.equal(noMatchStub.state.maps.length, 0);
  assert.equal(noMatchFixture.mapElement.hidden, true);
  assert.equal(noMatchFixture.root.dataset.mapkitState, "unavailable");
});

test("missing location never loads MapKit, and close cancels late geocoding", async () => {
  const missingLocationFixture = locationFixture({});
  const missingLocationStub = stubMapKit();
  const missingLocationHarness = await mapKitHarness({
    documentOverrides: {
      querySelectorAll() {
        return [missingLocationFixture.root];
      },
    },
    windowOverrides: { mapkit: missingLocationStub.mapkit },
  });
  missingLocationHarness.helpers.transactionLocations();
  await settleAsyncWork();
  assert.equal(missingLocationStub.state.maps.length, 0);
  assert.equal(missingLocationFixture.mapElement.hidden, true);

  let finishLookup;
  const fixture = locationFixture({
    locationAddress: "123 Main St",
  });
  const stub = stubMapKit();
  stub.mapkit.Geocoder = class {
    lookup() {
      return new Promise((resolve) => {
        finishLookup = resolve;
      });
    }
  };
  const harness = await mapKitHarness({
    documentOverrides: {
      querySelectorAll() {
        return [fixture.root];
      },
    },
    windowOverrides: { mapkit: stub.mapkit },
  });
  harness.helpers.transactionLocations();
  await settleAsyncWork();
  fixture.listeners.get("close")();
  finishLookup([
    { coordinate: { latitude: 37.789, longitude: -122.394 } },
  ]);
  await settleAsyncWork();
  assert.equal(stub.state.maps.length, 0);
  assert.equal(fixture.mapElement.hidden, true);
});
