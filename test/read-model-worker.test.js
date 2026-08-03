import assert from "node:assert/strict";
import test from "node:test";

import { PgJobQueue } from "../app/db/jobQueue.js";
import { FinanceWorker } from "../app/worker/financeWorker.js";
import { startReadModelWarmSchedule } from "../app/worker/index.js";

function workerFixture({
  pending = false,
  cacheStatus = "ready",
  recoverable = false,
  requeueError = null,
  changedDuringWarm = false,
} = {}) {
  const events = [];
  let claimed = false;
  const queue = {
    async claim() {
      if (claimed) return null;
      claimed = true;
      return {
        id: "warm-job",
        type: "finance.warm_read_models",
        payload: {
          workspaceId: "shared",
          revision: "4",
          reason: "post-sync",
        },
      };
    },
    async hasPendingReadModelDependencies() {
      events.push("dependencies");
      return pending;
    },
    async complete() {
      events.push("complete");
    },
    async fail(_id, error) {
      events.push(`fail:${error.name}`);
    },
  };
  const readModelService = {
    status() {
      return cacheStatus;
    },
    async recoverCache() {
      events.push("probe");
      return recoverable;
    },
    async warmCanonicalModels(input) {
      events.push(`warm:${input.reason}`);
      return { revision: "4", changedDuringWarm };
    },
  };
  const readModelPublisher = {
    async queueWarm(reason, revision, options) {
      events.push({ reason, revision, options });
      if (requeueError) throw requeueError;
      return { id: "next-warm" };
    },
  };
  const worker = new FinanceWorker({
    queue,
    plaidSyncService: {},
    recurringService: {},
    insightService: {},
    readModelService,
    readModelPublisher,
  });
  return { events, worker };
}

test("warm jobs rebuild canonical models after dependencies settle", async () => {
  const { events, worker } = workerFixture();
  assert.equal(await worker.runOnce(), true);
  assert.deepEqual(events, [
    "dependencies",
    "warm:post-sync",
    "complete",
  ]);
});

test("warm jobs requeue behind active Plaid or derived work", async () => {
  const { events, worker } = workerFixture({ pending: true });
  assert.equal(await worker.runOnce(), true);
  assert.equal(events[0], "dependencies");
  assert.equal(events.at(-1), "complete");
  assert.equal(events[1].reason, "post-sync");
  assert.equal(events[1].revision, "4");
  assert.ok(events[1].options.runAt instanceof Date);
  assert.equal(events[1].options.strict, true);
});

test("degraded Redis fails the warm job before heavy models build", async () => {
  const { events, worker } = workerFixture({ cacheStatus: "degraded" });
  assert.equal(await worker.runOnce(), true);
  assert.deepEqual(events, [
    "probe",
    "fail:ReadModelCacheUnavailableError",
  ]);
});

test("a successful Redis probe resumes warming after degradation", async () => {
  const { events, worker } = workerFixture({
    cacheStatus: "degraded",
    recoverable: true,
  });
  assert.equal(await worker.runOnce(), true);
  assert.deepEqual(events, [
    "probe",
    "dependencies",
    "warm:post-sync",
    "complete",
  ]);
});

test("a failed dependency requeue fails the current warm job", async () => {
  const { events, worker } = workerFixture({
    pending: true,
    requeueError: new Error("queue unavailable"),
  });
  assert.equal(await worker.runOnce(), true);
  assert.equal(events[0], "dependencies");
  assert.equal(events[1].options.strict, true);
  assert.equal(events.at(-1), "fail:Error");
  assert.equal(events.includes("complete"), false);
});

test("a revision race queues its replacement strictly", async () => {
  const { events, worker } = workerFixture({ changedDuringWarm: true });
  assert.equal(await worker.runOnce(), true);
  assert.equal(events[2].reason, "revision-changed");
  assert.equal(events[2].revision, "4");
  assert.deepEqual(events[2].options, { strict: true });
  assert.equal(events.at(-1), "complete");
});

test("read-model warming runs at startup, six hours, and retryable rollover", async () => {
  const events = [];
  const intervals = [];
  const cleared = [];
  const rolloverTokens = ["utc-1:local-1", "utc-2:local-1"];
  let rolloverReads = 0;
  let rolloverAttempts = 0;
  const schedule = await startReadModelWarmSchedule({
    readModelService: {
      status() {
        return "ready";
      },
      async rolloverToken() {
        const index = Math.min(
          rolloverReads,
          rolloverTokens.length - 1,
        );
        rolloverReads += 1;
        return rolloverTokens[index];
      },
    },
    readModelPublisher: {
      async queueWarm(reason) {
        events.push(`warm:${reason}`);
      },
      async publishClockBoundary(reason, clockToken) {
        if (reason === "startup") {
          events.push(`publish:${reason}:${clockToken}`);
          return;
        }
        rolloverAttempts += 1;
        events.push(
          `publish:${reason}:${clockToken}:${rolloverAttempts}`,
        );
        if (rolloverAttempts === 1) throw new Error("Redis unavailable");
      },
    },
    setIntervalImpl(callback, delay) {
      const timer = { callback, delay, unref() {} };
      intervals.push(timer);
      return timer;
    },
    clearIntervalImpl(timer) {
      cleared.push(timer);
    },
  });

  assert.deepEqual(events, [
    "publish:startup:utc-1:local-1",
  ]);
  assert.deepEqual(
    intervals.map((timer) => timer.delay),
    [6 * 60 * 60_000, 60_000],
  );
  events.length = 0;
  await intervals[0].callback();
  await intervals[1].callback();
  await intervals[1].callback();
  await intervals[1].callback();
  assert.deepEqual(events, [
    "warm:six-hour",
    "publish:date-rollover:utc-2:local-1:1",
    "publish:date-rollover:utc-2:local-1:2",
  ]);
  schedule.close();
  assert.deepEqual(cleared, intervals);
});

