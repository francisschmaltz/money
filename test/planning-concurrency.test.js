import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

import { PgFinanceRepository } from "../app/db/financeRepository.js";
import { PgPlanningRepository } from "../app/db/planningRepository.js";
import { PlanningService } from "../app/services/planningService.js";

function accountRepository(brokerageMinor) {
  return {
    async listAccounts() {
      return [
        {
          id: "brokerage",
          balance_group: "taxable_investment",
          current_balance_minor: brokerageMinor,
          currency_code: "USD",
          active: true,
        },
      ];
    },
    async getDataFreshness() {
      return {
        data_as_of: "2026-07-27T12:00:00.000Z",
        partial: false,
      };
    },
  };
}

function serialized(operationState, operation) {
  const result = operationState.tail.then(operation, operation);
  operationState.tail = result.catch(() => {});
  return result;
}

test("brokerage capacity is serialized across different goals", async () => {
  const goals = new Map(
    ["a", "b"].map((suffix) => [
      `goal-${suffix}`,
      {
        id: `goal-${suffix}`,
        name: `Goal ${suffix.toUpperCase()}`,
        target_amount_minor: 100,
        currency_code: "USD",
        target_on: null,
        status: "active",
        version: 1,
        allocations: [{ source: "brokerage", amount_minor: 0 }],
        schedules: [],
      },
    ]),
  );
  const lock = { tail: Promise.resolve(), entries: 0 };
  const repository = {
    async withWorkspacePlanningLock(_workspaceId, operation) {
      return serialized(lock, async () => {
        lock.entries += 1;
        return operation({ query: async () => ({ rows: [] }) });
      });
    },
    async getGoal(_workspaceId, goalId) {
      return structuredClone(goals.get(goalId) ?? null);
    },
    async listGoals() {
      return [...goals.values()].map((goal) => structuredClone(goal));
    },
    async addGoalAllocation(
      _workspaceId,
      { goalId, amountDeltaMinor, expectedVersion },
    ) {
      const goal = goals.get(goalId);
      if (goal.version !== expectedVersion) {
        return { conflict: true, current: structuredClone(goal) };
      }
      goal.allocations[0].amount_minor += amountDeltaMinor;
      goal.version += 1;
      return {
        event: { id: `allocation-${goalId}` },
        goal: structuredClone(goal),
        audit_event_id: `audit-${goalId}`,
      };
    },
  };
  const service = new PlanningService({
    repository,
    financeRepository: accountRepository(100),
  });

  const results = await Promise.allSettled([
    service.allocateFinanceGoal({
      goal_id: "goal-a",
      source: "brokerage",
      amount_minor: 80,
      expected_version: 1,
    }),
    service.allocateFinanceGoal({
      goal_id: "goal-b",
      source: "brokerage",
      amount_minor: 80,
      expected_version: 1,
    }),
  ]);

  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason.statusCode === 409,
    ).length,
    1,
  );
  assert.equal(
    [...goals.values()].reduce(
      (sum, goal) => sum + goal.allocations[0].amount_minor,
      0,
    ),
    80,
  );
  assert.equal(lock.entries, 2);
});

