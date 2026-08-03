import assert from "node:assert/strict";
import test from "node:test";

import { PgFinanceRepository } from "../app/db/financeRepository.js";
import { createReadModelPublisher } from "../app/cache/readModelRuntime.js";

test("finance repository transactions reuse one client for nested mutations", async () => {
  const statements = [];
  let connections = 0;
  const client = {
    async query(sql) {
      statements.push(String(sql));
      return { rows: [] };
    },
    release() {
      statements.push("RELEASE");
    },
  };
  const repository = new PgFinanceRepository({
    async connect() {
      connections += 1;
      return client;
    },
  });
  let outerClient;
  let nestedClient;

  await repository.transaction(async (outer) => {
    outerClient = outer;
    await repository.transaction(async (nested) => {
      nestedClient = nested;
    });
  });

  assert.equal(connections, 1);
  assert.equal(outerClient, client);
  assert.equal(nestedClient, client);
  assert.deepEqual(statements, ["BEGIN", "COMMIT", "RELEASE"]);
});

test("Plaid sync locks are held on a dedicated PostgreSQL session", async () => {
  const events = [];
  const client = {
    async query(sql, params) {
      events.push({ sql: String(sql), params });
      return { rows: [{ pg_advisory_lock: null }] };
    },
    release(destroy = false) {
      events.push({ release: true, destroy });
    },
  };
  const repository = new PgFinanceRepository({
    async connect() {
      events.push({ connect: true });
      return client;
    },
  });

  const result = await repository.withPlaidSyncLock(
    "connection-a",
    async () => {
      events.push({ operation: true });
      return "settled";
    },
  );

  assert.equal(result, "settled");
  assert.match(events[1].sql, /pg_advisory_lock\(hashtextextended/);
  assert.deepEqual(events[1].params, [
    "money:plaid-sync:connection-a",
  ]);
  assert.deepEqual(events[2], { operation: true });
  assert.match(events[3].sql, /pg_advisory_unlock\(hashtextextended/);
  assert.deepEqual(events[4], { release: true, destroy: false });
});

test("finance publication bumps and queues warming before commit", async () => {
  const events = [];
  const client = {
    async query(sql) {
      assert.match(String(sql), /workspace_read_model_revisions/);
      events.push("revision");
      return { rows: [{ revision: "8" }] };
    },
  };
  const publisher = createReadModelPublisher({
    revisionSource: {
      async read() {
        return "8";
      },
      async bump() {
        assert.fail("the atomic path must use the transaction client");
      },
    },
    jobQueue: {
      async enqueue(type, payload, options) {
        assert.equal(options.client, client);
        assert.equal(options.maxAttempts, 100);
        events.push(`queue:${type}:${payload.revision}`);
        return { id: "warm" };
      },
    },
    transactionRunner: async (operation) => {
      events.push("begin");
      const result = await operation(client);
      events.push("commit");
      return result;
    },
  });

  const result = await publisher.mutate("finance.edit", async () => {
    events.push("mutation");
    return { updated: true };
  });

  assert.deepEqual(result, { updated: true });
  assert.deepEqual(events, [
    "begin",
    "mutation",
    "revision",
    "queue:finance.warm_read_models:8",
    "commit",
  ]);
});

test("a failed atomic warm enqueue rolls the finance mutation back", async () => {
  const events = [];
  const client = {
    async query(sql) {
      assert.match(String(sql), /workspace_read_model_revisions/);
      events.push("revision");
      return { rows: [{ revision: "8" }] };
    },
  };
  const publisher = createReadModelPublisher({
    revisionSource: { async read() { return "8"; } },
    jobQueue: {
      async enqueue(_type, _payload, options) {
        assert.equal(options.client, client);
        events.push("queue");
        throw new Error("queue unavailable");
      },
    },
    transactionRunner: async (operation) => {
      events.push("begin");
      try {
        const result = await operation(client);
        events.push("commit");
        return result;
      } catch (error) {
        events.push("rollback");
        throw error;
      }
    },
  });

  await assert.rejects(
    publisher.mutate("finance.edit", async () => {
      events.push("mutation");
      return { updated: true };
    }),
    /queue unavailable/,
  );
  assert.deepEqual(events, [
    "begin",
    "mutation",
    "revision",
    "queue",
    "rollback",
  ]);
});

test("disabled caching never blocks revisioned writes", async () => {
  let warmJobs = 0;
  const client = {
    async query() {
      return { rows: [{ revision: "3" }] };
    },
  };
  const publisher = createReadModelPublisher({
    enabled: false,
    revisionSource: { async read() { return "2"; } },
    jobQueue: {
      async enqueue() {
        warmJobs += 1;
      },
    },
    transactionRunner: async (operation) => operation(client),
  });

  assert.deepEqual(
    await publisher.mutate("finance.edit", async () => ({ updated: true })),
    { updated: true },
  );
  assert.equal(
    await publisher.queueWarm("planning.write", "3", { strict: true }),
    null,
  );
  assert.equal(warmJobs, 0);
});

test("Plaid final-boundary warming uses the caller transaction", async () => {
  const client = {
    async query(sql) {
      assert.match(String(sql), /workspace_read_model_active_syncs/);
      return { rows: [{ revision: "11" }] };
    },
  };
  let enqueued;
  const publisher = createReadModelPublisher({
    revisionSource: {
      markSafe() {},
      markUnsafe() {},
    },
    jobQueue: {
      async enqueue(type, payload, options) {
        enqueued = { type, payload, options };
        return { id: "warm" };
      },
    },
  });

  assert.equal(
    await publisher.bumpInTransaction(
      client,
      "connection-a",
      "plaid.sync-finished",
    ),
    "11",
  );
  assert.equal(enqueued.type, "finance.warm_read_models");
  assert.deepEqual(enqueued.payload, {
    workspaceId: "shared",
    revision: "11",
    reason: "plaid.sync-finished",
  });
  assert.equal(enqueued.options.client, client);
  assert.equal(enqueued.options.maxAttempts, 100);
});

test("a clock boundary rolls back when its atomic warm enqueue fails", async () => {
  const events = [];
  const client = {};
  const publisher = createReadModelPublisher({
    revisionSource: {
      async publishClock(clockToken, db) {
        assert.equal(clockToken, "utc-2:local-1");
        assert.equal(db, client);
        events.push("clock");
        return "4";
      },
    },
    jobQueue: {
      async enqueue() {
        events.push("queue");
        throw new Error("queue unavailable");
      },
    },
    transactionRunner: async (operation) => {
      events.push("begin");
      try {
        await operation(client);
        events.push("commit");
      } catch (error) {
        events.push("rollback");
        throw error;
      }
    },
  });

  await assert.rejects(
    publisher.publishClockBoundary(
      "date-rollover",
      "utc-2:local-1",
    ),
    /queue unavailable/,
  );
  assert.deepEqual(events, ["begin", "clock", "queue", "rollback"]);
});

test("no-op and failed finance mutations do not publish false revisions", async () => {
  let revisionBumps = 0;
  let warmJobs = 0;
  const publisher = createReadModelPublisher({
    revisionSource: { async read() { return "1"; } },
    jobQueue: {
      async enqueue() {
        warmJobs += 1;
      },
    },
    transactionRunner: async (operation) =>
      operation({
        async query() {
          revisionBumps += 1;
          return { rows: [{ revision: "2" }] };
        },
      }),
  });

  assert.deepEqual(
    await publisher.mutate("finance.noop", async () => ({ updated: false })),
    { updated: false },
  );
  await assert.rejects(
    publisher.mutate("finance.failure", async () => {
      throw new Error("rolled back");
    }),
    /rolled back/,
  );
  assert.equal(revisionBumps, 0);
  assert.equal(warmJobs, 0);
});
