import pg from "pg";

const { Pool } = pg;

function boolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function databaseSslOptions({
  enabled,
  rejectUnauthorized = true,
} = {}) {
  if (enabled === undefined || enabled === "") return undefined;
  if (enabled && typeof enabled === "object") return enabled;
  if (!boolean(enabled, false)) return false;
  return {
    rejectUnauthorized: boolean(rejectUnauthorized, true),
  };
}

export function createPgPool({
  connectionString = process.env.DATABASE_URL,
  max = 10,
  idleTimeoutMillis = 30_000,
  connectionTimeoutMillis = 5_000,
  applicationName = "money",
  ssl = process.env.DATABASE_SSL,
  sslRejectUnauthorized =
    process.env.DATABASE_SSL_REJECT_UNAUTHORIZED,
} = {}) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const resolvedSsl = databaseSslOptions({
    enabled: ssl,
    rejectUnauthorized: sslRejectUnauthorized,
  });
  return new Pool({
    connectionString,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    application_name: applicationName,
    ...(resolvedSsl === undefined ? {} : { ssl: resolvedSsl }),
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
