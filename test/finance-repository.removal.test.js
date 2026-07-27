import test from "node:test";
import assert from "node:assert/strict";
import { PgFinanceRepository } from "../app/db/financeRepository.js";
import { PlaidSyncService } from "../app/services/plaidSyncService.js";

function fakePool(handler) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const compact = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: compact, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(compact)) {
        return { rows: [], rowCount: 0 };
      }
      return (await handler(compact, params)) ?? { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return {
    calls,
    pool: {
      async connect() {
        return client;
      },
      query: client.query.bind(client),
    },
  };
}

test("retaining Plaid history deactivates accounts and hides current holdings", async () => {
  const db = fakePool(async (sql) => {
    if (sql.includes("SELECT workspace_id") && sql.includes("FOR UPDATE")) {
      return { rows: [{ workspace_id: "shared" }] };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  assert.equal(
    await repository.removePlaidItem("item-1", { retainHistory: true }),
    true,
  );

  const deactivate = db.calls.find((call) =>
    call.sql.includes("UPDATE accounts SET active = false"),
  );
  assert.deepEqual(deactivate?.params, ["item-1"]);
  const cancelStreams = db.calls.find((call) =>
    call.sql.includes("UPDATE recurring_streams SET status = 'canceled'"),
  );
  assert.deepEqual(cancelStreams?.params, ["item-1", "shared"]);

  const searchDelete = db.calls.find(
    (call) =>
      call.sql.includes("DELETE FROM search_documents") &&
      call.sql.includes("entity_type = 'account'"),
  );
  assert.deepEqual(searchDelete?.params, ["item-1", "shared"]);

  const itemUpdate = db.calls.find((call) =>
    call.sql.includes("UPDATE finance_connections SET status = 'removed'"),
  );
  assert.deepEqual(itemUpdate?.params, ["item-1"]);
  assert.equal(
    db.calls.some(
      (call) =>
        call.sql === "DELETE FROM finance_connections WHERE id = $1",
    ),
    false,
  );
  assert.equal(
    db.calls.some((call) =>
      /^DELETE FROM (accounts|transactions|holdings|daily_)/.test(call.sql),
    ),
    false,
  );
  assert.doesNotMatch(searchDelete.sql, /entity_type = 'transaction'/);
  assert.match(searchDelete.sql, /entity_type = 'recurring'/);
  assert.match(searchDelete.sql, /entity_type = 'insight'/);
  assert.ok(
    db.calls.some(
      (call) =>
        call.sql ===
        "DELETE FROM insight_narratives WHERE workspace_id = $1",
    ),
  );
  assert.equal(
    db.calls.some(
      (call) =>
        call.sql === "DELETE FROM insight_findings WHERE workspace_id = $1",
    ),
    false,
  );
  const retireInsights = db.calls.find((call) =>
    call.sql.startsWith("UPDATE insight_findings SET is_current = false"),
  );
  assert.deepEqual(retireInsights?.params, ["shared"]);
  assert.match(retireInsights.sql, /retired_at = COALESCE\(retired_at, now\(\)\)/);

  await repository.getHoldings("shared");
  const holdingsQuery = db.calls.find((call) =>
    call.sql.includes("FROM holdings h"),
  );
  assert.match(
    holdingsQuery.sql,
    /JOIN finance_connections i ON i\.id = a\.connection_id/,
  );
  assert.match(holdingsQuery.sql, /a\.active = true/);
  assert.match(holdingsQuery.sql, /i\.status <> 'removed'/);
});

test("purging a Plaid Item deletes account and transaction search documents first", async () => {
  const db = fakePool(async (sql) => {
    if (sql.includes("SELECT workspace_id") && sql.includes("FOR UPDATE")) {
      return { rows: [{ workspace_id: "shared" }] };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  assert.equal(
    await repository.removePlaidItem("item-1", { retainHistory: false }),
    true,
  );

  const searchIndex = db.calls.findIndex((call) =>
    call.sql.includes("DELETE FROM search_documents"),
  );
  const itemDeleteIndex = db.calls.findIndex(
    (call) =>
      call.sql === "DELETE FROM finance_connections WHERE id = $1",
  );
  assert.ok(searchIndex > -1);
  assert.ok(itemDeleteIndex > searchIndex);

  const searchDelete = db.calls[searchIndex];
  assert.deepEqual(searchDelete.params, ["item-1", "shared"]);
  assert.match(searchDelete.sql, /entity_type = 'account'/);
  assert.match(searchDelete.sql, /entity_type = 'transaction'/);
  assert.match(searchDelete.sql, /entity_type = 'recurring'/);
  assert.match(searchDelete.sql, /entity_type = 'insight'/);
  assert.match(searchDelete.sql, /JOIN accounts a ON a\.id = t\.account_id/);
  assert.match(searchDelete.sql, /WHERE a\.connection_id = \$1/);

  const streamDeleteIndex = db.calls.findIndex((call) =>
    call.sql.includes("DELETE FROM recurring_streams"),
  );
  assert.ok(streamDeleteIndex > searchIndex);
  assert.ok(itemDeleteIndex > streamDeleteIndex);
  assert.ok(
    db.calls.some(
      (call) =>
        call.sql ===
        "DELETE FROM insight_narratives WHERE workspace_id = $1",
    ),
  );
  assert.ok(
    db.calls.some(
      (call) =>
        call.sql === "DELETE FROM insight_findings WHERE workspace_id = $1",
    ),
  );
});

test("Plaid removal queues one derived-data rebuild after invalidation", async () => {
  const events = [];
  const service = new PlaidSyncService({
    provider: {
      async removeItem(token) {
        assert.equal(token, "access-token");
        events.push("provider");
      },
    },
    repository: {
      async getPlaidItem() {
        return { id: "item-1", workspace_id: "shared" };
      },
      async removePlaidItem(itemId, options) {
        assert.equal(itemId, "item-1");
        assert.deepEqual(options, { retainHistory: true });
        events.push("invalidate");
      },
    },
    secretRepository: {
      async get() {
        return "access-token";
      },
      async delete(itemId) {
        assert.equal(itemId, "item-1");
        events.push("secret");
      },
    },
    jobQueue: {
      async enqueue(type, payload, options) {
        assert.equal(type, "finance.detect_recurring");
        assert.deepEqual(payload, { workspaceId: "shared" });
        assert.deepEqual(options, { dedupeKey: "shared" });
        events.push("recompute");
        return { id: "job-1" };
      },
    },
  });

  assert.equal(
    await service.removeItem("item-1", { retainHistory: true }),
    true,
  );
  assert.deepEqual(events, [
    "provider",
    "secret",
    "invalidate",
    "recompute",
  ]);
});

test("derived queries can exclude deactivated and removed Item accounts", async () => {
  const db = fakePool(async () => ({ rows: [] }));
  const repository = new PgFinanceRepository(db.pool);

  await repository.listTransactions("shared", {
    activeAccountsOnly: true,
  });
  await repository.getHoldingSnapshots("shared", {
    activeAccountsOnly: true,
  });
  await repository.getInvestmentTransactions("shared", {
    activeAccountsOnly: true,
  });

  for (const call of db.calls.filter(
    (entry) =>
      entry.sql.includes("FROM transactions t") ||
      entry.sql.includes("FROM daily_holding_snapshots s") ||
      entry.sql.includes("FROM investment_transactions it"),
  )) {
    assert.match(
      call.sql,
      /JOIN finance_connections i ON i\.id = a\.connection_id/,
    );
    assert.match(call.sql, /a\.active = true/);
    assert.match(call.sql, /i\.status <> 'removed'/);
    assert.equal(call.params.at(-1), true);
  }
});

test("daily snapshots never turn removed Item holdings into current history", async () => {
  const db = fakePool(async () => ({ rows: [] }));
  const repository = new PgFinanceRepository(db.pool);

  await repository.takeDailySnapshots("shared", "2026-07-27");

  const accountSnapshot = db.calls.find((call) =>
    call.sql.includes("INSERT INTO daily_account_snapshots"),
  );
  assert.match(
    accountSnapshot.sql,
    /JOIN finance_connections i ON i\.id = a\.connection_id/,
  );
  assert.match(accountSnapshot.sql, /a\.active = true/);
  assert.match(accountSnapshot.sql, /i\.status <> 'removed'/);

  const holdingsSnapshot = db.calls.find((call) =>
    call.sql.includes("INSERT INTO daily_holding_snapshots"),
  );
  assert.match(holdingsSnapshot.sql, /JOIN accounts a ON a\.id = h\.account_id/);
  assert.match(
    holdingsSnapshot.sql,
    /JOIN finance_connections i ON i\.id = a\.connection_id/,
  );
  assert.match(holdingsSnapshot.sql, /a\.active = true/);
  assert.match(holdingsSnapshot.sql, /i\.status <> 'removed'/);
});
