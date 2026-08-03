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
    {
      dedupeKey = null,
      runAt = this.#now(),
      maxAttempts = 5,
      client = this.#pool,
    } = {},
  ) {
    const id = randomUUID();
    const result = await client.query(
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

  async hasPendingReadModelDependencies(workspaceId) {
    const result = await this.#pool.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM jobs j
          LEFT JOIN finance_connections c
            ON j.job_type = 'plaid.sync_item'
           AND c.id = j.payload->>'itemId'
          WHERE j.job_type = ANY(
              ARRAY[
                'plaid.sync_item',
                'finance.detect_recurring',
                'finance.generate_insights',
                'finance.nightly_refresh'
              ]::text[]
            )
            AND j.status = ANY(ARRAY['queued', 'running']::text[])
            AND (
              j.job_type <> 'finance.nightly_refresh'
              OR j.status = 'running'
              OR j.run_at <= now()
            )
            AND (
              j.payload->>'workspaceId' = $1
              OR c.workspace_id = $1
            )
        ) AS pending
      `,
      [workspaceId],
    );
    return Boolean(result.rows[0]?.pending);
  }

  async getInsightJobStatus(workspaceId) {
    const jobTypes = [
      "finance.detect_recurring",
      "finance.generate_insights",
      "finance.nightly_refresh",
    ];
    const [currentResult, latestResult, nextNightlyResult] =
      await Promise.all([
        this.#pool.query(
          `
            SELECT *
            FROM jobs
            WHERE job_type = ANY($2::text[])
              AND payload->>'workspaceId' = $1
              AND status = ANY(ARRAY['queued', 'running']::text[])
              AND (
                job_type <> 'finance.nightly_refresh'
                OR run_at <= now()
              )
            ORDER BY
              CASE status WHEN 'running' THEN 0 ELSE 1 END,
              updated_at DESC,
              created_at DESC
            LIMIT 1
          `,
          [workspaceId, jobTypes],
        ),
        this.#pool.query(
          `
            SELECT *
            FROM jobs
            WHERE job_type = ANY($2::text[])
              AND payload->>'workspaceId' = $1
              AND status = ANY(ARRAY['succeeded', 'failed']::text[])
            ORDER BY updated_at DESC, created_at DESC
            LIMIT 1
          `,
          [workspaceId, jobTypes],
        ),
        this.#pool.query(
          `
            SELECT run_at
            FROM jobs
            WHERE job_type = 'finance.nightly_refresh'
              AND payload->>'workspaceId' = $1
              AND status = 'queued'
              AND run_at > now()
            ORDER BY run_at
            LIMIT 1
          `,
          [workspaceId],
        ),
      ]);
    return {
      current: currentResult.rows[0]
        ? mapJob(currentResult.rows[0])
        : null,
      latest: latestResult.rows[0]
        ? mapJob(latestResult.rows[0])
        : null,
      nextScheduledAt: jobDate(
        nextNightlyResult.rows[0]?.run_at,
      ),
    };
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

  async heartbeat(jobId, workerId) {
    const result = await this.#pool.query(
      `
        UPDATE jobs
        SET locked_at = now(),
            updated_at = now()
        WHERE id = $1
          AND status = 'running'
          AND locked_by = $2
      `,
      [jobId, workerId],
    );
    return result.rowCount > 0;
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
      } else {
        await this.#settleAbandonedReadModelSyncs(client, row);
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
        let canSettleJob = true;
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
        } else {
          canSettleJob =
            await this.#settleAbandonedReadModelSyncs(client, row);
        }
        if (!canSettleJob) continue;
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

  async #settleAbandonedReadModelSyncs(client, job) {
    if (
      !["plaid.sync_item", "finance.nightly_refresh"].includes(
        job.job_type,
      )
    ) {
      return true;
    }
    const itemId = job.payload?.itemId ?? null;
    const workspaceId = job.payload?.workspaceId ?? null;
    const candidates = await client.query(
      `
        SELECT workspace_id, connection_id
        FROM workspace_read_model_active_syncs
        WHERE (
            $1 = 'plaid.sync_item'
            AND connection_id = $2
          )
          OR (
            $1 = 'finance.nightly_refresh'
            AND workspace_id = $3
          )
        FOR UPDATE
      `,
      [job.job_type, itemId, workspaceId],
    );

    let allSettled = true;
    for (const candidate of candidates.rows) {
      const successor = await client.query(
        `
          SELECT EXISTS (
            SELECT 1
            FROM jobs successor
            WHERE successor.id <> $1
              AND successor.job_type = 'plaid.sync_item'
              AND successor.payload->>'itemId' = $2
              AND successor.status = ANY(
                ARRAY['queued', 'running']::text[]
              )
          ) AS pending
        `,
        [job.id, candidate.connection_id],
      );
      if (successor.rows[0]?.pending === true) continue;

      const lockKey =
        `money:plaid-sync:${candidate.connection_id}`;
      const lock = await client.query(
        `
          SELECT pg_try_advisory_xact_lock(
            hashtextextended($1, 0)
          ) AS acquired
        `,
        [lockKey],
      );
      if (lock.rows[0]?.acquired !== true) {
        allSettled = false;
        continue;
      }

      const publication = await client.query(
        `
          WITH settled_sync AS (
            DELETE FROM workspace_read_model_active_syncs
            WHERE workspace_id = $1
              AND connection_id = $2
            RETURNING workspace_id
          )
          UPDATE workspace_read_model_revisions revision_row
          SET revision = revision_row.revision + 1,
              updated_at = now()
          WHERE revision_row.workspace_id = $1
            AND EXISTS (SELECT 1 FROM settled_sync)
          RETURNING revision_row.revision
        `,
        [candidate.workspace_id, candidate.connection_id],
      );
      const revision = publication.rows[0]?.revision;
      if (revision == null) continue;
      await this.enqueue(
        "finance.warm_read_models",
        {
          workspaceId: candidate.workspace_id,
          revision: String(revision),
          reason: "plaid.sync-abandoned",
        },
        {
          dedupeKey: candidate.workspace_id,
          maxAttempts: 100,
          client,
        },
      );
    }
    return allSettled;
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
    runAt: jobDate(row.run_at),
    createdAt: jobDate(row.created_at),
    updatedAt: jobDate(row.updated_at),
    lastError: row.last_error ?? null,
  };
}

function jobDate(value) {
  return value == null ? null : new Date(value);
}
