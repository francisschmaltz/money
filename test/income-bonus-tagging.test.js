import assert from "node:assert/strict";
import test from "node:test";

import { PgFinanceRepository } from "../app/db/financeRepository.js";

test("income bonus inference is scoped to name and account over 90 days", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const compact = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: compact, params });
      if (compact.includes("RETURNING transaction_id")) {
        return { rows: [{ transaction_id: "cisco-bonus" }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PgFinanceRepository({
    async connect() {
      return client;
    },
  });

  const tagged = await repository.autoTagIncomeBonuses("shared", {
    asOf: "2026-08-03",
  });

  assert.deepEqual(tagged, ["cisco-bonus"]);
  const inference = calls.find((call) =>
    call.sql.includes("WITH income_candidates AS"),
  );
  assert.ok(inference);
  assert.deepEqual(inference.params, ["shared", "2026-08-03"]);
  assert.match(inference.sql, /t\.posted_on >= \$2::date - 90/);
  assert.match(inference.sql, /peer\.account_id = candidate\.account_id/);
  assert.match(inference.sql, /peer\.income_identity = candidate\.income_identity/);
  assert.match(inference.sql, /peer_average_minor \* 1\.5/);
  assert.match(inference.sql, /tag\.normalized_name = 'bonus'/);
});