test("duplicate schedule workers apply and advance one occurrence once", async () => {
  const goal = {
    id: "goal-trip",
    name: "Trip",
    target_amount_minor: 100,
    currency_code: "USD",
    target_on: null,
    status: "active",
    version: 1,
    allocations: [{ source: "cash", amount_minor: 0 }],
    schedules: [],
  };
  const schedule = {
    id: "schedule-trip",
    goal_id: goal.id,
    source: "cash",
    cadence: "monthly",
    amount_minor: 100,
    monthly_day: 27,
    anchor_on: null,
    next_run_on: "2026-07-27",
    status: "active",
    version: 1,
  };
  goal.schedules = [schedule];
  const lock = { tail: Promise.resolve() };
  let listCalls = 0;
  let releaseListings;
  const listingsReady = new Promise((resolve) => {
    releaseListings = resolve;
  });
  const runs = new Set();
  const repository = {
    async getWorkspaceTimezone() {
      return "America/Los_Angeles";
    },
    async listDueGoalSchedules() {
      listCalls += 1;
      if (listCalls === 2) releaseListings();
      await listingsReady;
      return [structuredClone(schedule)];
    },
    async withWorkspacePlanningLock(_workspaceId, operation) {
      return serialized(lock, () =>
        operation({ query: async () => ({ rows: [] }) }),
      );
    },
    async lockGoalScheduleForRun(
      _workspaceId,
      { dueOn, expectedVersion },
    ) {
      const key = `${schedule.id}:${dueOn}`;
      if (runs.has(key)) return { replayed: true, status: "applied" };
      if (
        schedule.status !== "active" ||
        schedule.next_run_on !== dueOn ||
        schedule.version !== expectedVersion
      ) {
        return { stale: true, current: structuredClone(schedule) };
      }
      return { schedule: structuredClone(schedule) };
    },
    async getGoal() {
      return structuredClone(goal);
    },
    async addGoalAllocation(
      _workspaceId,
      { amountDeltaMinor, expectedVersion },
    ) {
      assert.equal(goal.version, expectedVersion);
      goal.allocations[0].amount_minor += amountDeltaMinor;
      goal.version += 1;
      return {
        event: { id: "allocation-trip" },
        goal: structuredClone(goal),
        audit_event_id: "audit-trip",
      };
    },
    async finishGoalScheduleRun(
      _workspaceId,
      current,
      { dueOn, nextRunOn, pauseSchedule },
    ) {
      const key = `${schedule.id}:${dueOn}`;
      assert.equal(runs.has(key), false);
      assert.equal(current.version, schedule.version);
      runs.add(key);
      schedule.next_run_on = nextRunOn;
      schedule.status = pauseSchedule ? "paused" : "active";
      schedule.version += 1;
      return {
        replayed: false,
        schedule: structuredClone(schedule),
      };
    },
  };
  const options = {
    repository,
    financeRepository: accountRepository(0),
    now: () => new Date("2026-07-27T12:00:00.000Z"),
  };
  const firstService = new PlanningService(options);
  const secondService = new PlanningService(options);

  const [first, second] = await Promise.all([
    firstService.processDueGoalSchedules({
      through_on: "2026-07-27",
    }),
    secondService.processDueGoalSchedules({
      through_on: "2026-07-27",
    }),
  ]);

  assert.equal(first.processed + second.processed, 1);
  assert.equal(goal.allocations[0].amount_minor, 100);
  assert.equal(runs.size, 1);
  assert.equal(schedule.status, "paused");
  assert.equal(schedule.version, 2);
});

