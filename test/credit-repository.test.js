import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PgFinanceRepository } from "../app/db/financeRepository.js";

function fakePool(handler = async () => ({ rows: [] })) {
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
      connect: async () => client,
      query: client.query.bind(client),
    },
  };
}

test("daily account snapshots persist the limit without backfilling history", async () => {
  const migration = await readFile(
    fileURLToPath(
      new URL(
        "../migrations/005_credit_limit_snapshots.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  assert.match(
    migration,
    /ADD COLUMN IF NOT EXISTS credit_limit_minor bigint/,
  );
  assert.match(
    migration,
    /daily_account_snapshots_credit_limit_nonnegative/,
  );
  assert.doesNotMatch(
    migration,
    /UPDATE\s+daily_account_snapshots/i,
  );

  const db = fakePool();
  const repository = new PgFinanceRepository(db.pool);
  await repository.takeDailySnapshots("shared", "2026-07-27");
  const snapshot = db.calls.find((call) =>
    call.sql.includes("INSERT INTO daily_account_snapshots"),
  );

  assert.match(
    snapshot.sql,
    /current_balance_minor, available_balance_minor, credit_limit_minor, currency_code/,
  );
  assert.match(snapshot.sql, /a\.credit_limit_minor/);
  assert.match(
    snapshot.sql,
    /credit_limit_minor = EXCLUDED\.credit_limit_minor/,
  );
});

test("account snapshot reads return nullable credit limits as integer minor units", async () => {
  const db = fakePool(async (sql) => {
    if (!sql.includes("FROM daily_account_snapshots s")) {
      return { rows: [] };
    }
    return {
      rows: [
        {
          account_id: "card",
          account_name: "Card",
          snapshot_on: "2026-07-26",
          current_balance_minor: "281463",
          available_balance_minor: "718537",
          credit_limit_minor: "1000000",
          currency_code: "USD",
          type: "credit",
          subtype: "credit_card",
          is_liability: true,
          balance_group_override: null,
        },
        {
          account_id: "old-card",
          account_name: "Old card",
          snapshot_on: "2026-07-25",
          current_balance_minor: "10000",
          available_balance_minor: null,
          credit_limit_minor: null,
          currency_code: "USD",
          type: "credit",
          subtype: "credit_card",
          is_liability: true,
          balance_group_override: null,
        },
      ],
    };
  });
  const repository = new PgFinanceRepository(db.pool);
  const snapshots = await repository.getAccountSnapshots("shared", {
    startOn: "2026-07-01",
    endOn: "2026-07-27",
  });

  assert.equal(snapshots[0].credit_limit_minor, 1_000_000);
  assert.equal(snapshots[1].credit_limit_minor, null);
  assert.equal(snapshots[0].balance_group, "credit_card");
});
