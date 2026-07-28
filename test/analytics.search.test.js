import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { performance } from "node:perf_hooks";
import { PgFinanceRepository } from "../app/db/financeRepository.js";

test(
  "PostgreSQL typo search stays below 300ms with 100k documents",
  { timeout: 60_000 },
  async (context) => {
    if (!process.env.DATABASE_URL) {
      context.skip("DATABASE_URL is not configured");
      return;
    }
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
    });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
      await client.query(`
        CREATE TEMP TABLE search_documents (
          id text PRIMARY KEY,
          workspace_id text NOT NULL,
          entity_type text NOT NULL,
          entity_id text NOT NULL,
          title text NOT NULL,
          subtitle text,
          search_text text NOT NULL,
          normalized_text text NOT NULL,
          metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
          search_vector tsvector GENERATED ALWAYS AS (
            to_tsvector('simple', search_text)
          ) STORED
        ) ON COMMIT DROP
      `);
      await client.query(`
        CREATE TEMP TABLE transaction_splits (
          workspace_id text NOT NULL,
          transaction_id text NOT NULL,
          category text NOT NULL,
          category_id text
        ) ON COMMIT DROP
      `);
      await client.query(
        `
          INSERT INTO search_documents (
            id, workspace_id, entity_type, entity_id, title,
            search_text, normalized_text
          )
          SELECT
            'doc-' || value,
            'shared',
            'transaction',
            'transaction-' || value,
            CASE WHEN value = 50000 THEN 'Netflix' ELSE 'Merchant ' || value END,
            CASE WHEN value = 50000 THEN 'netflix streaming' ELSE 'merchant purchase ' || value END,
            CASE WHEN value = 50000 THEN 'netflix streaming' ELSE 'merchant purchase ' || value END
          FROM generate_series(1, 100000) AS value
        `,
      );
      await client.query(
        "CREATE INDEX search_documents_fts_test_idx ON search_documents USING gin (search_vector)",
      );
      await client.query(
        "CREATE INDEX search_documents_trgm_test_idx ON search_documents USING gin (normalized_text gin_trgm_ops)",
      );
      await client.query("ANALYZE search_documents");
      await client.query(
        "SET LOCAL pg_trgm.similarity_threshold = 0.95",
      );
      await client.query(`
        INSERT INTO transaction_splits (
          workspace_id, transaction_id, category
        )
        VALUES
          ('shared', 'transaction-50000', 'Streaming'),
          ('shared', 'transaction-75000', 'Household Projects')
      `);

      const repository = new PgFinanceRepository(client);
      await repository.search("shared", "netflx", { limit: 10 });
      const started = performance.now();
      const results = await repository.search("shared", "netflx", {
        limit: 10,
      });
      const elapsed = performance.now() - started;
      assert.equal(results[0].title, "Netflix");
      assert.ok(elapsed < 300, `search took ${elapsed.toFixed(1)}ms`);

      const splitResults = await repository.search(
        "shared",
        "household projects",
        { limit: 10 },
      );
      assert.equal(splitResults[0].entity_id, "transaction-75000");

      const duplicateResults = await repository.search(
        "shared",
        "netflix",
        { limit: 10 },
      );
      assert.equal(
        duplicateResults.filter(
          (result) => result.entity_id === "transaction-50000",
        ).length,
        1,
      );

      await client.query(
        `
          DELETE FROM transaction_splits
          WHERE transaction_id = 'transaction-75000'
        `,
      );
      const clearedResults = await repository.search(
        "shared",
        "household projects",
        { limit: 10 },
      );
      assert.equal(
        clearedResults.some(
          (result) => result.entity_id === "transaction-75000",
        ),
        false,
      );
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      await pool.end();
    }
  },
);