test("six-hour warming retries quickly with bounded backoff", async () => {
  const intervals = [];
  const timeouts = [];
  const attempts = [];
  let failuresRemaining = 2;
  const schedule = await startReadModelWarmSchedule({
    readModelService: {
      status() {
        return "ready";
      },
      async rolloverToken() {
        return "utc-1:local-1";
      },
    },
    readModelPublisher: {
      async publishClockBoundary() {},
      async queueWarm(reason, revision, options) {
        attempts.push({ reason, revision, options });
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error("queue unavailable");
        }
      },
    },
    setIntervalImpl(callback, delay) {
      const timer = { callback, delay, unref() {} };
      intervals.push(timer);
      return timer;
    },
    clearIntervalImpl() {},
    setTimeoutImpl(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timeouts.push(timer);
      return timer;
    },
    clearTimeoutImpl() {},
  });

  await intervals[0].callback();
  assert.equal(timeouts[0].delay, 15_000);
  await timeouts[0].callback();
  assert.equal(timeouts[1].delay, 60_000);
  await timeouts[1].callback();
  assert.deepEqual(
    attempts.map(({ reason, revision, options }) => ({
      reason,
      revision,
      strict: options.strict,
    })),
    [
      { reason: "six-hour", revision: null, strict: true },
      { reason: "six-hour", revision: null, strict: true },
      { reason: "six-hour", revision: null, strict: true },
    ],
  );
  assert.equal(timeouts.length, 2);
  schedule.close();
});

test("terminal crashed Plaid jobs safely settle orphaned cache fences", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized === "BEGIN" || normalized === "COMMIT") {
        return { rows: [] };
      }
      if (normalized.startsWith("SELECT * FROM jobs")) {
        return {
          rowCount: 1,
          rows: [{
            id: "stale-plaid",
            job_type: "plaid.sync_item",
            payload: { itemId: "connection-a" },
            dedupe_key: "connection-a",
            attempts: 5,
            max_attempts: 5,
          }],
        };
      }
      if (normalized.startsWith("SELECT workspace_id, connection_id")) {
        return {
          rows: [{
            workspace_id: "shared",
            connection_id: "connection-a",
          }],
        };
      }
      if (normalized.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ acquired: true }] };
      }
      if (normalized.startsWith("WITH settled_sync AS")) {
        return { rows: [{ revision: "12" }] };
      }
      if (normalized.startsWith("INSERT INTO jobs")) {
        return {
          rows: [{
            id: "warm-job",
            job_type: params[1],
            payload: JSON.parse(params[2]),
            dedupe_key: params[3],
            status: "queued",
            attempts: 0,
            max_attempts: params[5],
          }],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  const queue = new PgJobQueue({
    async connect() {
      return client;
    },
  });

  assert.equal(await queue.recoverStale({ olderThanMs: 1 }), 1);
  const advisoryLock = calls.find((call) =>
    call.sql.includes("pg_try_advisory_xact_lock"),
  );
  assert.deepEqual(advisoryLock.params, [
    "money:plaid-sync:connection-a",
  ]);
  const warmInsert = calls.find(
    (call) =>
      call.sql.startsWith("INSERT INTO jobs") &&
      call.params[1] === "finance.warm_read_models",
  );
  assert.deepEqual(JSON.parse(warmInsert.params[2]), {
    workspaceId: "shared",
    revision: "12",
    reason: "plaid.sync-abandoned",
  });
  assert.equal(warmInsert.params[5], 100);
  assert.ok(
    calls.some((call) =>
      call.sql.includes("DELETE FROM workspace_read_model_active_syncs"),
    ),
  );
});

