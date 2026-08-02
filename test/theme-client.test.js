import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const themeScriptPath = path.resolve("app/public/js/theme.js");

class FakeTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(name, listener, options = {}) {
    const listeners = this.listeners.get(name) || [];
    listeners.push({ listener, once: Boolean(options?.once) });
    this.listeners.set(name, listeners);
  }

  removeEventListener(name, listener) {
    this.listeners.set(
      name,
      (this.listeners.get(name) || []).filter(
        (entry) => entry.listener !== listener,
      ),
    );
  }

  dispatchEvent(event) {
    const entries = [...(this.listeners.get(event.type) || [])];
    for (const entry of entries) {
      entry.listener.call(this, event);
      if (entry.once) this.removeEventListener(event.type, entry.listener);
    }
    return true;
  }
}

class FakeMeta {
  constructor(content = "", media = "") {
    this.content = content;
    this.media = media;
  }

  setAttribute(name, value) {
    if (name === "content") this.content = value;
    if (name === "media") this.media = value;
  }

  removeAttribute(name) {
    if (name === "media") this.media = "";
  }
}

class FakeOption extends FakeTarget {
  constructor(value) {
    super();
    this.value = value;
    this.checked = false;
    this.disabled = false;
    this.focusCalls = [];
  }

  focus(options) {
    this.focusCalls.push(options);
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function themeHarness({
  appearance = "system",
  fetchImpl = async () => ({
    ok: true,
    async json() {
      return { appearance };
    },
  }),
  systemDark = false,
  withPicker = true,
  documentHidden = false,
} = {}) {
  let now = 1_000_000;
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  const source = await readFile(themeScriptPath, "utf8");
  const root = {
    dataset: { appearance },
    style: {},
  };
  const colorScheme = new FakeMeta("light");
  const themeColors = [
    new FakeMeta("#f7f7f7", "(prefers-color-scheme: light)"),
    new FakeMeta("#111111", "(prefers-color-scheme: dark)"),
  ];
  const csrf = new FakeMeta("csrf-value");
  const status = {
    attributes: new Map(),
    hidden: true,
    textContent: "",
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
  };
  const options = ["system", "light", "dark"].map(
    (value) => new FakeOption(value),
  );
  const picker = {
    attributes: new Map(),
    querySelector(selector) {
      return selector === "[data-appearance-status]" ? status : null;
    },
    querySelectorAll(selector) {
      return selector === "[data-appearance-option]" ? options : [];
    },
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
  };
  const document = new FakeTarget();
  Object.assign(document, {
    body: {},
    documentElement: root,
    hidden: documentHidden,
    readyState: "complete",
    querySelector(selector) {
      if (selector === 'meta[name="color-scheme"]') return colorScheme;
      if (selector === 'meta[name="csrf-token"]') return csrf;
      if (selector === "[data-appearance-picker]") {
        return withPicker ? picker : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector === 'meta[name="theme-color"]' ? themeColors : [];
    },
  });
  const systemPreference = new FakeTarget();
  systemPreference.matches = systemDark;
  const channels = [];
  class FakeBroadcastChannel extends FakeTarget {
    constructor(name) {
      super();
      this.name = name;
      this.messages = [];
      channels.push(this);
    }

    postMessage(message) {
      this.messages.push(message);
    }
  }
  class FakeCustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  }
  const window = new FakeTarget();
  Object.assign(window, {
    BroadcastChannel: FakeBroadcastChannel,
    fetch: fetchImpl,
    getComputedStyle(target) {
      assert.equal(target, document.body);
      return {
        backgroundColor:
          root.dataset.resolvedTheme === "dark"
            ? "rgb(17, 17, 17)"
            : "rgb(247, 247, 247)",
      };
    },
    matchMedia(query) {
      assert.equal(query, "(prefers-color-scheme: dark)");
      return systemPreference;
    },
  });
  const context = vm.createContext({
    CustomEvent: FakeCustomEvent,
    Date: FakeDate,
    Error,
    JSON,
    Object,
    Set,
    TypeError,
    console,
    document,
    fetch: fetchImpl,
    window,
  });
  vm.runInContext(source, context, { filename: themeScriptPath });
  return {
    advanceTime(milliseconds) {
      now += milliseconds;
    },
    channels,
    colorScheme,
    csrf,
    document,
    options,
    picker,
    root,
    status,
    systemPreference,
    themeColors,
    window,
  };
}

test("system appearance resolves immediately and follows live OS changes", async () => {
  const harness = await themeHarness({ systemDark: true });
  const events = [];
  harness.window.addEventListener("money:themechange", (event) =>
    events.push(event.detail),
  );

  assert.equal(harness.root.dataset.appearance, "system");
  assert.equal(harness.root.dataset.resolvedTheme, "dark");
  assert.equal(harness.root.style.colorScheme, "dark");
  assert.equal(harness.colorScheme.content, "dark");
  assert.ok(
    harness.themeColors.every(
      (meta) => meta.content === "rgb(17, 17, 17)" && meta.media === "",
    ),
  );
  assert.equal(harness.window.moneyAppearance.resolved, "dark");

  harness.systemPreference.matches = false;
  harness.systemPreference.dispatchEvent({ type: "change" });

  assert.equal(harness.root.dataset.resolvedTheme, "light");
  assert.ok(
    harness.themeColors.every(
      (meta) => meta.content === "rgb(247, 247, 247)",
    ),
  );
  assert.equal(events.at(-1).appearance, "system");
  assert.equal(events.at(-1).resolvedTheme, "light");
});

test("appearance picker saves optimistically, protects PUT, and broadcasts success", async () => {
  const calls = [];
  let finishRequest;
  const fetchImpl = (url, options) => {
    calls.push({ url, options });
    return new Promise((resolve) => {
      finishRequest = resolve;
    });
  };
  const harness = await themeHarness({ fetchImpl });
  const dark = harness.options.find((option) => option.value === "dark");
  dark.checked = true;
  dark.dispatchEvent({ type: "change" });

  assert.equal(harness.root.dataset.appearance, "dark");
  assert.ok(harness.options.every((option) => option.disabled));
  assert.equal(harness.picker.attributes.get("aria-busy"), "true");
  assert.equal(calls[0].url, "/api/v1/me/appearance");
  assert.equal(calls[0].options.method, "PUT");
  assert.equal(calls[0].options.keepalive, true);
  assert.equal(calls[0].options.headers["X-CSRF-Token"], "csrf-value");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    appearance: "dark",
  });

  finishRequest({
    ok: true,
    async json() {
      return { updated: true, appearance: "dark" };
    },
  });
  await flush();

  assert.ok(harness.options.every((option) => !option.disabled));
  assert.equal(harness.picker.attributes.has("aria-busy"), false);
  assert.equal(harness.channels[0].messages.length, 1);
  assert.equal(harness.channels[0].messages[0].appearance, "dark");
  assert.equal(harness.status.hidden, true);
});

