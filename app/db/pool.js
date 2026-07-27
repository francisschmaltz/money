import pg from "pg";

const { Pool } = pg;

export function createPgPool({
  connectionString = process.env.DATABASE_URL,
  max = 10,
  idleTimeoutMillis = 30_000,
  connectionTimeoutMillis = 5_000,
  applicationName = "money",
  ssl,
} = {}) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  return new Pool({
    connectionString,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    application_name: applicationName,
    ...(ssl === undefined ? {} : { ssl }),
  });
}

export async function withTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function checkDatabase(pool) {
  const result = await pool.query("SELECT 1 AS ok");
  return result.rows[0]?.ok === 1;
}
