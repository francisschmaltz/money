import assert from "node:assert/strict";
import test from "node:test";

import {
  READ_MODEL_CACHE_COMMAND_TIMEOUT_MS,
  READ_MODEL_CACHE_MAX_ENTRY_BYTES,
  READ_MODEL_CACHE_SCHEMA,
  READ_MODEL_CACHE_TTL_SECONDS,
  createReadModelCache,
} from "../app/cache/readModelCache.js";
import {
  READ_MODEL_SLOTS,
  readModelCacheKey,
} from "../app/cache/readModelPolicy.js";

const DASHBOARD_KEY = readModelCacheKey({
  workspaceId: "shared",
  slot: READ_MODEL_SLOTS.DASHBOARD_1M,
  nodeEnvironment: "test",
});
const PLAN_KEY = readModelCacheKey({
  workspaceId: "shared",
  slot: READ_MODEL_SLOTS.PLAN_BUDGET_PREVIOUS,
  nodeEnvironment: "test",
});
const TRANSACTIONS_KEY = readModelCacheKey({
  workspaceId: "shared",
  slot: READ_MODEL_SLOTS.TRANSACTIONS_CURRENT_MONTH_BASE,
  nodeEnvironment: "test",
});

class FakeRedis {
  constructor() {
    this.isReady = true;
    this.values = new Map();
    this.getCalls = [];
    this.setCalls = [];
    this.delCalls = [];
    this.pingCalls = 0;
    this.getError = null;
    this.setError = null;
    this.pingError = null;
  }

  async get(key) {
    this.getCalls.push(key);
    if (this.getError) throw this.getError;
    return this.values.get(key) ?? null;
  }

  async set(key, value, options) {
    this.setCalls.push({ key, value, options });
    if (this.setError) throw this.setError;
    this.values.set(key, value);
    return "OK";
  }

  async del(key) {
    this.delCalls.push(key);
    this.values.delete(key);
    return 1;
  }