test("a failed save restores the committed theme and reports an inline error", async () => {
  const harness = await themeHarness({
    appearance: "light",
    fetchImpl: async () => ({ ok: false }),
  });
  const dark = harness.options.find((option) => option.value === "dark");
  dark.checked = true;
  dark.dispatchEvent({ type: "change" });
  assert.equal(harness.root.dataset.appearance, "dark");

  await flush();

  assert.equal(harness.root.dataset.appearance, "light");
  assert.equal(
    harness.options.find((option) => option.value === "light").checked,
    true,
  );
  assert.equal(harness.status.hidden, false);
  assert.match(harness.status.textContent, /couldn’t be saved/);
});

test("broadcast treats the account GET as authoritative instead of trusting its payload", async () => {
  const calls = [];
  let remoteAppearance = "light";
  const harness = await themeHarness({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return { appearance: remoteAppearance };
        },
      };
    },
  });

  harness.channels[0].dispatchEvent({
    type: "message",
    data: { appearance: "dark" },
  });
  assert.equal(harness.window.moneyAppearance.selected, "system");

  await flush();
  assert.equal(harness.window.moneyAppearance.selected, "light");
  assert.equal(calls[0].options.method, "GET");

  remoteAppearance = "system";
  await harness.window.moneyAppearance.refresh();
  assert.equal(harness.window.moneyAppearance.selected, "system");
  assert.equal(calls[1].options.method, "GET");

  const source = await readFile(themeScriptPath, "utf8");
  assert.doesNotMatch(source, /localStorage/);
});

