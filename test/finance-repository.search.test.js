import test from "node:test";
import assert from "node:assert/strict";

import { PgFinanceRepository } from "../app/db/financeRepository.js";

test("split-category search is isolated from the indexed base search", async () => {
  const calls = [];
  const repository = new PgFinanceRepository({
    async query(sql, params) {
      calls.push({
        sql: String(sql).replace(/\s+/g, " ").trim(),
        params,
      });
      return { rows: [] };
    },
  });

  await repository.search("shared", "household projects", {
    entityTypes: ["transaction"],
    limit: 10,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /^WITH search_settings AS MATERIALIZED/);
  assert.match(
    calls[0].sql,
    /set_config\( 'pg_trgm\.similarity_threshold', '0\.2', true \)/,
  );
  assert.equal(
    calls[0].sql.match(/FROM transaction_splits split/g)?.length,
    1,
  );
  assert.doesNotMatch(calls[0].sql, /\bEXISTS\s*\(/);
  assert.match(
    calls[0].sql,
    /FROM search_documents WHERE workspace_id = \$1/,
  );
  assert.equal(
    calls[0].sql.match(/normalized_text % \( SELECT \$2 FROM search_settings/g)
      ?.length,
    2,
  );
  assert.doesNotMatch(
    calls[0].sql,
    /similarity\([^)]*, \$2\) >= 0\.2/,
  );
  assert.deepEqual(calls[0].params, [
    "shared",
    "household projects",
    ["transaction"],
    10,
  ]);
});
