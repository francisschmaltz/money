import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PgFinanceRepository } from "../app/db/financeRepository.js";

function fakePool(handler) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const compact = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: compact, params });
      return (await handler(compact, params)) ?? {
        rows: [],
        rowCount: 0,
      };
    },
  };
  return {
    calls,
    pool: {
      query: client.query.bind(client),
    },
  };
}

test("credit score schema enforces ownership, ranges, and one observation per date", async () => {
  const migration = await readFile(
    fileURLToPath(
      new URL(
        "../migrations/010_manual_credit_scores.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  assert.match(
    migration,
    /FOREIGN KEY \(workspace_id, user_id\)[\s\S]*workspace_members/,
  );
  assert.match(migration, /score BETWEEN 300 AND 850/);
  assert.match(migration, /UNIQUE \(source_id, observed_on\)/);
});

test("source and observation writes are scoped to the owning member", async () => {
  const db = fakePool(async (sql, params) => {
    if (sql.includes("UPDATE credit_score_sources")) {
      assert.match(sql, /user_id = \$3/);
      return {
        rows: [
          {
            id: "source_1",
            user_id: "person_1",
            label: "Experian",
            bureau: "Experian",
            scoring_model: "FICO Score 8",
            archived_on: null,
          },
        ],
      };
    }
    if (sql.includes("INSERT INTO credit_score_observations")) {
      assert.match(sql, /source\.user_id = \$4/);
      assert.match(
        sql,
        /ON CONFLICT \(source_id, observed_on\) DO UPDATE/,
      );
      return {
        rows: [
          {
            id: "observation_1",
            source_id: "source_1",
            observed_on: "2026-07-20",
            score: "745",
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const updated = await repository.updateCreditScoreSource("shared", {
    sourceId: "source_1",
    ownerUserId: "person_1",
    label: "Experian",
  });
  const observation = await repository.upsertCreditScoreObservation(
    "shared",
    {
      sourceId: "source_1",
      ownerUserId: "person_1",
      observedOn: "2026-07-20",
      score: 745,
    },
  );

  assert.equal(updated.user_id, "person_1");
  assert.equal(observation.score, 745);
});
