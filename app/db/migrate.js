import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { withTransaction } from "./pool.js";

const DEFAULT_DIRECTORY = fileURLToPath(
  new URL("../../migrations/", import.meta.url),
);

export async function migrate(pool, { directory = DEFAULT_DIRECTORY } = {}) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const filenames = (await readdir(directory))
    .filter((filename) => /^\d+.*\.sql$/.test(filename))
    .sort();

  const appliedResult = await pool.query(
    "SELECT version FROM schema_migrations",
  );
  const applied = new Set(appliedResult.rows.map((row) => row.version));
  const completed = [];

  for (const filename of filenames) {
    if (applied.has(filename)) continue;

    const sql = await readFile(path.join(directory, filename), "utf8");
    // Migration files own their transaction boundaries. Running their SQL and
    // the bookkeeping insert on one connection avoids pool interleaving.
    await withTransaction(pool, async (client) => {
      const withoutBoundary = sql
        .replace(/^\s*BEGIN\s*;\s*/i, "")
        .replace(/\s*COMMIT\s*;\s*$/i, "");
      await client.query(withoutBoundary);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [filename],
      );
    });
    completed.push(filename);
  }

  return completed;
}

export async function runMigrationsFromEnvironment() {
  const { createPgPool } = await import("./pool.js");
  const pool = createPgPool();
  try {
    const completed = await migrate(pool);
    process.stdout.write(
      completed.length
        ? `Applied migrations: ${completed.join(", ")}\n`
        : "Database is current.\n",
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrationsFromEnvironment().catch((error) => {
    process.stderr.write(`Migration failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