test("PostgreSQL plan idempotency rolls the claim back with a failed mutation", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      queries.push(normalized);
      if (normalized.startsWith("INSERT INTO plan_idempotency_keys")) {
        return { rows: [{ request_hash: "hash" }] };
      }
      if (normalized.startsWith("UPDATE plan_idempotency_keys")) {
        return { rows: [{ idempotency_key: "retry-key" }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PgPlanningRepository({
    async connect() {
      return client;
    },
  });
  const input = {
    actor: { type: "openwebui", id: "openwebui" },
    operation: "create_finance_goal",
    idempotencyKey: "retry-key",
    requestHash: "hash",
  };

  await assert.rejects(
    repository.executePlanWrite("shared", input, async (transaction) => {
      await transaction.query("SELECT mutation_committed_only_with_claim");
      throw new Error("simulated process failure");
    }),
    /simulated process failure/,
  );

  assert.equal(
    queries.some((query) => query === "ROLLBACK"),
    true,
  );
  assert.equal(
    queries.some((query) =>
      query.startsWith("UPDATE plan_idempotency_keys"),
    ),
    false,
  );
  assert.equal(queries.at(-1), "ROLLBACK");
});

test("schedule writes without an ID replace the goal's one existing schedule", async () => {
  const queries = [];
  const existing = {
    id: "schedule-existing",
    workspace_id: "shared",
    goal_id: "goal-trip",
    source: "cash",
    cadence: "monthly",
    amount_minor: "100",
    monthly_day: 1,
    anchor_on: null,
    next_run_on: "2026-08-01",
    status: "active",
    version: 1,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      queries.push(normalized);
      if (
        normalized.startsWith(
          "SELECT * FROM goal_funding_schedules",
        )
      ) {
        return { rows: [existing] };
      }
      if (normalized.startsWith("UPDATE goal_funding_schedules")) {
        return {
          rows: [
            {
              ...existing,
              amount_minor: "250",
              monthly_day: 15,
              next_run_on: "2026-08-15",
              version: 2,
            },
          ],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PgPlanningRepository({
    async connect() {
      return client;
    },
  });

  const changed = await repository.upsertGoalSchedule(
    "shared",
    {
      id: "schedule-new-request-id",
      goal_id: "goal-trip",
      source: "cash",
      cadence: "monthly",
      amount_minor: 250,
      monthly_day: 15,
      anchor_on: null,
      next_run_on: "2026-08-15",
      status: "active",
    },
    1,
    { type: "member", id: "member-1" },
    "audit-schedule",
    { matchExistingGoal: true },
  );

  assert.equal(changed.schedule.id, "schedule-existing");
  assert.equal(changed.schedule.version, 2);
  assert.equal(
    queries.some((query) =>
      query.startsWith("INSERT INTO goal_funding_schedules"),
    ),
    false,
  );
  assert.equal(
    queries.some((query) =>
      query.includes("pg_advisory_xact_lock"),
    ),
    true,
  );
});

test("schedule migration deduplicates before enforcing one schedule per goal", async () => {
  const migration = await readFile(
    new URL("../migrations/012_one_goal_schedule.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /duplicate_goal_schedule_map/);
  assert.match(migration, /UPDATE goal_schedule_runs run/);
  assert.match(migration, /DELETE FROM goal_funding_schedules schedule/);
  assert.match(
    migration,
    /UNIQUE \(workspace_id, goal_id\)/,
  );
});

test(
  "PostgreSQL planning concurrency smoke test",
  { timeout: 15_000 },
  async (context) => {
    if (!process.env.DATABASE_URL) {
      context.skip("DATABASE_URL is not configured");
      return;
    }
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 6,
    });
    const suffix = randomUUID();
    const workspaceId = `planning-${suffix}`;
    const connectionId = `connection-${suffix}`;
    const accountId = `account-${suffix}`;
    const actor = { type: "openwebui", id: "openwebui" };
    try {
      await pool.query(
        `
          INSERT INTO workspaces (id, name)
          VALUES ($1, 'Planning concurrency test')
        `,
        [workspaceId],
      );
      await pool.query(
        `
          INSERT INTO finance_connections (
            id,
            workspace_id,
            provider,
            ingestion_method,
            freshness_mode,
            institution_name,
            status,
            balance_as_of
          )
          VALUES (
            $1, $2, 'apple_card', 'csv', 'manual',
            'Test brokerage', 'active', '2026-07-27'
          )
        `,
        [connectionId, workspaceId],
      );
      await pool.query(
        `
          INSERT INTO accounts (
            id,
            workspace_id,
            connection_id,
            provider_account_id,
            name,
            type,
            subtype,
            currency_code,
            current_balance_minor,
            balance_group_override
          )
          VALUES (
            $1, $2, $3, $4, 'Taxable brokerage',
            'investment', 'brokerage', 'USD', 100,
            'taxable_investment'
          )
        `,
        [accountId, workspaceId, connectionId, `provider-${suffix}`],
      );
      await pool.query(
        `
          INSERT INTO finance_goals (
            id,
            workspace_id,
            name,
            target_amount_minor,
            created_by,
            updated_by
          )
          VALUES
            ($1, $3, 'Goal A', 100, 'test', 'test'),
            ($2, $3, 'Goal B', 100, 'test', 'test')
        `,
        [`goal-a-${suffix}`, `goal-b-${suffix}`, workspaceId],
      );

      const financeRepository = new PgFinanceRepository(pool);
      const firstRepository = new PgPlanningRepository(pool);
      const secondRepository = new PgPlanningRepository(pool);
      const serviceOptions = {
        financeRepository,
        workspaceId,
        now: () => new Date("2026-07-27T12:00:00.000Z"),
      };
      const firstService = new PlanningService({
        ...serviceOptions,
        repository: firstRepository,
      });
      const secondService = new PlanningService({
        ...serviceOptions,
        repository: secondRepository,
      });
      const allocations = await Promise.allSettled([
        firstService.allocateFinanceGoal({
          goal_id: `goal-a-${suffix}`,
          source: "brokerage",
          amount_minor: 80,
          expected_version: 1,
        }),
        secondService.allocateFinanceGoal({
          goal_id: `goal-b-${suffix}`,
          source: "brokerage",
          amount_minor: 80,
          expected_version: 1,
        }),
      ]);
      assert.equal(
        allocations.filter((entry) => entry.status === "fulfilled")
          .length,
        1,
      );
      const brokerageTotal = await pool.query(
        `
          SELECT COALESCE(SUM(amount_delta_minor), 0)::bigint AS total
          FROM goal_allocation_events
          WHERE workspace_id = $1
            AND source = 'brokerage'
        `,
        [workspaceId],
      );
      assert.equal(Number(brokerageTotal.rows[0].total), 80);

      const crashGoalId = `goal-crash-${suffix}`;
      const crashWrite = {
        actor,
        operation: "create_finance_goal",
        idempotencyKey: `crash-${suffix}`,
        requestHash: "same-request",
      };
      await assert.rejects(
        firstRepository.executePlanWrite(
          workspaceId,
          crashWrite,
          async () => {
            await firstRepository.createGoal(
              workspaceId,
              {
                id: crashGoalId,
                name: "Crash recovery",
                target_amount_minor: 1_000,
                currency_code: "USD",
                target_on: null,
                audit_event_id: `audit-crash-${suffix}`,
              },
              actor,
            );
            throw new Error("crash after mutation");
          },
        ),
        /crash after mutation/,
      );
      const rolledBack = await pool.query(
        `
          SELECT
            EXISTS (
              SELECT 1 FROM finance_goals
              WHERE workspace_id = $1 AND id = $2
            ) AS goal_exists,
            EXISTS (
              SELECT 1 FROM plan_idempotency_keys
              WHERE workspace_id = $1
                AND idempotency_key = $3
            ) AS claim_exists
        `,
        [workspaceId, crashGoalId, crashWrite.idempotencyKey],
      );
      assert.equal(rolledBack.rows[0].goal_exists, false);
      assert.equal(rolledBack.rows[0].claim_exists, false);

      const retry = await firstRepository.executePlanWrite(
        workspaceId,
        crashWrite,
        async () => {
          const created = await firstRepository.createGoal(
            workspaceId,
            {
              id: crashGoalId,
              name: "Crash recovery",
              target_amount_minor: 1_000,
              currency_code: "USD",
              target_on: null,
              audit_event_id: `audit-retry-${suffix}`,
            },
            actor,
          );
          return { goal_id: created.goal.id };
        },
      );
      assert.equal(retry.executed, true);
      const replay = await secondRepository.executePlanWrite(
        workspaceId,
        crashWrite,
        async () => {
          throw new Error("replay must not execute");
        },
      );
      assert.equal(replay.replay, true);
      assert.equal(replay.response.goal_id, crashGoalId);

      const historyGoalId = `goal-history-${suffix}`;
      const historyTransactionId = `transaction-history-${suffix}`;
      const historyProviderId = `provider-history-${suffix}`;
      await pool.query(
        `
          INSERT INTO finance_goals (
            id,
            workspace_id,
            name,
            purpose,
            target_amount_minor,
            status,
            version,
            archived_at,
            archive_outcome,
            created_by,
            updated_by
          )
          VALUES (
            $1, $2, 'Finished trip', 'vacation', 100,
            'archived', 2, now(), 'cancelled', 'test', 'test'
          )
        `,
        [historyGoalId, workspaceId],
      );
      await pool.query(
        `
          INSERT INTO transactions (
            id,
            workspace_id,
            account_id,
            provider_transaction_id,
            name,
            amount_minor,
            posted_on
          )
          VALUES ($1, $2, $3, $4, 'Hotel', -100, '2026-07-27')
        `,
        [
          historyTransactionId,
          workspaceId,
          accountId,
          historyProviderId,
        ],
      );
      await pool.query(
        `
          INSERT INTO goal_transaction_spends (
            id,
            workspace_id,
            transaction_id,
            transaction_provider_id,
            goal_id,
            source,
            line_index,
            amount_minor,
            created_by,
            updated_by
          )
          VALUES (
            $1, $2, $3, $4, $5,
            'cash', 0, 100, 'test', 'test'
          )
        `,
        [
          `goal-spend-history-${suffix}`,
          workspaceId,
          historyTransactionId,
          historyProviderId,
          historyGoalId,
        ],
      );

      await pool.query(
        `
          UPDATE transactions
          SET pending = true
          WHERE workspace_id = $1 AND id = $2
        `,
        [workspaceId, historyTransactionId],
      );
      const reactivated = await pool.query(
        `
          SELECT status, archived_at, archive_outcome
          FROM finance_goals
          WHERE workspace_id = $1 AND id = $2
        `,
        [workspaceId, historyGoalId],
      );
      assert.equal(reactivated.rows[0].status, "active");
      assert.equal(reactivated.rows[0].archived_at, null);
      assert.equal(reactivated.rows[0].archive_outcome, null);

      const reactivationAudit = await pool.query(
        `
          SELECT before_value, after_value
          FROM plan_audit_events
          WHERE workspace_id = $1
            AND subject_id = $2
            AND event_type =
              'goal.reactivated_after_spend_invalidation'
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `,
        [workspaceId, historyGoalId],
      );
      assert.equal(
        reactivationAudit.rows[0].before_value.archive_outcome,
        "cancelled",
      );
      assert.equal(
        reactivationAudit.rows[0].after_value.archive_outcome,
        null,
      );
    } finally {
      await pool
        .query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId])
        .catch(() => {});
      await pool.end();
    }
  },
);
