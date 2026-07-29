import assert from "node:assert/strict";
import test from "node:test";

import { PgFinanceRepository } from "../app/db/financeRepository.js";

function fakePool(handler) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const compact = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: compact, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(compact)) {
        return { rows: [], rowCount: 0 };
      }
      return (await handler(compact, params)) ?? {
        rows: [],
        rowCount: 0,
      };
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

function storedRule(overrides = {}) {
  return {
    id: "pattern-1",
    workspace_id: "shared",
    stream_id: "stream-manual-1",
    source_transaction_id: "transaction-1",
    account_id: "account-1",
    match_field: "normalized_merchant",
    normalized_match_value: "electric company",
    anchor_amount_minor: 12_500,
    currency_code: "USD",
    stream_type: "bill",
    cadence: "monthly",
    active: true,
    created_by: "user-1",
    updated_by: "user-1",
    created_at: "2026-07-28T20:00:00.000Z",
    updated_at: "2026-07-28T20:00:00.000Z",
    ...overrides,
  };
}

test("upserting a recurring rule binds immutable merchant, account, and amount context", async () => {
  const db = fakePool(async (sql, params) => {
    if (sql.includes("FOR UPDATE OF t")) {
      return {
        rows: [
          {
            id: "transaction-1",
            account_id: "account-1",
            normalized_merchant: "electric company",
            normalized_name: "electric company payment",
            amount_minor: -12_500,
            currency_code: "USD",
            account_active: true,
          },
        ],
      };
    }
    if (
      sql.includes("FROM recurring_pattern_rules") &&
      sql.includes("FOR UPDATE")
    ) {
      assert.match(
        sql,
        /greatest\( 200, round\(anchor_amount_minor \* 0\.2\) \)/,
      );
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO recurring_pattern_rules")) {
      return {
        rows: [
          storedRule({
            id: params[0],
            stream_id: params[2],
          }),
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const rule = await repository.upsertRecurringPatternRule(
    "shared",
    "transaction-1",
    {
      type: "bill",
      cadence: "monthly",
      actorId: "user-1",
    },
  );

  assert.equal(rule.stream_type, "bill");
  assert.equal(rule.cadence, "monthly");
  const insert = db.calls.find((call) =>
    call.sql.startsWith("INSERT INTO recurring_pattern_rules"),
  );
  assert.ok(insert);
  assert.equal(insert.params[3], "transaction-1");
  assert.equal(insert.params[4], "account-1");
  assert.equal(insert.params[5], "normalized_merchant");
  assert.equal(insert.params[6], "electric company");
  assert.equal(insert.params[7], 12_500);
  assert.equal(insert.params[9], "bill");
  assert.equal(insert.params[10], "monthly");
  assert.equal(insert.params[11], "user-1");
});

test("removing a manual rule tombstones it and cancels its materialized stream", async () => {
  const db = fakePool(async (sql) => {
    if (sql.includes("UPDATE recurring_pattern_rules rule")) {
      return { rows: [storedRule({ active: false })] };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const rule = await repository.deactivateRecurringPatternRule(
    "shared",
    "transaction-1",
    { actorId: "user-1" },
  );

  assert.equal(rule.active, false);
  const streamUpdate = db.calls.find((call) =>
    call.sql.startsWith("UPDATE recurring_streams"),
  );
  assert.ok(streamUpdate);
  assert.match(streamUpdate.sql, /status = 'canceled'/);
  assert.deepEqual(streamUpdate.params, [
    "shared",
    "stream-manual-1",
    "user-1",
  ]);
});

test("editing a manual stream updates both the rule and effective stream classification", async () => {
  const db = fakePool(async (sql) => {
    if (sql.startsWith("UPDATE recurring_streams")) {
      return {
        rows: [
          {
            id: "stream-manual-1",
            service_family: "electric company",
            display_name: "Electric Company",
            stream_type: "bill",
            stream_type_override: "subscription",
            classification_signals: {},
            cadence: "monthly",
            account_id: "account-1",
            expected_amount_minor: 12_500,
            min_amount_minor: 12_500,
            max_amount_minor: 12_500,
            monthly_equivalent_minor: 12_500,
            currency_code: "USD",
            first_seen_on: "2026-06-01",
            last_seen_on: "2026-07-01",
            next_expected_on: "2026-08-01",
            confidence_basis_points: 10_000,
            status: "active",
            duplicate_state: "unknown",
            transaction_ids: ["transaction-1"],
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const updated = await repository.updateRecurringClassification(
    "shared",
    "stream-manual-1",
    { type: "subscription", actorId: "user-1" },
  );

  const ruleUpdate = db.calls.find(
    (call) =>
      call.sql.startsWith("UPDATE recurring_pattern_rules") &&
      call.sql.includes("SET stream_type"),
  );
  assert.ok(ruleUpdate);
  assert.deepEqual(ruleUpdate.params, [
    "shared",
    "stream-manual-1",
    "subscription",
    "user-1",
  ]);
  assert.equal(updated.stream_type, "subscription");
});
