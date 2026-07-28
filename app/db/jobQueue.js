import { randomUUID } from "node:crypto";
import { withTransaction } from "./pool.js";

export function safeJobError(error) {
  if (!(error instanceof Error)) return "JobError";
  const name = /^[A-Za-z][A-Za-z0-9]*Error$/.test(error.name)
    ? error.name
    : "JobError";
  const code =
    typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)
      ? error.code
      : null;
  // Provider and database messages routinely echo URLs, credentials, SQL
  // values, or response bodies. Persisting only class/code makes the queue
  // useful operationally without creating a second secrets database.
  return code ? `${name}:${code}` : name;
}

export class PgJobQueue {
  #pool;
  #now;

  constructor(pool, { now = () => new Date() } = {}) {
    this.#pool = pool;
    this.#now = now;
  }

  async enqueue(
    jobType,
    payload = {},
    { dedupeKey = null, runAt = this.#now(), maxAttempts = 5 } = {},
  ) {
    const id = randomUUID();
    const result = await this.#pool.query(
      `
        INSERT INTO jobs (
          id, job_type, payload, dedupe_key, run_at, max_attempts
        )
        VALUES ($1, $2, $3::jsonb, $4, $5, $6)
        ON CONFLICT (job_type, dedupe_key)
          WHERE dedupe_key IS NOT NULL AND status = 'queued'
        DO UPDATE SET
          run_at = LEAST(jobs.run_at, EXCLUDED.run_at),
          payload = EXCLUDED.payload,
          updated_at = now()
        RETURNING *
      `,
      [id, jobType, JSON.stringify(payload), dedupeKey, runAt, maxAttempts],
    );
    return mapJob(result.rows[0]);
  }

  async claim(workerId, { jobTypes = null } = {}) {
    return withTransaction(this.#pool, async (client) => {
      const params = [];
      let typeFilter = "";
      if (jobTypes?.length) {
        params.push(jobTypes);
        typeFilter = `AND job_type = ANY($${params.length}::text[])`;
      }
      params.push(workerId);
      const workerParameter = `$${params.length}`;

      const result = await client.query(
        `
          WITH candidate AS (
            SELECT id
            FROM jobs
            WHERE status = 'queued'
              AND run_at <= now()
              AND attempts < max_attempts
              ${typeFilter}
            ORDER BY run_at, created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE jobs
          SET status = 'running',
              attempts = attempts + 1,
              locked_at = now(),
              locked_by = ${workerParameter},
              updated_at = now()
          WHERE id = (SELECT id FROM candidate)
          RETURNING *
        `,
        params,
      );
      return result.rows[0] ? mapJob(result.rows[0]) : null;
    });
  }

  async hasPendingPlaidSyncs(workspaceId) {
    const result = await this.#pool.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM jobs j
          JOIN finance_connections c
            ON c.id = j.payload->>'itemId'
          WHERE c.workspace_id = $1
            AND j.job_type = 'plaid.sync_item'
            AND j.status = ANY(ARRAY['queued', 'running']::text[])
        ) AS pending
      `,
      [workspaceId],
    );
    return Boolean(result.rows[0]?.pending);
  }

  async complete(jobId) {
    await this.#pool.query(
      `
        UPDATE jobs
        SET status = 'succeeded',
            locked_at = NULL,
            locked_by = NULL,
            updated_at = now()
        WHERE id = $1 AND status = 'running'
      `,
      [jobId],
    );
  }

  async fail(jobId, error, { retryDelayMs } = {}) {
    return withTransaction(this.#pool, async (client) => {
      const current = await client.query(
        `
          SELECT *
          FROM jobs
          WHERE id = $1
          FOR UPDATE
        `,
        [jobId],
      );
      if (!current.rows[0]) return null;

      const row = current.rows[0];
      const attempts = Number(row.attempts);
      const maxAttempts = Number(row.max_attempts);
      const retry = attempts < maxAttempts;
      const backoff =
        retryDelayMs ?? Math.min(60 * 60_000, 2 ** attempts * 1_000);
      const safeError = safeJobError(error);
      let replacement = null;
      if (retry) {
        const queued = await client.query(
          `
            INSERT INTO jobs (
              id, job_type, payload, dedupe_key, status, attempts,
              max_attempts, run_at, last_error
            )
            VALUES (
              $1, $2, $3::jsonb, $4, 'queued', $5, $6,
              now() + ($7 * interval '1 millisecond'), $8
            )
            ON CONFLICT (job_type, dedupe_key)
              WHERE dedupe_key IS NOT NULL AND status = 'queued'
            DO UPDATE SET
              run_at = LEAST(jobs.run_at, EXCLUDED.run_at),
              updated_at = now()
            RETURNING *
          `,
          [
            randomUUID(),
            row.job_type,
            JSON.stringify(row.payload),
            row.dedupe_key,
            attempts,
            maxAttempts,
            backoff,
            safeError,
          ],
        );
        replacement = queued.rows[0];
      }

      const failed = await client.query(
        `
          UPDATE jobs
          SET status = 'failed',
              locked_at = NULL,
              locked_by = NULL,
              last_error = $2,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [jobId, safeError],
      );
      return mapJob(replacement ?? failed.rows[0]);
    });
  }

  async recoverStale({ olderThanMs = 15 * 60_000 } = {}) {
    return withTransaction(this.#pool, async (client) => {
      const stale = await client.query(
        `
          SELECT *
          FROM jobs
          WHERE status = 'running'
            AND locked_at < now() - ($1 * interval '1 millisecond')
          FOR UPDATE SKIP LOCKED
        `,
        [olderThanMs],
      );

      for (const row of stale.rows) {
        const attempts = Number(row.attempts);
        const maxAttempts = Number(row.max_attempts);
        if (attempts < maxAttempts) {
          await client.query(
            `
              INSERT INTO jobs (
                id, job_type, payload, dedupe_key, status, attempts,
                max_attempts, run_at, last_error
              )
              VALUES (
                $1, $2, $3::jsonb, $4, 'queued', $5, $6, now(),
                'JobError:WORKER_LEASE_EXPIRED'
              )
              ON CONFLICT (job_type, dedupe_key)
                WHERE dedupe_key IS NOT NULL AND status = 'queued'
              DO UPDATE SET
                run_at = LEAST(jobs.run_at, EXCLUDED.run_at),
                updated_at = now()
            `,
            [
              randomUUID(),
              row.job_type,
              JSON.stringify(row.payload),
              row.dedupe_key,
              attempts,
              maxAttempts,
            ],
          );
        }
        await client.query(
          `
            UPDATE jobs
            SET status = 'failed',
                locked_at = NULL,
                locked_by = NULL,
                last_error = 'JobError:WORKER_LEASE_EXPIRED',
                updated_at = now()
            WHERE id = $1
          `,
          [row.id],
        );
      }
      return stale.rowCount;
    });
  }
}

function mapJob(row) {
  return {
    id: row.id,
    type: row.job_type,
    payload: row.payload,
    dedupeKey: row.dedupe_key,
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    runAt: new Date(row.run_at),
  };
}
