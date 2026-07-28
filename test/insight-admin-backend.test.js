import test from "node:test";
import assert from "node:assert/strict";

import { PgFinanceRepository } from "../app/db/financeRepository.js";
import { PgJobQueue } from "../app/db/jobQueue.js";
import { createFinanceService } from "../app/services/financeService.js";

function fakePool(handler = async () => ({ rows: [], rowCount: 0 })) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const compact = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: compact, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(compact)) {
        return { rows: [], rowCount: 0 };
      }
      return (
        (await handler(compact, params)) ?? {
          rows: [],
          rowCount: 0,
        }
      );
    },
    release() {},
  };
  return {
    calls,
    pool: {
      query: client.query.bind(client),
      async connect() {
        return client;
      },
    },
  };
}

function freshData(overrides = {}) {
  return {
    partial: false,
    data_as_of: "2026-07-28T15:00:00.000Z",
    warnings: [],
    ...overrides,
  };
}

function emptyInsightStorage(overrides = {}) {
  return {
    active_count: 0,
    archived_count: 0,
    total_count: 0,
    last_findings_generated_at: null,
    ...overrides,
  };
}

test("insight job status separates active work, the last result, and the next nightly run", async () => {
  const db = fakePool(async (sql) => {
    if (
      sql.includes(
        "status = ANY(ARRAY['queued', 'running']::text[])",
      )
    ) {
      return {
        rows: [
          {
            id: "job-current",
            job_type: "finance.detect_recurring",
            payload: { workspaceId: "shared", source: "manual" },
            dedupe_key: "shared",
            status: "running",
            attempts: 1,
            max_attempts: 5,
            run_at: "2026-07-28T16:00:00.000Z",
            created_at: "2026-07-28T15:59:00.000Z",
            updated_at: "2026-07-28T16:01:00.000Z",
            last_error: null,
          },
        ],
      };
    }
    if (
      sql.includes(
        "status = ANY(ARRAY['succeeded', 'failed']::text[])",
      )
    ) {
      return {
        rows: [
          {
            id: "job-latest",
            job_type: "finance.generate_insights",
            payload: { workspaceId: "shared" },
            dedupe_key: "shared",
            status: "failed",
            attempts: 5,
            max_attempts: 5,
            run_at: "2026-07-27T16:00:00.000Z",
            created_at: "2026-07-27T15:59:00.000Z",
            updated_at: "2026-07-27T16:03:00.000Z",
            last_error: "InsightModelError:TIMEOUT",
          },
        ],
      };
    }
    if (
      sql.startsWith("SELECT run_at FROM jobs") &&
      sql.includes("finance.nightly_refresh")
    ) {
      return {
        rows: [{ run_at: "2026-07-29T09:00:00.000Z" }],
      };
    }
    return { rows: [] };
  });
  const queue = new PgJobQueue(db.pool);

  const status = await queue.getInsightJobStatus("shared");

  assert.deepEqual(status, {
    current: {
      id: "job-current",
      type: "finance.detect_recurring",
      payload: { workspaceId: "shared", source: "manual" },
      dedupeKey: "shared",
      status: "running",
      attempts: 1,
      maxAttempts: 5,
      runAt: new Date("2026-07-28T16:00:00.000Z"),
      createdAt: new Date("2026-07-28T15:59:00.000Z"),
      updatedAt: new Date("2026-07-28T16:01:00.000Z"),
      lastError: null,
    },
    latest: {
      id: "job-latest",
      type: "finance.generate_insights",
      payload: { workspaceId: "shared" },
      dedupeKey: "shared",
      status: "failed",
      attempts: 5,
      maxAttempts: 5,
      runAt: new Date("2026-07-27T16:00:00.000Z"),
      createdAt: new Date("2026-07-27T15:59:00.000Z"),
      updatedAt: new Date("2026-07-27T16:03:00.000Z"),
      lastError: "InsightModelError:TIMEOUT",
    },
    nextScheduledAt: new Date("2026-07-29T09:00:00.000Z"),
  });

  assert.equal(db.calls.length, 3);
  for (const call of db.calls) {
    assert.equal(call.params[0], "shared");
  }
  const expectedJobTypes = [
    "finance.detect_recurring",
    "finance.generate_insights",
    "finance.nightly_refresh",
  ];
  assert.deepEqual(db.calls[0].params[1], expectedJobTypes);
  assert.deepEqual(db.calls[1].params[1], expectedJobTypes);
  assert.match(
    db.calls[0].sql,
    /job_type <> 'finance\.nightly_refresh' OR run_at <= now\(\)/,
  );
  assert.match(
    db.calls[2].sql,
    /status = 'queued' AND run_at > now\(\)/,
  );
});