test("a broadcast received during a save reconciles after the write settles", async () => {
  const calls = [];
  let finishWrite;
  const harness = await themeHarness({
    fetchImpl: (url, options) => {
      calls.push({ url, options });
      if (options.method === "PUT") {
        return new Promise((resolve) => {
          finishWrite = resolve;
        });
      }
      return Promise.resolve({
        ok: true,
        async json() {
          return { appearance: "light" };
        },
      });
    },
  });
  const dark = harness.options.find((option) => option.value === "dark");
  dark.checked = true;
  dark.dispatchEvent({ type: "change" });

  harness.channels[0].dispatchEvent({
    type: "message",
    data: { appearance: "system" },
  });
  assert.deepEqual(calls.map(({ options }) => options.method), ["PUT"]);

  finishWrite({
    ok: true,
    async json() {
      return { updated: true, appearance: "dark" };
    },
  });
  await flush();
  await flush();

  assert.deepEqual(calls.map(({ options }) => options.method), [
    "PUT",
    "GET",
  ]);
  assert.equal(harness.window.moneyAppearance.selected, "light");
});

test("an older reconciliation cannot overwrite a later successful save", async () => {
  const calls = [];
  let finishInitialRead;
  let finishWrite;
  let finishQueuedRead;
  let readCount = 0;
  const harness = await themeHarness({
    fetchImpl: (url, options) => {
      calls.push({ url, options });
      if (options.method === "PUT") {
        return new Promise((resolve) => {
          finishWrite = resolve;
        });
      }
      readCount += 1;
      return new Promise((resolve) => {
        if (readCount === 1) finishInitialRead = resolve;
        else finishQueuedRead = resolve;
      });
    },
  });

  void harness.window.moneyAppearance.refresh();
  const dark = harness.options.find((option) => option.value === "dark");
  dark.checked = true;
  dark.dispatchEvent({ type: "change" });
  assert.deepEqual(calls.map(({ options }) => options.method), [
    "GET",
    "PUT",
  ]);

  finishWrite({
    ok: true,
    async json() {
      return { updated: true, appearance: "dark" };
    },
  });
  await flush();
  assert.equal(harness.window.moneyAppearance.selected, "dark");

  finishInitialRead({
    ok: true,
    async json() {
      return { appearance: "light" };
    },
  });
  await flush();
  assert.equal(harness.window.moneyAppearance.selected, "dark");
  assert.deepEqual(calls.map(({ options }) => options.method), [
    "GET",
    "PUT",
    "GET",
  ]);

  finishQueuedRead({
    ok: true,
    async json() {
      return { appearance: "dark" };
    },
  });
  await flush();
  assert.equal(harness.window.moneyAppearance.selected, "dark");
});

test("a broadcast during an in-flight read queues a fresh authoritative read", async () => {
  const reads = [];
  const harness = await themeHarness({
    fetchImpl: (_url, options) => {
      assert.equal(options.method, "GET");
      return new Promise((resolve) => reads.push(resolve));
    },
  });

  void harness.window.moneyAppearance.refresh();
  harness.channels[0].dispatchEvent({
    type: "message",
    data: { appearance: "dark" },
  });
  assert.equal(reads.length, 1);

  reads[0]({
    ok: true,
    async json() {
      return { appearance: "light" };
    },
  });
  await flush();
  assert.equal(harness.window.moneyAppearance.selected, "system");
  assert.equal(reads.length, 2);

  reads[1]({
    ok: true,
    async json() {
      return { appearance: "dark" };
    },
  });
  await flush();
  assert.equal(harness.window.moneyAppearance.selected, "dark");
});