  async ping() {
    this.pingCalls += 1;
    if (this.pingError) throw this.pingError;
    return "PONG";
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("off mode is disabled, avoids Redis, and still coalesces active loads", async () => {
  const client = new FakeRedis();
  const cache = createReadModelCache({ client, mode: "off" });
  const gate = deferred();
  let loads = 0;
  const load = async () => {
    loads += 1;
    await gate.promise;
    return { total: 42 };
  };

  const first = cache.getOrLoad(DASHBOARD_KEY, { load });
  const second = cache.getOrLoad(DASHBOARD_KEY, { load });
  await Promise.resolve();
  assert.equal(loads, 1);
  gate.resolve();

  assert.deepEqual(await Promise.all([first, second]), [
    { total: 42 },
    { total: 42 },
  ]);
  assert.equal(cache.status(), "disabled");
  assert.deepEqual(await cache.get(DASHBOARD_KEY, { revision: "1" }), {
    hit: false,
  });
  assert.equal(
    await cache.set(DASHBOARD_KEY, { total: 42 }, { revision: "1" }),
    false,
  );
  assert.equal(client.getCalls.length, 0);
  assert.equal(client.setCalls.length, 0);
});

test("coalesced cache builds are reported as misses, never Redis hits", async () => {
  const client = new FakeRedis();
  const cache = createReadModelCache({ client, mode: "serve" });
  const gate = deferred();
  const outcomes = [];
  const load = async () => {
    await gate.promise;
    return { total: 42 };
  };
  const options = () => ({
    getRevision: async () => "1",
    load,
    onOutcome: (outcome) => outcomes.push(outcome),
  });

  const first = cache.getOrLoad(DASHBOARD_KEY, options());
  const second = cache.getOrLoad(DASHBOARD_KEY, options());
  await Promise.resolve();
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(outcomes, ["miss", "miss"]);
});

test("warm mode writes the stable envelope for 12 hours but never serves it", async () => {
  const client = new FakeRedis();
  const now = new Date("2026-08-03T12:00:00.000Z");
  const cache = createReadModelCache({
    client,
    mode: "warm",
    now: () => now,
  });
  let loads = 0;
  const load = async () => ({ load: ++loads });

  assert.deepEqual(
    await cache.getOrLoad(PLAN_KEY, {
      getRevision: async () => "7",
      load,
    }),
    { load: 1 },
  );
  assert.equal(cache.status(), "warming");
  assert.equal(client.getCalls.length, 0);
  assert.equal(client.setCalls.length, 1);
  assert.deepEqual(client.setCalls[0].options, {
    EX: READ_MODEL_CACHE_TTL_SECONDS,
  });
  assert.equal(
    client.setCalls[0].key,
    PLAN_KEY,
  );
  assert.deepEqual(JSON.parse(client.setCalls[0].value), {
    schema: READ_MODEL_CACHE_SCHEMA,
    revision: "7",
    generated_at: now.toISOString(),
    payload: { load: 1 },
  });

  assert.deepEqual(
    await cache.getOrLoad(PLAN_KEY, {
      getRevision: async () => "7",
      load,
    }),
    { load: 2 },
  );
  assert.equal(client.getCalls.length, 0);
  assert.equal(client.setCalls.length, 2);
});

test("serve mode returns only a valid envelope matching the live revision", async () => {
  const client = new FakeRedis();
  const cache = createReadModelCache({ client, mode: "serve" });
  await cache.set(DASHBOARD_KEY, { total: 42 }, { revision: 9n });

  assert.deepEqual(await cache.get(DASHBOARD_KEY, { revision: "9" }), {
    hit: true,
    payload: { total: 42 },
  });
  assert.deepEqual(await cache.get(DASHBOARD_KEY, { revision: "10" }), {
    hit: false,
  });

  let loads = 0;
  let revisionReads = 0;
  assert.deepEqual(
    await cache.getOrLoad(DASHBOARD_KEY, {
      getRevision: async () => {
        revisionReads += 1;
        return "9";
      },
      load: async () => {
        loads += 1;
        return { total: 99 };
      },
    }),
    { total: 42 },
  );
  assert.equal(loads, 0);
  assert.equal(revisionReads, 1);
  assert.equal(cache.status(), "ready");
});

test("getOrLoad retries the loader once when the revision changes", async () => {
  const client = new FakeRedis();
  const cache = createReadModelCache({ client, mode: "serve" });
  const revisions = ["1", "2", "2"];
  let loads = 0;

  const result = await cache.getOrLoad(TRANSACTIONS_KEY, {
    getRevision: async () => revisions.shift() ?? "2",
    load: async () => ({ load: ++loads }),
  });

  assert.deepEqual(result, { load: 2 });
  assert.equal(loads, 2);
  assert.equal(client.setCalls.length, 1);
  assert.equal(JSON.parse(client.setCalls[0].value).revision, "2");
  assert.deepEqual(JSON.parse(client.setCalls[0].value).payload, { load: 2 });
});

test("a second revision race returns live data without caching an uncertain snapshot", async () => {
  const client = new FakeRedis();
  const cache = createReadModelCache({ client, mode: "serve" });
  const revisions = ["1", "2", "3"];
  let loads = 0;

  const result = await cache.getOrLoad(DASHBOARD_KEY, {
    getRevision: async () => revisions.shift() ?? "3",
    load: async () => ({ load: ++loads }),
  });

  assert.deepEqual(result, { load: 2 });
  assert.equal(loads, 2);
  assert.equal(client.setCalls.length, 0);
});

test("force rebuilds and replaces a valid served entry", async () => {
  const client = new FakeRedis();
  const cache = createReadModelCache({ client, mode: "serve" });
  await cache.set("money:test:v1:workspace:shared:page:dashboard:1m", { load: 1 }, {
    revision: "4",
  });
  let loads = 1;

  const result = await cache.getOrLoad(
    "money:test:v1:workspace:shared:page:dashboard:1m",
    {
      getRevision: async () => "4",
      load: async () => ({ load: ++loads }),
      force: true,
    },
  );

  assert.deepEqual(result, { load: 2 });
  assert.equal(client.getCalls.length, 0);
  assert.deepEqual(
    JSON.parse(client.setCalls.at(-1).value).payload,
    { load: 2 },
  );
});

test("corrupt and oversized stored values are misses and are discarded", async () => {
  const client = new FakeRedis();
  const cache = createReadModelCache({ client, mode: "serve" });
  const key = DASHBOARD_KEY;

  client.values.set(key, "{broken");
  assert.deepEqual(await cache.get(DASHBOARD_KEY, { revision: "1" }), {
    hit: false,
  });
  assert.equal(cache.status(), "ready");
  assert.deepEqual(client.delCalls, [key]);

  client.values.set(key, "x".repeat(READ_MODEL_CACHE_MAX_ENTRY_BYTES + 1));
  assert.deepEqual(await cache.get(DASHBOARD_KEY, { revision: "1" }), {
    hit: false,
  });
  assert.deepEqual(client.delCalls, [key, key]);
});

test("oversized writes and Redis errors fail open without hiding source data", async () => {
  const client = new FakeRedis();
  const cache = createReadModelCache({ client, mode: "serve" });
  assert.equal(
    await cache.set(
      DASHBOARD_KEY,
      { value: "x".repeat(READ_MODEL_CACHE_MAX_ENTRY_BYTES) },
      { revision: "1" },
    ),
    false,
  );
  assert.equal(cache.status(), "ready");

  client.getError = new Error("Redis unavailable with sensitive details");
  client.setError = new Error("Redis unavailable with sensitive details");
  let loads = 0;
  assert.deepEqual(
    await cache.getOrLoad(DASHBOARD_KEY, {
      getRevision: async () => "1",
      load: async () => ({ fresh: ++loads }),
    }),
    { fresh: 1 },
  );
  assert.equal(loads, 1);
  assert.equal(cache.status(), "degraded");

  client.getError = null;
  client.setError = null;
  assert.equal(
    await cache.set(DASHBOARD_KEY, { fresh: true }, { revision: "1" }),
    true,
  );
  assert.equal(cache.status(), "ready");
});

test("Redis commands have a hard deadline and fall through", async () => {
  const never = new Promise(() => {});
  const cache = createReadModelCache({
    mode: "serve",
    commandTimeoutMs: 5,
    client: {
      isReady: true,
      get() {
        return never;
      },
      set() {
        return never;
      },
    },
  });
  const started = performance.now();
  assert.deepEqual(await cache.get(DASHBOARD_KEY, { revision: "1" }), {
    hit: false,
  });
  assert.equal(
    await cache.set(DASHBOARD_KEY, { total: 42 }, { revision: "1" }),
    false,
  );
  assert.ok(performance.now() - started < 100);
  assert.equal(cache.status(), "degraded");
  assert.ok(cache.failureGeneration() >= 2);
  assert.equal(READ_MODEL_CACHE_COMMAND_TIMEOUT_MS, 150);
});

test("a lightweight probe recovers degraded Redis before warming", async () => {
  const client = new FakeRedis();
  const cache = createReadModelCache({ client, mode: "serve" });
  client.getError = new Error("Redis unavailable");

  assert.deepEqual(await cache.get(DASHBOARD_KEY, { revision: "1" }), {
    hit: false,
  });
  assert.equal(cache.status(), "degraded");

  client.getError = null;
  assert.equal(await cache.probe(), true);
  assert.equal(client.pingCalls, 1);
  assert.equal(cache.status(), "ready");

  client.pingError = new Error("Redis unavailable again");
  assert.equal(await cache.probe(), false);
  assert.equal(client.pingCalls, 2);
  assert.equal(cache.status(), "degraded");
});

test("missing clients and invalid revisions bypass caching safely", async () => {
  const cache = createReadModelCache({ mode: "serve" });
  let loads = 0;
  const value = await cache.getOrLoad(DASHBOARD_KEY, {
    getRevision: async () => null,
    load: async () => ({ load: ++loads }),
  });

  assert.deepEqual(value, { load: 1 });
  assert.equal(cache.status(), "degraded");
  assert.throws(
    () => createReadModelCache({ mode: "sometimes" }),
    /off, warm, or serve/,
  );
});

test("invalid keys bypass cache and single-flight instead of sharing unrelated data", async () => {
  const cache = createReadModelCache({ mode: "off" });
  const gate = deferred();
  let loads = 0;
  const load = async () => {
    const value = ++loads;
    await gate.promise;
    return value;
  };

  const first = cache.getOrLoad(null, { load });
  const second = cache.getOrLoad(null, { load });
  await Promise.resolve();
  assert.equal(loads, 2);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
});