test("insight storage summary returns stable numeric counts and an ISO timestamp", async () => {
  const db = fakePool(async (sql, params) => {
    if (sql.includes("FROM insight_findings")) {
      assert.deepEqual(params, ["workspace-1"]);
      return {
        rows: [
          {
            active_count: "3",
            archived_count: "8",
            total_count: "11",
            last_findings_generated_at:
              "2026-07-28T14:30:00.000Z",
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const summary =
    await repository.getInsightStorageSummary("workspace-1");

  assert.deepEqual(summary, {
    active_count: 3,
    archived_count: 8,
    total_count: 11,
    last_findings_generated_at: "2026-07-28T14:30:00.000Z",
  });
  assert.match(
    db.calls[0].sql,
    /is_current = true AND state = 'active'/,
  );
});

test("clearing insight output deletes generated artifacts but preserves feedback and corrections", async () => {
  const db = fakePool(async (sql, params) => {
    assert.deepEqual(params, ["shared"]);
    if (sql.startsWith("DELETE FROM search_documents")) {
      return { rows: [], rowCount: 4 };
    }
    if (sql.startsWith("DELETE FROM insight_narratives")) {
      return { rows: [], rowCount: 2 };
    }
    if (sql.startsWith("DELETE FROM insight_findings")) {
      return { rows: [], rowCount: 7 };
    }
    return { rows: [], rowCount: 0 };
  });
  const repository = new PgFinanceRepository(db.pool);

  const result = await repository.clearInsightOutput("shared");

  assert.deepEqual(result, {
    findings_deleted: 7,
    narratives_deleted: 2,
    search_documents_deleted: 4,
  });
  assert.deepEqual(
    db.calls.map((call) => call.sql),
    [
      "BEGIN",
      "DELETE FROM search_documents WHERE workspace_id = $1 AND entity_type = 'insight'",
      "DELETE FROM insight_narratives WHERE workspace_id = $1",
      "DELETE FROM insight_findings WHERE workspace_id = $1",
      "COMMIT",
    ],
  );
  assert.equal(
    db.calls.some((call) =>
      /insight_finding_(preferences|events)|recurring_streams/.test(
        call.sql,
      ),
    ),
    false,
  );
});

test("insight status reports completed output, counts, and the next scheduled run", async () => {
  const repository = {
    async getDataFreshness(workspaceId) {
      assert.equal(workspaceId, "shared");
      return freshData();
    },
    async getInsightStorageSummary(workspaceId) {
      assert.equal(workspaceId, "shared");
      return emptyInsightStorage({
        active_count: 4,
        archived_count: 6,
        total_count: 10,
        last_findings_generated_at:
          "2026-07-28T15:45:00.000Z",
      });
    },
  };
  const jobQueue = {
    async getInsightJobStatus(workspaceId) {
      assert.equal(workspaceId, "shared");
      return {
        current: null,
        latest: {
          type: "finance.generate_insights",
          status: "succeeded",
          updatedAt: new Date("2026-07-28T15:46:00.000Z"),
          lastError: null,
        },
        nextScheduledAt: new Date("2026-07-29T09:00:00.000Z"),
      };
    },
  };
  const service = createFinanceService({ repository, jobQueue });

  const status = await service.getInsightStatus();

  assert.deepEqual(status, {
    state: "ready",
    can_run: true,
    pause_reasons: [],
    freshness_data_as_of: "2026-07-28T15:00:00.000Z",
    current_job_type: null,
    last_run_at: "2026-07-28T15:46:00.000Z",
    last_run_status: "succeeded",
    last_error: null,
    next_scheduled_at: "2026-07-29T09:00:00.000Z",
    last_findings_generated_at:
      "2026-07-28T15:45:00.000Z",
    active_count: 4,
    archived_count: 6,
    total_count: 10,
  });
});

test("partial freshness pauses insights even when a job is still running", async () => {
  const repository = {
    async getDataFreshness() {
      return freshData({
        partial: true,
        warnings: [
          {
            code: "sync_in_progress",
            message: "A connection is still syncing.",
          },
        ],
      });
    },
    async getInsightStorageSummary() {
      return emptyInsightStorage({ active_count: 2, total_count: 2 });
    },
  };
  const jobQueue = {
    async getInsightJobStatus() {
      return {
        current: {
          type: "finance.generate_insights",
          status: "running",
        },
        latest: null,
        nextScheduledAt: null,
      };
    },
  };
  const service = createFinanceService({ repository, jobQueue });

  const status = await service.getInsightStatus();

  assert.equal(status.state, "paused");
  assert.equal(status.can_run, false);
  assert.equal(
    status.current_job_type,
    "finance.generate_insights",
  );
  assert.deepEqual(status.pause_reasons, [
    {
      code: "sync_in_progress",
      message: "A connection is still syncing.",
    },
  ]);
});

test("force run queues recurring detection with the requesting admin and a stable workspace dedupe key", async () => {
  const calls = [];
  const now = new Date("2026-07-28T16:10:00.000Z");
  const repository = {
    async getDataFreshness() {
      return freshData();
    },
    async getInsightStorageSummary() {
      return emptyInsightStorage();
    },
  };
  const jobQueue = {
    async getInsightJobStatus() {
      return {
        current: null,
        latest: null,
        nextScheduledAt: null,
      };
    },
    async enqueue(type, payload, options) {
      calls.push({ type, payload, options });
      return { id: "job-manual" };
    },
  };
  const service = createFinanceService({
    repository,
    jobQueue,
    now: () => now,
  });

  const result = await service.forceRunInsights(
    {},
    { id: "admin-1" },
  );

  assert.deepEqual(result, {
    queued: true,
    job_id: "job-manual",
    status: "queued",
  });
  assert.deepEqual(calls, [
    {
      type: "finance.detect_recurring",
      payload: {
        workspaceId: "shared",
        source: "manual",
        requestedBy: "admin-1",
      },
      options: {
        dedupeKey: "shared",
        runAt: now,
      },
    },
  ]);
});

test("force run rejects stale data without enqueueing more work", async () => {
  let enqueued = false;
  const service = createFinanceService({
    repository: {
      async getDataFreshness() {
        return freshData({
          partial: true,
          warnings: [
            {
              code: "stale_item",
              message: "Bank data is stale.",
            },
          ],
        });
      },
      async getInsightStorageSummary() {
        return emptyInsightStorage();
      },
    },
    jobQueue: {
      async getInsightJobStatus() {
        return {
          current: null,
          latest: null,
          nextScheduledAt: null,
        };
      },
      async enqueue() {
        enqueued = true;
      },
    },
  });

  await assert.rejects(
    service.forceRunInsights({}, { id: "admin-1" }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.expose, true);
      assert.match(error.message, /Bank data is stale/);
      return true;
    },
  );
  assert.equal(enqueued, false);
});

test("clearing insights reports deleted output and explicitly preserves feedback", async () => {
  const calls = [];
  const service = createFinanceService({
    repository: {
      async clearInsightOutput(workspaceId) {
        calls.push(workspaceId);
        return {
          findings_deleted: 9,
          narratives_deleted: 3,
          search_documents_deleted: 9,
        };
      },
    },
  });

  const result = await service.clearInsights();

  assert.deepEqual(calls, ["shared"]);
  assert.deepEqual(result, {
    cleared: true,
    findings_deleted: 9,
    narratives_deleted: 3,
    search_documents_deleted: 9,
    feedback_preserved: true,
    recurring_corrections_preserved: true,
  });
});