test("stale recovery never clears or terminalizes a live Plaid fence", async () => {
  let published = false;
  let terminalized = false;
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized === "BEGIN" || normalized === "COMMIT") {
        return { rows: [] };
      }
      if (normalized.startsWith("SELECT * FROM jobs")) {
        return {
          rowCount: 1,
          rows: [{
            id: "live-plaid",
            job_type: "plaid.sync_item",
            payload: { itemId: "connection-a" },
            attempts: 5,
            max_attempts: 5,
          }],
        };
      }
      if (normalized.startsWith("SELECT workspace_id, connection_id")) {
        return {
          rows: [{
            workspace_id: "shared",
            connection_id: "connection-a",
          }],
        };
      }
      if (normalized.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ acquired: false }] };
      }
      if (normalized.startsWith("WITH settled_sync AS")) {
        published = true;
      }
      if (
        normalized.startsWith("UPDATE jobs") &&
        normalized.includes("WORKER_LEASE_EXPIRED")
      ) {
        terminalized = true;
      }
      return { rows: [] };
    },
    release() {},
  };
  const queue = new PgJobQueue({
    async connect() {
      return client;
    },
  });

  assert.equal(await queue.recoverStale({ olderThanMs: 1 }), 1);
  assert.equal(published, false);
  assert.equal(terminalized, false);
});

test("stale recovery leaves a fence to its queued Plaid successor", async () => {
  let advisoryLockAttempted = false;
  let published = false;
  let terminalized = false;
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized === "BEGIN" || normalized === "COMMIT") {
        return { rows: [] };
      }
      if (normalized.startsWith("SELECT * FROM jobs")) {
        return {
          rowCount: 1,
          rows: [{
            id: "abandoned-plaid",
            job_type: "plaid.sync_item",
            payload: { itemId: "connection-a" },
            attempts: 5,
            max_attempts: 5,
          }],
        };
      }
      if (normalized.startsWith("SELECT workspace_id, connection_id")) {
        return {
          rows: [{
            workspace_id: "shared",
            connection_id: "connection-a",
          }],
        };
      }
      if (normalized.includes("FROM jobs successor")) {
        return { rows: [{ pending: true }] };
      }
      if (normalized.includes("pg_try_advisory_xact_lock")) {
        advisoryLockAttempted = true;
      }
      if (normalized.startsWith("WITH settled_sync AS")) {
        published = true;
      }
      if (
        normalized.startsWith("UPDATE jobs") &&
        normalized.includes("WORKER_LEASE_EXPIRED")
      ) {
        terminalized = true;
      }
      return { rows: [] };
    },
    release() {},
  };
  const queue = new PgJobQueue({
    async connect() {
      return client;
    },
  });

  assert.equal(await queue.recoverStale({ olderThanMs: 1 }), 1);
  assert.equal(advisoryLockAttempted, false);
  assert.equal(published, false);
  assert.equal(terminalized, true);
});

test("terminal Plaid failure settles its orphaned fence atomically", async () => {
  const calls = [];
  const terminalJob = {
    id: "terminal-plaid",
    job_type: "plaid.sync_item",
    payload: { itemId: "connection-a" },
    dedupe_key: "connection-a",
    status: "running",
    attempts: 5,
    max_attempts: 5,
  };
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (
        normalized === "BEGIN" ||
        normalized === "COMMIT" ||
        normalized === "ROLLBACK"
      ) {
        return { rows: [] };
      }
      if (normalized.startsWith("SELECT * FROM jobs")) {
        return { rows: [terminalJob] };
      }
      if (normalized.startsWith("SELECT workspace_id, connection_id")) {
        return {
          rows: [{
            workspace_id: "shared",
            connection_id: "connection-a",
          }],
        };
      }
      if (normalized.includes("FROM jobs successor")) {
        return { rows: [{ pending: false }] };
      }
      if (normalized.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ acquired: true }] };
      }
      if (normalized.startsWith("WITH settled_sync AS")) {
        return { rows: [{ revision: "12" }] };
      }
      if (normalized.startsWith("INSERT INTO jobs")) {
        return {
          rows: [{
            id: "warm-job",
            job_type: params[1],
            payload: JSON.parse(params[2]),
            dedupe_key: params[3],
            status: "queued",
            attempts: 0,
            max_attempts: params[5],
          }],
        };
      }
      if (
        normalized.startsWith("UPDATE jobs") &&
        normalized.includes("SET status = 'failed'")
      ) {
        return {
          rows: [{
            ...terminalJob,
            status: "failed",
            last_error: params[1],
          }],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  const queue = new PgJobQueue({
    async connect() {
      return client;
    },
  });

  const result = await queue.fail(terminalJob.id, new Error("failed"));

  assert.equal(result.status, "failed");
  assert.ok(
    calls.some((call) =>
      call.sql.includes("DELETE FROM workspace_read_model_active_syncs"),
    ),
  );
  const warmInsert = calls.find(
    (call) =>
      call.sql.startsWith("INSERT INTO jobs") &&
      call.params[1] === "finance.warm_read_models",
  );
  assert.deepEqual(JSON.parse(warmInsert.params[2]), {
    workspaceId: "shared",
    revision: "12",
    reason: "plaid.sync-abandoned",
  });
  assert.equal(warmInsert.params[5], 100);
  assert.ok(
    calls.findIndex((call) => call.sql.startsWith("WITH settled_sync AS")) <
      calls.findIndex(
        (call) =>
          call.sql.startsWith("UPDATE jobs") &&
          call.sql.includes("SET status = 'failed'"),
      ),
  );
});