test("keyboard saves restore radio focus while pointer saves do not steal it", async () => {
  const saveSelectedAppearance = async (_url, options) => ({
    ok: true,
    async json() {
      return {
        updated: true,
        appearance: JSON.parse(options.body).appearance,
      };
    },
  });
  const keyboardHarness = await themeHarness({
    fetchImpl: saveSelectedAppearance,
  });
  const keyboardDark = keyboardHarness.options.find(
    (option) => option.value === "dark",
  );
  keyboardDark.dispatchEvent({ type: "keydown", key: "ArrowRight" });
  keyboardDark.checked = true;
  keyboardDark.dispatchEvent({ type: "change" });
  await flush();

  assert.equal(keyboardDark.focusCalls.length, 1);
  assert.equal(keyboardDark.focusCalls[0].preventScroll, true);

  const pointerHarness = await themeHarness({
    fetchImpl: saveSelectedAppearance,
  });
  const pointerDark = pointerHarness.options.find(
    (option) => option.value === "dark",
  );
  pointerDark.dispatchEvent({ type: "keydown", key: " " });
  pointerHarness.window.dispatchEvent({ type: "pointerdown" });
  pointerDark.checked = true;
  pointerDark.dispatchEvent({ type: "change" });
  await flush();

  assert.equal(pointerDark.focusCalls.length, 0);
});

test("bfcache restores and stale visibility changes recheck the account", async () => {
  let remoteAppearance = "dark";
  let reads = 0;
  const harness = await themeHarness({
    appearance: "light",
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, "GET");
      reads += 1;
      return {
        ok: true,
        async json() {
          return { appearance: remoteAppearance };
        },
      };
    },
  });

  harness.window.dispatchEvent({ type: "pageshow", persisted: true });
  await flush();
  assert.equal(reads, 1);
  assert.equal(harness.window.moneyAppearance.selected, "dark");

  remoteAppearance = "system";
  harness.document.hidden = true;
  harness.document.dispatchEvent({ type: "visibilitychange" });
  harness.advanceTime(29_999);
  harness.document.hidden = false;
  harness.document.dispatchEvent({ type: "visibilitychange" });
  await flush();
  assert.equal(reads, 1);

  harness.document.hidden = true;
  harness.document.dispatchEvent({ type: "visibilitychange" });
  harness.advanceTime(30_000);
  harness.document.hidden = false;
  harness.document.dispatchEvent({ type: "visibilitychange" });
  await flush();
  assert.equal(reads, 2);
  assert.equal(harness.window.moneyAppearance.selected, "system");
});

test("a page opened in the background tracks staleness from initialization", async () => {
  let reads = 0;
  const harness = await themeHarness({
    appearance: "light",
    documentHidden: true,
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, "GET");
      reads += 1;
      return {
        ok: true,
        async json() {
          return { appearance: "dark" };
        },
      };
    },
  });

  harness.advanceTime(30_000);
  harness.document.hidden = false;
  harness.document.dispatchEvent({ type: "visibilitychange" });
  await flush();

  assert.equal(reads, 1);
  assert.equal(harness.window.moneyAppearance.selected, "dark");
});

test("printing emits a light theme and restores the selected resolution afterward", async () => {
  const harness = await themeHarness({ appearance: "dark" });
  const events = [];
  harness.window.addEventListener("money:themechange", (event) => {
    events.push(event.detail);
  });

  harness.window.dispatchEvent({ type: "beforeprint" });
  assert.equal(harness.window.moneyAppearance.selected, "dark");
  assert.equal(harness.window.moneyAppearance.resolved, "light");
  assert.equal(harness.root.dataset.resolvedTheme, "light");
  assert.equal(events.at(-1).appearance, "dark");
  assert.equal(events.at(-1).resolvedTheme, "light");

  harness.window.dispatchEvent({ type: "afterprint" });
  assert.equal(harness.window.moneyAppearance.selected, "dark");
  assert.equal(harness.window.moneyAppearance.resolved, "dark");
  assert.equal(harness.root.dataset.resolvedTheme, "dark");
  assert.equal(events.at(-1).appearance, "dark");
  assert.equal(events.at(-1).resolvedTheme, "dark");
});
