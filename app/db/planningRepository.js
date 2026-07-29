import { AsyncLocalStorage } from "node:async_hooks";

import { withTransaction } from "./pool.js";

const DEFAULT_WORKSPACE_ID = "shared";

export class PgPlanningRepository {
  #pool;
  #transactionContext = new AsyncLocalStorage();

  constructor(pool) {
    if (!pool) throw new TypeError("pool is required");
    this.#pool = pool;
  }

  #client() {
    return this.#transactionContext.getStore()?.client ?? this.#pool;
  }

  async #withTransaction(operation) {
    const existing = this.#transactionContext.getStore();
    if (existing) return operation(existing.client);
    return withTransaction(this.#pool, (client) =>
      this.#transactionContext.run(
        { client, workspaceLocks: new Set() },
        () => operation(client),
      ),
    );
  }

  async withWorkspacePlanningLock(workspaceId, operation) {
    return this.#withTransaction(async (client) => {
      const context = this.#transactionContext.getStore();
      if (!context.workspaceLocks.has(workspaceId)) {
        await client.query(
          `
            SELECT pg_advisory_xact_lock(
              hashtextextended('money:planning:' || $1, 0)
            )
          `,
          [workspaceId],
        );
        context.workspaceLocks.add(workspaceId);
      }
      return operation(client);
    });
  }

  async executePlanWrite(
    workspaceId,
    { actor, operation, idempotencyKey, requestHash },
    mutation,
  ) {
    return this.#withTransaction(async (client) => {
      const inserted = await client.query(
        `
          INSERT INTO plan_idempotency_keys (
            workspace_id,
            actor_type,
            actor_id,
            operation,
            idempotency_key,
            request_hash
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT DO NOTHING
          RETURNING request_hash
        `,
        [
          workspaceId,
          actor.type,
          actor.id,
          operation,
          idempotencyKey,
          requestHash,
        ],
      );
      if (!inserted.rows[0]) {
        const existing = await client.query(
          `
            SELECT request_hash, response_value
            FROM plan_idempotency_keys
            WHERE workspace_id = $1
              AND actor_type = $2
              AND actor_id = $3
              AND operation = $4
              AND idempotency_key = $5
            FOR UPDATE
          `,
          [
            workspaceId,
            actor.type,
            actor.id,
            operation,
            idempotencyKey,
          ],
        );
        const row = existing.rows[0];
        if (!row || row.request_hash !== requestHash) {
          return { mismatch: true };
        }
        if (row.response_value != null) {
          return { replay: true, response: row.response_value };
        }
        // Rows created by the pre-atomic implementation cannot be retried
        // safely: the old process may have committed the mutation before it
        // died. Keep them blocked instead of guessing and duplicating money.
        return { pending: true };
      }

      const response = await mutation(client);
      const completed = await client.query(
        `
          UPDATE plan_idempotency_keys
          SET response_value = $7::jsonb, completed_at = now()
          WHERE workspace_id = $1
            AND actor_type = $2
            AND actor_id = $3
            AND operation = $4
            AND idempotency_key = $5
            AND request_hash = $6
            AND response_value IS NULL
          RETURNING idempotency_key
        `,
        [
          workspaceId,
          actor.type,
          actor.id,
          operation,
          idempotencyKey,
          requestHash,
          JSON.stringify(response),
        ],
      );
      if (!completed.rows[0]) {
        throw new Error("Idempotent plan write could not be completed.");
      }
      return { executed: true, response };
    });
  }

  async getWorkspaceTimezone(workspaceId = DEFAULT_WORKSPACE_ID) {
    const result = await this.#client().query(
      `SELECT timezone FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    return result.rows[0]?.timezone ?? "America/Los_Angeles";
  }

  async claimPlanWrite(
    workspaceId,
    { actor, operation, idempotencyKey, requestHash },
  ) {
    return this.#withTransaction(async (client) => {
      const inserted = await client.query(
        `
          INSERT INTO plan_idempotency_keys (
            workspace_id,
            actor_type,
            actor_id,
            operation,
            idempotency_key,
            request_hash
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT DO NOTHING
          RETURNING request_hash
        `,
        [
          workspaceId,
          actor.type,
          actor.id,
          operation,
          idempotencyKey,
          requestHash,
        ],
      );
      if (inserted.rows[0]) return { claimed: true };
      const existing = await client.query(
        `
          SELECT request_hash, response_value
          FROM plan_idempotency_keys
          WHERE workspace_id = $1
            AND actor_type = $2
            AND actor_id = $3
            AND operation = $4
            AND idempotency_key = $5
          FOR UPDATE
        `,
        [
          workspaceId,
          actor.type,
          actor.id,
          operation,
          idempotencyKey,
        ],
      );
      const row = existing.rows[0];
      if (!row || row.request_hash !== requestHash) {
        return { mismatch: true };
      }
      if (row.response_value != null) {
        return { replay: true, response: row.response_value };
      }
      return { pending: true };
    });
  }

  async completePlanWrite(
    workspaceId,
    { actor, operation, idempotencyKey, requestHash, response },
  ) {
    const result = await this.#client().query(
      `
        UPDATE plan_idempotency_keys
        SET response_value = $7::jsonb, completed_at = now()
        WHERE workspace_id = $1
          AND actor_type = $2
          AND actor_id = $3
          AND operation = $4
          AND idempotency_key = $5
          AND request_hash = $6
          AND response_value IS NULL
        RETURNING idempotency_key
      `,
      [
        workspaceId,
        actor.type,
        actor.id,
        operation,
        idempotencyKey,
        requestHash,
        JSON.stringify(response),
      ],
    );
    if (!result.rows[0]) {
      throw new Error("Idempotent plan write could not be completed.");
    }
  }

  async releasePlanWrite(
    workspaceId,
    { actor, operation, idempotencyKey, requestHash },
  ) {
    await this.#client().query(
      `
        DELETE FROM plan_idempotency_keys
        WHERE workspace_id = $1
          AND actor_type = $2
          AND actor_id = $3
          AND operation = $4
          AND idempotency_key = $5
          AND request_hash = $6
          AND response_value IS NULL
      `,
      [
        workspaceId,
        actor.type,
        actor.id,
        operation,
        idempotencyKey,
        requestHash,
      ],
    );
  }

  async listGoals(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { includeArchived = false } = {},
    client = null,
  ) {
    const result = await (client ?? this.#client()).query(
      `
        SELECT
          goal.*,
          COALESCE(
            recorded_allocation.recorded_allocations,
            '[]'::jsonb
          ) AS recorded_allocations,
          COALESCE(spending.spending, '[]'::jsonb) AS spending,
          COALESCE(schedule.schedules, '[]'::jsonb) AS schedules
        FROM finance_goals goal
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(
            jsonb_build_object(
              'source', grouped.source,
              'amount_minor', grouped.amount_minor
            )
            ORDER BY grouped.source
          ) AS recorded_allocations
          FROM (
            SELECT source, SUM(amount_delta_minor)::bigint AS amount_minor
            FROM goal_allocation_events
            WHERE goal_id = goal.id
            GROUP BY source
          ) grouped
        ) recorded_allocation ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(
            jsonb_build_object(
              'source', grouped.source,
              'amount_minor', grouped.amount_minor
            )
            ORDER BY grouped.source
          ) AS spending
          FROM (
            SELECT source, SUM(amount_minor)::bigint AS amount_minor
            FROM goal_transaction_spends
            WHERE goal_id = goal.id
              AND status = 'active'
            GROUP BY source
          ) grouped
        ) spending ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', funding.id,
              'goal_id', funding.goal_id,
              'source', funding.source,
              'cadence', funding.cadence,
              'amount_minor', funding.amount_minor,
              'monthly_day', funding.monthly_day,
              'anchor_on', funding.anchor_on,
              'next_run_on', funding.next_run_on,
              'status', funding.status,
              'version', funding.version
            )
            ORDER BY funding.created_at, funding.id
          ) AS schedules
          FROM goal_funding_schedules funding
          WHERE funding.goal_id = goal.id
        ) schedule ON true
        WHERE goal.workspace_id = $1
          AND ($2::boolean OR goal.status = 'active')
        ORDER BY
          (goal.status = 'active') DESC,
          goal.target_on NULLS LAST,
          goal.created_at,
          goal.id
      `,
      [workspaceId, includeArchived],
    );
    return result.rows.map(mapGoal);
  }

  async getGoal(
    workspaceId = DEFAULT_WORKSPACE_ID,
    goalId,
    client = null,
  ) {
    const goals = await this.listGoals(
      workspaceId,
      { includeArchived: true },
      client,
    );
    return goals.find((goal) => goal.id === goalId) ?? null;
  }

  async createGoal(workspaceId, goal, actor) {
    return this.#withTransaction(async (client) => {
      const result = await client.query(
        `
          INSERT INTO finance_goals (
            id,
            workspace_id,
            name,
            purpose,
            target_amount_minor,
            currency_code,
            target_on,
            created_by,
            updated_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
          RETURNING *
        `,
        [
          goal.id,
          workspaceId,
          goal.name,
          goal.purpose ?? "other",
          goal.target_amount_minor,
          goal.currency_code,
          goal.target_on,
          actor.id,
        ],
      );
      const created = mapGoal({
        ...result.rows[0],
        recorded_allocations: [],
        spending: [],
        schedules: [],
      });
      const auditEventId = await insertAudit(client, {
        id: goal.audit_event_id,
        workspaceId,
        eventType: "goal.created",
        subjectType: "goal",
        subjectId: goal.id,
        actor,
        before: null,
        after: created,
      });
      return {
        before: null,
        after: created,
        goal: created,
        audit_event_id: auditEventId,
      };
    });
  }

  async updateGoal(workspaceId, goalId, changes, expectedVersion, actor, ids) {
    return this.#withTransaction(async (client) => {
      const before = await this.getGoal(workspaceId, goalId, client);
      if (!before) return null;
      const result = await client.query(
        `
          UPDATE finance_goals
          SET
            name = COALESCE($3, name),
            purpose = COALESCE($4, purpose),
            target_amount_minor = COALESCE($5, target_amount_minor),
            target_on = CASE WHEN $6::boolean THEN $7::date ELSE target_on END,
            updated_by = $8,
            updated_at = now(),
            version = version + 1
          WHERE workspace_id = $1
            AND id = $2
            AND status = 'active'
            AND version = $9
          RETURNING *
        `,
        [
          workspaceId,
          goalId,
          changes.name ?? null,
          changes.purpose ?? null,
          changes.target_amount_minor ?? null,
          Object.hasOwn(changes, "target_on"),
          changes.target_on ?? null,
          actor.id,
          expectedVersion,
        ],
      );
      if (!result.rows[0]) return { conflict: true, current: before };
      const after = await this.getGoal(workspaceId, goalId, client);
      const auditEventId = await insertAudit(client, {
        id: ids.auditEventId,
        workspaceId,
        eventType: "goal.updated",
        subjectType: "goal",
        subjectId: goalId,
        actor,
        before,
        after,
      });
      return {
        before,
        after,
        goal: after,
        audit_event_id: auditEventId,
      };
    });
  }

  async archiveGoal(workspaceId, goalId, expectedVersion, actor, ids) {
    return this.#withTransaction(async (client) => {
      const before = await this.getGoal(workspaceId, goalId, client);
      if (!before) return null;
      const result = await client.query(
        `
          UPDATE finance_goals
          SET
            status = 'archived',
            archived_at = now(),
            archive_outcome = COALESCE($5, 'completed'),
            updated_by = $3,
            updated_at = now(),
            version = version + 1
          WHERE workspace_id = $1
            AND id = $2
            AND status = 'active'
            AND version = $4
          RETURNING id
        `,
        [
          workspaceId,
          goalId,
          actor.id,
          expectedVersion,
          ids.outcome ?? null,
        ],
      );
      if (!result.rows[0]) return { conflict: true, current: before };
      await client.query(
        `
          UPDATE goal_funding_schedules
          SET
            status = 'paused',
            updated_by = $3,
            updated_at = now(),
            version = version + 1
          WHERE workspace_id = $1
            AND goal_id = $2
            AND status = 'active'
        `,
        [workspaceId, goalId, actor.id],
      );
      const after = await this.getGoal(workspaceId, goalId, client);
      const auditEventId = await insertAudit(client, {
        id: ids.auditEventId,
        workspaceId,
        eventType: "goal.finished",
        subjectType: "goal",
        subjectId: goalId,
        actor,
        before,
        after,
      });
      return {
        before,
        after,
        goal: after,
        audit_event_id: auditEventId,
      };
    });
  }

  async addGoalAllocation(
    workspaceId,
    {
      id,
      goalId,
      source,
      amountDeltaMinor,
      idempotencyKey,
      expectedVersion,
      auditEventId,
    },
    actor,
  ) {
    return this.#withTransaction(async (client) => {
      if (idempotencyKey) {
        const existing = await client.query(
          `
            SELECT id, goal_id, source, amount_delta_minor, created_at
            FROM goal_allocation_events
            WHERE workspace_id = $1
              AND actor_type = $2
              AND actor_id = $3
              AND idempotency_key = $4
          `,
          [workspaceId, actor.type, actor.id, idempotencyKey],
        );
        if (existing.rows[0]) {
          return {
            replayed: true,
            event: mapAllocation(existing.rows[0]),
            goal: await this.getGoal(
              workspaceId,
              existing.rows[0].goal_id,
              client,
            ),
          };
        }
      }
      const before = await this.getGoal(workspaceId, goalId, client);
      if (!before) return null;
      const version = await client.query(
        `
          UPDATE finance_goals
          SET updated_by = $3, updated_at = now(), version = version + 1
          WHERE workspace_id = $1
            AND id = $2
            AND status = 'active'
            AND version = $4
          RETURNING version
        `,
        [workspaceId, goalId, actor.id, expectedVersion],
      );
      if (!version.rows[0]) return { conflict: true, current: before };
      const result = await client.query(
        `
          INSERT INTO goal_allocation_events (
            id,
            workspace_id,
            goal_id,
            source,
            amount_delta_minor,
            idempotency_key,
            actor_type,
            actor_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *
        `,
        [
          id,
          workspaceId,
          goalId,
          source,
          amountDeltaMinor,
          idempotencyKey,
          actor.type,
          actor.id,
        ],
      );
      const after = await this.getGoal(workspaceId, goalId, client);
      const event = mapAllocation(result.rows[0]);
      const auditId = await insertAudit(client, {
        id: auditEventId,
        workspaceId,
        eventType:
          amountDeltaMinor > 0
            ? "goal.allocation_added"
            : "goal.allocation_released",
        subjectType: "goal",
        subjectId: goalId,
        actor,
        before,
        after,
      });
      return {
        before,
        after,
        event,
        goal: after,
        audit_event_id: auditId,
      };
    });
  }

  async upsertGoalSchedule(
    workspaceId,
    schedule,
    expectedVersion,
    actor,
    auditEventId,
    { matchExistingGoal = false } = {},
  ) {
    return this.withWorkspacePlanningLock(workspaceId, async (client) => {
      const existing = await client.query(
        `
          SELECT *
          FROM goal_funding_schedules
          WHERE workspace_id = $1
            AND (
              id = $2
              OR goal_id = $3
            )
          ORDER BY (id = $2) DESC, updated_at DESC, id DESC
          LIMIT 1
          FOR UPDATE
        `,
        [
          workspaceId,
          schedule.id,
          schedule.goal_id,
        ],
      );
      const before = existing.rows[0]
        ? mapSchedule(existing.rows[0])
        : null;
      if (before && before.goal_id !== schedule.goal_id) {
        return { conflict: true, current: before };
      }
      if (
        before &&
        (!matchExistingGoal && before.id !== schedule.id)
      ) {
        return { conflict: true, current: before };
      }
      if (
        before &&
        (expectedVersion == null || before.version !== expectedVersion)
      ) {
        return { conflict: true, current: before };
      }
      const result = before
        ? await client.query(
            `
              UPDATE goal_funding_schedules
              SET
                source = $3,
                cadence = $4,
                amount_minor = $5,
                monthly_day = $6,
                anchor_on = $7,
                next_run_on = $8,
                status = $9,
                updated_by = $10,
                updated_at = now(),
                version = version + 1
              WHERE workspace_id = $1
                AND id = $2
                AND version = $11
              RETURNING *
            `,
            [
              workspaceId,
              before.id,
              schedule.source,
              schedule.cadence,
              schedule.amount_minor,
              schedule.monthly_day,
              schedule.anchor_on,
              schedule.next_run_on,
              schedule.status,
              actor.id,
              expectedVersion,
            ],
          )
        : await client.query(
            `
              INSERT INTO goal_funding_schedules (
                id,
                workspace_id,
                goal_id,
                source,
                cadence,
                amount_minor,
                monthly_day,
                anchor_on,
                next_run_on,
                status,
                created_by,
                updated_by
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
              RETURNING *
            `,
            [
              schedule.id,
              workspaceId,
              schedule.goal_id,
              schedule.source,
              schedule.cadence,
              schedule.amount_minor,
              schedule.monthly_day,
              schedule.anchor_on,
              schedule.next_run_on,
              schedule.status,
              actor.id,
            ],
          );
      if (!result.rows[0]) {
        return { conflict: true, current: before };
      }
      const after = mapSchedule(result.rows[0]);
      const auditId = await insertAudit(client, {
        id: auditEventId,
        workspaceId,
        eventType: before ? "goal.schedule_updated" : "goal.schedule_created",
        subjectType: "goal_schedule",
        subjectId: after.id,
        actor,
        before,
        after,
      });
      return {
        before,
        after,
        schedule: after,
        audit_event_id: auditId,
      };
    });
  }

  async listDueGoalSchedules(
    workspaceId = DEFAULT_WORKSPACE_ID,
    throughOn,
  ) {
    const result = await this.#client().query(
      `
        SELECT schedule.*, goal.status AS goal_status
        FROM goal_funding_schedules schedule
        JOIN finance_goals goal ON goal.id = schedule.goal_id
        WHERE schedule.workspace_id = $1
          AND schedule.status = 'active'
          AND schedule.next_run_on <= $2
        ORDER BY schedule.next_run_on, schedule.id
      `,
      [workspaceId, throughOn],
    );
    return result.rows.map((row) => ({
      ...mapSchedule(row),
      goal_status: row.goal_status,
    }));
  }

  async lockGoalScheduleForRun(
    workspaceId,
    { scheduleId, dueOn, throughOn, expectedVersion },
  ) {
    const client = this.#transactionContext.getStore()?.client;
    if (!client) {
      throw new Error(
        "lockGoalScheduleForRun requires a planning transaction.",
      );
    }
    const scheduleResult = await client.query(
      `
        SELECT schedule.*, goal.status AS goal_status
        FROM goal_funding_schedules schedule
        JOIN finance_goals goal ON goal.id = schedule.goal_id
        WHERE schedule.workspace_id = $1
          AND schedule.id = $2
        FOR UPDATE OF schedule
      `,
      [workspaceId, scheduleId],
    );
    if (!scheduleResult.rows[0]) return { missing: true };
    const current = {
      ...mapSchedule(scheduleResult.rows[0]),
      goal_status: scheduleResult.rows[0].goal_status,
    };
    const existingRun = await client.query(
      `
        SELECT id, status
        FROM goal_schedule_runs
        WHERE workspace_id = $1
          AND schedule_id = $2
          AND due_on = $3
      `,
      [workspaceId, scheduleId, dueOn],
    );
    if (existingRun.rows[0]) {
      return {
        replayed: true,
        run_id: existingRun.rows[0].id,
        status: existingRun.rows[0].status,
        current,
      };
    }
    if (
      current.status !== "active" ||
      current.next_run_on !== dueOn ||
      current.next_run_on > throughOn ||
      current.version !== expectedVersion
    ) {
      return { stale: true, current };
    }
    return { schedule: current };
  }

  async finishGoalScheduleRun(
    workspaceId,
    schedule,
    {
      runId,
      dueOn,
      status,
      allocationEventId = null,
      detail = {},
      nextRunOn,
      pauseSchedule = false,
      actorId = "goal-scheduler",
    },
  ) {
    return this.#withTransaction(async (client) => {
      const inserted = await client.query(
        `
          INSERT INTO goal_schedule_runs (
            id,
            workspace_id,
            schedule_id,
            due_on,
            status,
            allocation_event_id,
            detail
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (schedule_id, due_on) DO NOTHING
          RETURNING id
        `,
        [
          runId,
          workspaceId,
          schedule.id,
          dueOn,
          status,
          allocationEventId,
          detail,
        ],
      );
      if (!inserted.rows[0]) return { replayed: true };
      const advanced = await client.query(
        `
          UPDATE goal_funding_schedules
          SET
            next_run_on = $3,
            status = CASE WHEN $4::boolean THEN 'paused' ELSE status END,
            updated_by = $7,
            updated_at = now(),
            version = version + 1
          WHERE workspace_id = $1
            AND id = $2
            AND status = 'active'
            AND next_run_on = $5
            AND version = $6
          RETURNING *
        `,
        [
          workspaceId,
          schedule.id,
          nextRunOn,
          pauseSchedule,
          dueOn,
          schedule.version,
          actorId,
        ],
      );
      if (!advanced.rows[0]) {
        throw new Error(
          "Goal schedule changed while its due run was being applied.",
        );
      }
      return {
        replayed: false,
        run_id: runId,
        schedule: mapSchedule(advanced.rows[0]),
      };
    });
  }

  async listGoalScheduleRuns(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { limit = 30 } = {},
  ) {
    const result = await this.#client().query(
      `
        SELECT run.*, schedule.goal_id, schedule.source
        FROM goal_schedule_runs run
        JOIN goal_funding_schedules schedule ON schedule.id = run.schedule_id
        WHERE run.workspace_id = $1
        ORDER BY run.created_at DESC, run.id DESC
        LIMIT $2
      `,
      [workspaceId, Math.max(1, Math.min(100, Number(limit) || 30))],
    );
    return result.rows.map((row) => ({
      id: row.id,
      schedule_id: row.schedule_id,
      goal_id: row.goal_id,
      source: row.source,
      due_on: String(row.due_on),
      status: row.status,
      detail: row.detail ?? {},
      created_at: dateValue(row.created_at),
    }));
  }

  async listResolvedBudgetLines(
    workspaceId = DEFAULT_WORKSPACE_ID,
    monthOn,
    client = null,
    { includeExact = true } = {},
  ) {
    const result = await (client ?? this.#client()).query(
      `
        WITH default_candidates AS (
          SELECT
            active_spending_category_id(
              workspace_id,
              category_id
            ) AS category_id,
            spending_category_name_for_id(
              workspace_id,
              category_id
            ) AS category,
            amount_minor,
            currency_code,
            effective_month_on,
            tracking_mode,
            is_removed
          FROM budget_default_revisions
          WHERE workspace_id = $1
            AND effective_month_on <= $2
        ),
        defaults AS (
          SELECT DISTINCT ON (category_id) *
          FROM default_candidates
          ORDER BY category_id, effective_month_on DESC
        ),
        overrides AS (
          SELECT
            active_spending_category_id(
              workspace_id,
              category_id
            ) AS category_id,
            spending_category_name_for_id(
              workspace_id,
              category_id
            ) AS category,
            amount_minor,
            currency_code,
            tracking_mode
          FROM budget_lines
          WHERE workspace_id = $1
            AND month_on = $2
            AND $3::boolean
        )
        SELECT
          COALESCE(
            overrides.category_id,
            defaults.category_id
          ) AS category_id,
          COALESCE(overrides.category, defaults.category) AS category,
          COALESCE(overrides.amount_minor, defaults.amount_minor) AS amount_minor,
          COALESCE(overrides.currency_code, defaults.currency_code) AS currency_code,
          COALESCE(
            overrides.tracking_mode,
            defaults.tracking_mode,
            'tracked'
          ) AS tracking_mode,
          (overrides.category IS NOT NULL) AS exact_month,
          defaults.effective_month_on,
          COALESCE(category_version.version, 0) AS version
        FROM defaults
        FULL OUTER JOIN overrides USING (category_id)
        LEFT JOIN budget_category_versions category_version
          ON category_version.workspace_id = $1
         AND category_version.category_id = COALESCE(
           overrides.category_id,
           defaults.category_id
         )
        WHERE COALESCE(defaults.is_removed, false) = false
          OR overrides.category_id IS NOT NULL
        ORDER BY category
      `,
      [workspaceId, monthOn, includeExact],
    );
    return result.rows.map(mapBudgetLine);
  }

  async listBudgetCategoryVersions(
    workspaceId = DEFAULT_WORKSPACE_ID,
  ) {
    const result = await this.#client().query(
      `
        SELECT
          active_spending_category_id(
            workspace_id,
            category_id
          ) AS category_id,
          spending_category_name_for_id(
            workspace_id,
            category_id
          ) AS category,
          version
        FROM budget_category_versions
        WHERE workspace_id = $1
        ORDER BY category
      `,
      [workspaceId],
    );
    return result.rows.map((row) => ({
      category_id: row.category_id,
      category: row.category,
      version: Number(row.version),
    }));
  }

  async ensureBudgetMonthSnapshot(
    workspaceId,
    monthOn,
    actorId = "budget-snapshot",
  ) {
    return this.#withTransaction(async (client) => {
      const inserted = await client.query(
        `
          INSERT INTO budget_months (
            workspace_id, month_on, created_by
          )
          VALUES ($1, $2, $3)
          ON CONFLICT (workspace_id, month_on) DO NOTHING
          RETURNING month_on
        `,
        [workspaceId, monthOn, actorId],
      );
      if (!inserted.rows[0]) return { created: false };
      await client.query(
        `
          INSERT INTO budget_lines (
            workspace_id,
            month_on,
            category,
            category_id,
            amount_minor,
            currency_code,
            tracking_mode,
            updated_by
          )
          SELECT
            $1,
            $2,
            resolved.category,
            resolved.category_id,
            resolved.amount_minor,
            resolved.currency_code,
            resolved.tracking_mode,
            $3
          FROM (
            SELECT DISTINCT ON (category_id)
              category_id,
              spending_category_name_for_id(
                workspace_id,
                category_id
              ) AS category,
              amount_minor,
              currency_code,
              tracking_mode,
              is_removed
            FROM budget_default_revisions
            WHERE workspace_id = $1
              AND effective_month_on <= $2
            ORDER BY category_id, effective_month_on DESC
          ) resolved
          WHERE resolved.is_removed = false
          ON CONFLICT (workspace_id, month_on, category_id) DO NOTHING
        `,
        [workspaceId, monthOn, actorId],
      );
      return { created: true };
    });
  }

  async setBudgetLine(
    workspaceId,
    {
      monthOn,
      effectiveMonthOn,
      category,
      categoryId = null,
      amountMinor,
      trackingMode = "tracked",
      scope,
      expectedVersion,
      auditEventId,
    },
    actor,
  ) {
    return this.withWorkspacePlanningLock(workspaceId, async (client) => {
      const isRevision = scope !== "month";
      const table = isRevision
        ? "budget_default_revisions"
        : "budget_lines";
      const dateColumn = isRevision ? "effective_month_on" : "month_on";
      const dateValueInput = isRevision ? effectiveMonthOn : monthOn;
      const versionResult = await client.query(
        `
          SELECT version
          FROM budget_category_versions
          WHERE workspace_id = $1
            AND category_id = COALESCE(
              active_spending_category_id($1, $2),
              spending_category_id_for_label($1, $3)
            )
          FOR UPDATE
        `,
        [workspaceId, categoryId, category],
      );
      const currentVersion = Number(
        versionResult.rows[0]?.version ?? 0,
      );
      if (currentVersion !== expectedVersion) {
        const currentLines = await this.listResolvedBudgetLines(
          workspaceId,
          dateValueInput,
          client,
          { includeExact: scope === "month" },
        );
        return {
          conflict: true,
          current:
            currentLines.find(
              (line) =>
                line.category_id ===
                (categoryId ??
                  versionResult.rows[0]?.category_id),
            ) ??
            currentLines.find((line) => line.category === category) ?? {
              category,
              category_id: categoryId,
              amount_minor: null,
              currency_code: "USD",
              version: currentVersion,
            },
        };
      }
      if (!isRevision) {
        await client.query(
          `
            INSERT INTO budget_months (
              workspace_id, month_on, created_by
            )
            VALUES ($1, $2, $3)
            ON CONFLICT (workspace_id, month_on)
            DO UPDATE SET updated_at = now()
          `,
          [workspaceId, monthOn, actor.id],
        );
      }
      let beforeValue;
      if (isRevision) {
        beforeValue =
          (
            await this.listResolvedBudgetLines(
              workspaceId,
              dateValueInput,
              client,
              { includeExact: false },
            )
          ).find(
            (line) =>
              line.category_id === categoryId ||
              (!categoryId && line.category === category),
          ) ?? null;
      } else {
        const before = await client.query(
          `
            SELECT
              spending_category_name_for_id(
                workspace_id,
                category_id
              ) AS category,
              active_spending_category_id(
                workspace_id,
                category_id
              ) AS category_id,
              amount_minor,
              currency_code,
              tracking_mode
            FROM ${table}
            WHERE workspace_id = $1
              AND ${dateColumn} = $2
              AND category_id = COALESCE(
                active_spending_category_id($1, $3),
                spending_category_id_for_label($1, $4)
              )
          `,
          [workspaceId, dateValueInput, categoryId, category],
        );
        beforeValue = before.rows[0]
          ? mapBudgetLine({
              ...before.rows[0],
              version: currentVersion,
            })
          : null;
      }
      const result = await client.query(
        `
            INSERT INTO ${table} (
              workspace_id,
              ${dateColumn},
              category,
              category_id,
              amount_minor,
              currency_code,
              tracking_mode,
              ${isRevision ? "is_removed," : ""}
              updated_by
            )
          VALUES (
            $1, $2, $3,
            COALESCE(
              active_spending_category_id($1, $4),
              spending_category_id_for_label($1, $3)
            ),
            $5, 'USD', $6,
            ${isRevision ? "false," : ""}
            $7
          )
          ON CONFLICT (workspace_id, category_id, ${dateColumn})
          DO UPDATE SET
            amount_minor = EXCLUDED.amount_minor,
            category = EXCLUDED.category,
            tracking_mode = EXCLUDED.tracking_mode,
            ${isRevision ? "is_removed = false," : ""}
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
          RETURNING
            spending_category_name_for_id(
              workspace_id,
              category_id
            ) AS category,
            active_spending_category_id(
              workspace_id,
              category_id
            ) AS category_id,
            amount_minor,
            currency_code,
            tracking_mode
        `,
        [
          workspaceId,
          dateValueInput,
          category,
          categoryId,
          amountMinor,
          trackingMode,
          actor.id,
        ],
      );
      const version = await client.query(
        `
          INSERT INTO budget_category_versions (
            workspace_id, category, category_id, version
          )
          VALUES (
            $1,
            $2,
            COALESCE(
              active_spending_category_id($1, $3),
              spending_category_id_for_label($1, $2)
            ),
            1
          )
          ON CONFLICT (workspace_id, category_id)
          DO UPDATE SET
            category = EXCLUDED.category,
            version = budget_category_versions.version + 1,
            updated_at = now()
          RETURNING category_id, version
        `,
        [workspaceId, category, categoryId],
      );
      const after = mapBudgetLine({
        ...result.rows[0],
        version: version.rows[0].version,
      });
      const auditId = await insertAudit(client, {
        id: auditEventId,
        workspaceId,
        eventType:
          scope === "standing"
            ? "budget.standing_set"
            : scope === "future_default"
              ? "budget.default_set"
              : "budget.month_set",
        subjectType: "budget_line",
        subjectId: `${dateValueInput}:${after.category_id}`,
        actor,
        before: beforeValue,
        after,
      });
      return {
        before: beforeValue,
        after,
        line: after,
        audit_event_id: auditId,
      };
    });
  }

  async removeBudgetLine(
    workspaceId,
    {
      effectiveMonthOn,
      categoryId,
      expectedVersion,
      auditEventId,
    },
    actor,
  ) {
    return this.withWorkspacePlanningLock(workspaceId, async (client) => {
      const categoryResult = await client.query(
        `
          SELECT
            category.id,
            spending_category_name_for_id(
              category.workspace_id,
              category.id
            ) AS category
          FROM spending_categories category
          WHERE category.workspace_id = $1
            AND category.id = active_spending_category_id($1, $2)
        `,
        [workspaceId, categoryId],
      );
      const target = categoryResult.rows[0];
      if (!target) return null;
      const versionResult = await client.query(
        `
          SELECT version
          FROM budget_category_versions
          WHERE workspace_id = $1 AND category_id = $2
          FOR UPDATE
        `,
        [workspaceId, target.id],
      );
      const currentVersion = Number(versionResult.rows[0]?.version ?? 0);
      if (currentVersion !== expectedVersion) {
        return { conflict: true, current_version: currentVersion };
      }
      const descendants = await client.query(
        `
          SELECT descendant.category_id
          FROM spending_category_descendant_ids($1, $2) descendant
          JOIN budget_default_revisions revision
            ON revision.workspace_id = $1
           AND revision.category_id = descendant.category_id
          GROUP BY descendant.category_id
        `,
        [workspaceId, target.id],
      );
      const descendantIds = new Set(
        descendants.rows.map((entry) => entry.category_id),
      );
      const before = (
        await this.listResolvedBudgetLines(
          workspaceId,
          effectiveMonthOn,
          client,
          { includeExact: false },
        )
      ).filter((line) => descendantIds.has(line.category_id));
      if (
        !before.some((line) => line.category_id === target.id)
      ) {
        return { noop: true, audit_event_id: null };
      }
      for (const entry of descendants.rows) {
        const path = await client.query(
          `SELECT spending_category_name_for_id($1, $2) AS category`,
          [workspaceId, entry.category_id],
        );
        await client.query(
          `
            INSERT INTO budget_default_revisions (
              workspace_id, category, category_id, effective_month_on,
              amount_minor, currency_code, tracking_mode, is_removed,
              updated_by
            )
            VALUES ($1, $2, $3, $4, 0, 'USD', 'tracked', true, $5)
            ON CONFLICT (
              workspace_id, category_id, effective_month_on
            )
            DO UPDATE SET
              category = EXCLUDED.category,
              amount_minor = 0,
              tracking_mode = 'tracked',
              is_removed = true,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()
          `,
          [
            workspaceId,
            path.rows[0]?.category ?? target.category,
            entry.category_id,
            effectiveMonthOn,
            actor.id,
          ],
        );
        await client.query(
          `
            INSERT INTO budget_category_versions (
              workspace_id, category, category_id, version
            )
            VALUES ($1, $2, $3, 1)
            ON CONFLICT (workspace_id, category_id)
            DO UPDATE SET
              category = EXCLUDED.category,
              version = budget_category_versions.version + 1,
              updated_at = now()
          `,
          [
            workspaceId,
            path.rows[0]?.category ?? target.category,
            entry.category_id,
          ],
        );
      }
      const auditId = await insertAudit(client, {
        id: auditEventId,
        workspaceId,
        eventType: "budget.standing_removed",
        subjectType: "budget_line",
        subjectId: `${effectiveMonthOn}:${target.id}`,
        actor,
        before,
        after: null,
      });
      return { before, after: null, audit_event_id: auditId };
    });
  }

  async getBudgetSettings(workspaceId = DEFAULT_WORKSPACE_ID) {
    const result = await this.#client().query(
      `
        WITH income_categories AS (
          SELECT DISTINCT
            active_spending_category_id(
              workspace_id,
              category_id
            ) AS category_id
          FROM budget_income_categories
          WHERE workspace_id = $1
        )
        SELECT
          COALESCE(settings.version, 0) AS version,
          COALESCE(
            jsonb_agg(income.category_id ORDER BY income.category_id)
              FILTER (WHERE income.category_id IS NOT NULL),
            '[]'::jsonb
          ) AS income_category_ids
        FROM budget_settings settings
        LEFT JOIN income_categories income ON true
        WHERE settings.workspace_id = $1
        GROUP BY settings.version
      `,
      [workspaceId],
    );
    return {
      version: Number(result.rows[0]?.version ?? 0),
      income_category_ids: result.rows[0]?.income_category_ids ?? [],
    };
  }

  async replaceBudgetIncomeCategories(
    workspaceId,
    { categoryIds, expectedVersion, auditEventId },
    actor,
  ) {
    return this.withWorkspacePlanningLock(workspaceId, async (client) => {
      await client.query(
        `
          INSERT INTO budget_settings (workspace_id)
          VALUES ($1)
          ON CONFLICT (workspace_id) DO NOTHING
        `,
        [workspaceId],
      );
      const current = await client.query(
        `
          SELECT version
          FROM budget_settings
          WHERE workspace_id = $1
          FOR UPDATE
        `,
        [workspaceId],
      );
      if (Number(current.rows[0]?.version ?? 0) !== expectedVersion) {
        return { conflict: true };
      }
      const before = await client.query(
        `
          SELECT category_id
          FROM budget_income_categories
          WHERE workspace_id = $1
          ORDER BY category_id
        `,
        [workspaceId],
      );
      await client.query(
        `DELETE FROM budget_income_categories WHERE workspace_id = $1`,
        [workspaceId],
      );
      if (categoryIds.length) {
        await client.query(
          `
            INSERT INTO budget_income_categories (
              workspace_id, category_id
            )
            SELECT $1, category_id
            FROM unnest($2::text[]) category_id
          `,
          [workspaceId, categoryIds],
        );
      }
      const updated = await client.query(
        `
          UPDATE budget_settings
          SET version = version + 1,
              updated_by = $2,
              updated_at = now()
          WHERE workspace_id = $1
          RETURNING version
        `,
        [workspaceId, actor.id],
      );
      const after = {
        income_category_ids: categoryIds,
        version: Number(updated.rows[0].version),
      };
      const auditId = await insertAudit(client, {
        id: auditEventId,
        workspaceId,
        eventType: "budget.income_categories_set",
        subjectType: "budget_settings",
        subjectId: workspaceId,
        actor,
        before: {
          income_category_ids: before.rows.map((row) => row.category_id),
          version: expectedVersion,
        },
        after,
      });
      return { before, after, settings: after, audit_event_id: auditId };
    });
  }

  async replaceBudgetMonth(
    workspaceId,
    { monthOn, copiedFromMonthOn, lines, auditEventId },
    actor,
  ) {
    return this.withWorkspacePlanningLock(workspaceId, async (client) => {
      const before = await this.listResolvedBudgetLines(
        workspaceId,
        monthOn,
        client,
      );
      await client.query(
        `
          INSERT INTO budget_months (
            workspace_id, month_on, copied_from_month_on, created_by
          )
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (workspace_id, month_on)
          DO UPDATE SET
            copied_from_month_on = EXCLUDED.copied_from_month_on,
            updated_at = now()
        `,
        [workspaceId, monthOn, copiedFromMonthOn, actor.id],
      );
      await client.query(
        `DELETE FROM budget_lines WHERE workspace_id = $1 AND month_on = $2`,
        [workspaceId, monthOn],
      );
      for (const line of lines) {
        await client.query(
          `
            INSERT INTO budget_lines (
              workspace_id,
              month_on,
              category,
              category_id,
              amount_minor,
              currency_code,
              tracking_mode,
              updated_by
            )
            VALUES (
              $1, $2, $3,
              COALESCE(
                active_spending_category_id($1, $4),
                spending_category_id_for_label($1, $3)
              ),
              $5, 'USD', $6, $7
            )
          `,
          [
            workspaceId,
            monthOn,
            line.category,
            line.category_id ?? null,
            line.amount_minor,
            line.tracking_mode ?? "tracked",
            actor.id,
          ],
        );
      }
      const changedCategories = [
        ...new Set(
          before.concat(lines).map((line) => line.category_id),
        ),
      ].filter(Boolean);
      if (changedCategories.length > 0) {
        await client.query(
          `
            INSERT INTO budget_category_versions (
              workspace_id,
              category,
              category_id,
              version
            )
            SELECT
              $1,
              spending_category_name_for_id($1, category_id),
              category_id,
              1
            FROM unnest($2::text[]) category_id
            ON CONFLICT (workspace_id, category_id)
            DO UPDATE SET
              category = EXCLUDED.category,
              version = budget_category_versions.version + 1,
              updated_at = now()
          `,
          [workspaceId, changedCategories],
        );
      }
      const after = await this.listResolvedBudgetLines(
        workspaceId,
        monthOn,
        client,
      );
      const auditId = await insertAudit(client, {
        id: auditEventId,
        workspaceId,
        eventType: "budget.month_copied",
        subjectType: "budget_month",
        subjectId: monthOn,
        actor,
        before,
        after,
      });
      return {
        before,
        after,
        lines: after,
        audit_event_id: auditId,
      };
    });
  }

  async getTransactionGoalSpending(
    workspaceId = DEFAULT_WORKSPACE_ID,
    transactionId,
    client = null,
  ) {
    const database = client ?? this.#client();
    const transactionResult = await database.query(
      `
        SELECT
          t.id,
          t.provider_transaction_id,
          t.amount_minor,
          t.currency_code,
          t.posted_on,
          t.pending,
          treatment.effective_excluded_from_spending
            AS excluded_from_spending,
          t.goal_spend_version
        FROM transactions t
        JOIN transaction_effective_spending_treatments treatment
          ON treatment.workspace_id = t.workspace_id
         AND treatment.transaction_id = t.id
        WHERE t.workspace_id = $1
          AND t.id = $2
      `,
      [workspaceId, transactionId],
    );
    if (!transactionResult.rows[0]) return null;
    const spendResult = await database.query(
      `
        SELECT spend.*
        FROM goal_transaction_spends spend
        WHERE spend.workspace_id = $1
          AND spend.transaction_id = $2
          AND spend.status = 'active'
        ORDER BY spend.line_index, spend.id
      `,
      [workspaceId, transactionId],
    );
    const transaction = mapGoalSpendTransaction(
      transactionResult.rows[0],
    );
    return {
      transaction,
      goal_spend_version: transaction.goal_spend_version,
      goal_spends: spendResult.rows.map(mapGoalSpend),
    };
  }

  async listActiveGoalSpendTotals(
    workspaceId = DEFAULT_WORKSPACE_ID,
    transactionIds = [],
  ) {
    const ids = [
      ...new Set(
        (transactionIds ?? [])
          .map((transactionId) => String(transactionId))
          .filter(Boolean),
      ),
    ];
    if (ids.length === 0) return [];
    const result = await this.#client().query(
      `
        SELECT
          transaction_id,
          SUM(amount_minor)::bigint AS amount_minor
        FROM goal_transaction_spends
        WHERE workspace_id = $1
          AND transaction_id = ANY($2::text[])
          AND status = 'active'
        GROUP BY transaction_id
        ORDER BY transaction_id
      `,
      [workspaceId, ids],
    );
    return result.rows.map((row) => ({
      transaction_id: row.transaction_id,
      amount_minor: integer(row.amount_minor),
    }));
  }

  async replaceTransactionGoalSpending(
    workspaceId,
    transactionId,
    lines,
    expectedTransactionVersion,
    expectedGoalVersions,
    actor,
    auditEventId,
  ) {
    return this.withWorkspacePlanningLock(workspaceId, async (client) => {
      const transactionResult = await client.query(
        `
          SELECT
            t.id,
            t.provider_transaction_id,
            t.amount_minor,
            t.currency_code,
            t.posted_on,
            t.pending,
            treatment.effective_excluded_from_spending
              AS excluded_from_spending,
            t.goal_spend_version
          FROM transactions t
          JOIN transaction_effective_spending_treatments treatment
            ON treatment.workspace_id = t.workspace_id
           AND treatment.transaction_id = t.id
          WHERE t.workspace_id = $1
            AND t.id = $2
          FOR UPDATE OF t
        `,
        [workspaceId, transactionId],
      );
      if (!transactionResult.rows[0]) return null;
      const transaction = mapGoalSpendTransaction(
        transactionResult.rows[0],
      );
      const beforeResult = await client.query(
        `
          SELECT spend.*
          FROM goal_transaction_spends spend
          WHERE spend.workspace_id = $1
            AND spend.transaction_id = $2
            AND spend.status = 'active'
          ORDER BY spend.line_index, spend.id
          FOR UPDATE
        `,
        [workspaceId, transactionId],
      );
      const before = beforeResult.rows.map(mapGoalSpend);
      const current = {
        transaction,
        goal_spend_version: transaction.goal_spend_version,
        goal_spends: before,
      };
      if (
        transaction.goal_spend_version !== expectedTransactionVersion
      ) {
        return { conflict: true, current };
      }

      const normalized = normalizeGoalSpendLines(lines);
      if (normalized.error) {
        return validationFailure(normalized.error, current);
      }
      const nextLines = normalized.lines;
      if (
        addsGoalSpending(before, nextLines) &&
        (
          transaction.pending ||
          transaction.currency_code !== "USD" ||
          transaction.amount_minor >= 0 ||
          transaction.excluded_from_spending
        )
      ) {
        return validationFailure(
          {
            code: "transaction_not_posted_usd_expense",
            message:
              "Only posted, included USD expense transactions can spend from goals.",
          },
          current,
        );
      }
      const nextTotal = nextLines.reduce(
        (sum, line) => sum + line.amount_minor,
        0,
      );
      if (nextTotal > -transaction.amount_minor) {
        return validationFailure(
          {
            code: "goal_spend_exceeds_transaction",
            message:
              "Goal spending cannot exceed the transaction expense.",
          },
          current,
        );
      }
      if (sameGoalSpendLines(before, nextLines)) {
        return {
          before,
          after: before,
          goal_spends: before,
          goal_spend_version: transaction.goal_spend_version,
          noop: true,
          audit_event_id: null,
        };
      }

      const beforeByGoalSource = sumGoalSpendLines(before);
      const nextByGoalSource = sumGoalSpendLines(nextLines);
      const candidateGoalIds = [
        ...new Set(
          before
            .map((line) => line.goal_id)
            .concat(nextLines.map((line) => line.goal_id)),
        ),
      ];
      const affectedGoalIds = candidateGoalIds
        .filter((goalId) =>
          ["cash", "brokerage"].some((source) => {
            const key = `${goalId}:${source}`;
            return (
              (beforeByGoalSource.get(key) ?? 0) !==
              (nextByGoalSource.get(key) ?? 0)
            );
          }),
        )
        .sort();
      const goalResult = affectedGoalIds.length
        ? await client.query(
            `
              SELECT *
              FROM finance_goals
              WHERE workspace_id = $1
                AND id = ANY($2::text[])
              ORDER BY id
              FOR UPDATE
            `,
            [workspaceId, affectedGoalIds],
          )
        : { rows: [] };
      const goalsById = new Map(
        goalResult.rows.map((goal) => [goal.id, goal]),
      );
      if (goalsById.size !== affectedGoalIds.length) {
        return validationFailure(
          {
            code: "goal_not_found",
            message: "One or more goals no longer exist.",
          },
          {
            ...current,
            goals: goalResult.rows.map(mapGoalVersion),
          },
        );
      }
      const expectedVersions = goalVersionMap(expectedGoalVersions);
      for (const goalId of affectedGoalIds) {
        const goal = goalsById.get(goalId);
        if (
          !expectedVersions.has(goalId) ||
          expectedVersions.get(goalId) !== Number(goal.version)
        ) {
          return {
            conflict: true,
            current: {
              ...current,
              goals: goalResult.rows.map(mapGoalVersion),
            },
          };
        }
      }

      const reactivatedGoalIds = [];
      for (const goalId of affectedGoalIds) {
        const goal = goalsById.get(goalId);
        if (goal.status !== "archived") continue;
        let restored = false;
        for (const source of ["cash", "brokerage"]) {
          const key = `${goalId}:${source}`;
          const previous = beforeByGoalSource.get(key) ?? 0;
          const next = nextByGoalSource.get(key) ?? 0;
          if (next > previous) {
            return validationFailure(
              {
                code: "goal_archived",
                message:
                  "Archived goals cannot receive new transaction spending.",
              },
              {
                ...current,
                goals: goalResult.rows.map(mapGoalVersion),
              },
            );
          }
          restored ||= next < previous;
        }
        if (restored) reactivatedGoalIds.push(goalId);
      }

      const beforeByKey = new Map(
        before.map((line) => [goalSpendKey(line), line]),
      );
      const retained = nextLines
        .map((line) => ({
          current: beforeByKey.get(goalSpendKey(line)),
          next: line,
        }))
        .filter(
          ({ current, next }) =>
            current && current.amount_minor === next.amount_minor,
        );
      const retainedKeys = new Set(
        retained.map(({ next }) => goalSpendKey(next)),
      );
      const reversedIds = before
        .filter((line) => !retainedKeys.has(goalSpendKey(line)))
        .map((line) => line.id);
      const insertedLines = nextLines.filter(
        (line) => !retainedKeys.has(goalSpendKey(line)),
      );
      const activeIds = new Set(before.map((line) => line.id));
      if (insertedLines.some((line) => activeIds.has(line.id))) {
        return validationFailure(
          {
            code: "goal_spend_id_reused",
            message:
              "Changed goal spending lines must use a new record ID.",
          },
          current,
        );
      }
      if (reversedIds.length > 0) {
        await client.query(
          `
            UPDATE goal_transaction_spends
            SET
              status = 'reversed',
              ended_reason = 'replaced_by_user',
              updated_by = $4,
              updated_at = now(),
              ended_at = now()
            WHERE workspace_id = $1
              AND transaction_id = $2
              AND id = ANY($3::text[])
              AND status = 'active'
          `,
          [
            workspaceId,
            transactionId,
            reversedIds,
            actor.id,
          ],
        );
      }
      for (const { current: retainedLine, next: nextLine } of retained) {
        if (retainedLine.line_index === nextLine.line_index) continue;
        await client.query(
          `
            UPDATE goal_transaction_spends
            SET
              line_index = $3,
              updated_by = $4,
              updated_at = now()
            WHERE workspace_id = $1
              AND id = $2
              AND status = 'active'
          `,
          [
            workspaceId,
            retainedLine.id,
            nextLine.line_index,
            actor.id,
          ],
        );
      }
      for (const line of insertedLines) {
        await client.query(
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
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
          `,
          [
            line.id,
            workspaceId,
            transactionId,
            transaction.provider_transaction_id,
            line.goal_id,
            line.source,
            line.line_index,
            line.amount_minor,
            actor.id,
          ],
        );
      }

      for (const goalId of reactivatedGoalIds) {
        const goal = goalsById.get(goalId);
        await insertAudit(client, {
          id: `${auditEventId}:reactivate:${goalId}`,
          workspaceId,
          eventType: "goal.reactivated_after_spend_reversal",
          subjectType: "goal",
          subjectId: goalId,
          actor,
          before: {
            status: goal.status,
            version: Number(goal.version),
            archived_at: dateValue(goal.archived_at),
            archive_outcome: goal.archive_outcome ?? null,
          },
          after: {
            status: "active",
            version: Number(goal.version) + 1,
            archived_at: null,
            archive_outcome: null,
          },
        });
      }
      const advancedGoals = affectedGoalIds.length
        ? await client.query(
            `
              UPDATE finance_goals
              SET
                status = CASE
                  WHEN id = ANY($3::text[]) THEN 'active'
                  ELSE status
                END,
                archived_at = CASE
                  WHEN id = ANY($3::text[]) THEN NULL
                  ELSE archived_at
                END,
                archive_outcome = CASE
                  WHEN id = ANY($3::text[]) THEN NULL
                  ELSE archive_outcome
                END,
                updated_by = $4,
                updated_at = now(),
                version = version + 1
              WHERE workspace_id = $1
                AND id = ANY($2::text[])
              RETURNING
                id,
                status,
                version,
                archived_at,
                archive_outcome
            `,
            [
              workspaceId,
              affectedGoalIds,
              reactivatedGoalIds,
              actor.id,
            ],
          )
        : { rows: [] };
      const advancedTransaction = await client.query(
        `
          UPDATE transactions
          SET goal_spend_version = goal_spend_version + 1
          WHERE workspace_id = $1
            AND id = $2
            AND goal_spend_version = $3
          RETURNING goal_spend_version
        `,
        [
          workspaceId,
          transactionId,
          expectedTransactionVersion,
        ],
      );
      if (!advancedTransaction.rows[0]) {
        throw new Error(
          "Transaction goal-spend version changed while its lines were being saved.",
        );
      }
      const nextVersion = Number(
        advancedTransaction.rows[0].goal_spend_version,
      );
      const afterResult = await client.query(
        `
          SELECT spend.*
          FROM goal_transaction_spends spend
          WHERE spend.workspace_id = $1
            AND spend.transaction_id = $2
            AND spend.status = 'active'
          ORDER BY spend.line_index, spend.id
        `,
        [workspaceId, transactionId],
      );
      const after = afterResult.rows.map((row) =>
        mapGoalSpend({
          ...row,
          goal_spend_version: nextVersion,
        }),
      );
      const auditId = await insertAudit(client, {
        id: auditEventId,
        workspaceId,
        eventType: after.length
          ? "transaction.goal_spends_replaced"
          : "transaction.goal_spends_cleared",
        subjectType: "transaction",
        subjectId: transactionId,
        actor,
        before: {
          goal_spend_version: transaction.goal_spend_version,
          goal_spends: before,
        },
        after: {
          goal_spend_version: nextVersion,
          goal_spends: after,
        },
      });
      return {
        before,
        after,
        goal_spends: after,
        goal_spend_version: nextVersion,
        goals: advancedGoals.rows.map(mapGoalVersion),
        audit_event_id: auditId,
      };
    });
  }

  async listTransactionSplits(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      transactionIds = null,
      startOn = null,
      endOn = null,
      dateMode = "posted",
    } = {},
  ) {
    const useBudgetMonth = dateMode === "budget";
    const result = await this.#client().query(
      `
        SELECT
          split.*,
          active_spending_category_id(
            split.workspace_id,
            split.category_id
          ) AS resolved_category_id,
          spending_category_name_for_id(
            split.workspace_id,
            split.category_id
          ) AS resolved_category,
          transaction.split_version
        FROM transaction_splits split
        JOIN transactions transaction
          ON transaction.workspace_id = split.workspace_id
         AND transaction.id = split.transaction_id
        LEFT JOIN transaction_metadata metadata
          ON metadata.workspace_id = transaction.workspace_id
         AND metadata.transaction_id = transaction.id
        WHERE split.workspace_id = $1
          AND ($2::text[] IS NULL OR split.transaction_id = ANY($2))
          AND (
            $3::date IS NULL
            OR (
              CASE
                WHEN $5::boolean
                  THEN COALESCE(
                    metadata.budget_month_on,
                    date_trunc('month', transaction.posted_on)::date
                  )
                ELSE transaction.posted_on
              END
            ) >= $3
          )
          AND (
            $4::date IS NULL
            OR (
              CASE
                WHEN $5::boolean
                  THEN COALESCE(
                    metadata.budget_month_on,
                    date_trunc('month', transaction.posted_on)::date
                  )
                ELSE transaction.posted_on
              END
            ) < $4
          )
        ORDER BY split.transaction_id, split.line_index
      `,
      [
        workspaceId,
        transactionIds,
        startOn,
        endOn,
        useBudgetMonth,
      ],
    );
    return result.rows.map(mapSplit);
  }

  async replaceTransactionSplits(
    workspaceId,
    transactionId,
    lines,
    expectedVersion,
    actor,
    auditEventId,
  ) {
    return this.#withTransaction(async (client) => {
      const parentResult = await client.query(
        `
          SELECT
            id,
            amount_minor,
            currency_code,
            pending,
            split_version
          FROM transactions
          WHERE workspace_id = $1 AND id = $2
          FOR UPDATE
        `,
        [workspaceId, transactionId],
      );
      const parent = parentResult.rows[0];
      if (!parent) return null;
      const beforeResult = await client.query(
        `
          SELECT
            split.*,
            active_spending_category_id(
              split.workspace_id,
              split.category_id
            ) AS resolved_category_id,
            spending_category_name_for_id(
              split.workspace_id,
              split.category_id
            ) AS resolved_category
          FROM transaction_splits split
          WHERE workspace_id = $1 AND transaction_id = $2
          ORDER BY line_index
        `,
        [workspaceId, transactionId],
      );
      const currentVersion = Number(parent.split_version ?? 0);
      const current = {
        transaction_id: transactionId,
        split_version: currentVersion,
        lines: beforeResult.rows.map((row) =>
          mapSplit({ ...row, split_version: currentVersion }),
        ),
      };
      if (currentVersion !== expectedVersion) {
        return { conflict: true, current };
      }
      if (lines.length > 0) {
        const parentAmount = integer(parent.amount_minor);
        const total = lines.reduce(
          (sum, line) => sum + Number(line.amount_minor),
          0,
        );
        const invalid =
          lines.length < 2 ||
          parent.pending ||
          parent.currency_code !== "USD" ||
          parentAmount === 0 ||
          lines.some(
            (line) =>
              Math.sign(Number(line.amount_minor)) !==
              Math.sign(parentAmount),
          ) ||
          total !== parentAmount;
        if (invalid) {
          return {
            conflict: true,
            current: {
              ...current,
              amount_minor: parentAmount,
              currency_code: parent.currency_code,
              pending: Boolean(parent.pending),
            },
          };
        }
      }
      await client.query(
        `
          DELETE FROM transaction_splits
          WHERE workspace_id = $1 AND transaction_id = $2
        `,
        [workspaceId, transactionId],
      );
      for (const line of lines) {
        await client.query(
          `
            INSERT INTO transaction_splits (
              id,
              workspace_id,
              transaction_id,
              line_index,
              category,
              amount_minor,
              note,
              created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            line.id,
            workspaceId,
            transactionId,
            line.line_index,
            line.category,
            line.amount_minor,
            line.note,
            actor.id,
          ],
        );
      }
      const afterResult = await client.query(
        `
          SELECT
            split.*,
            active_spending_category_id(
              split.workspace_id,
              split.category_id
            ) AS resolved_category_id,
            spending_category_name_for_id(
              split.workspace_id,
              split.category_id
            ) AS resolved_category
          FROM transaction_splits split
          WHERE workspace_id = $1 AND transaction_id = $2
          ORDER BY line_index
        `,
        [workspaceId, transactionId],
      );
      const advanced = await client.query(
        `
          UPDATE transactions
          SET split_version = split_version + 1
          WHERE workspace_id = $1
            AND id = $2
            AND split_version = $3
          RETURNING split_version
        `,
        [workspaceId, transactionId, expectedVersion],
      );
      if (!advanced.rows[0]) {
        throw new Error(
          "Transaction split version changed while its lines were being saved.",
        );
      }
      const nextVersion = Number(advanced.rows[0].split_version);
      const before = beforeResult.rows.map((row) =>
        mapSplit({ ...row, split_version: currentVersion }),
      );
      const after = afterResult.rows.map((row) =>
        mapSplit({ ...row, split_version: nextVersion }),
      );
      const auditId = await insertAudit(client, {
        id: auditEventId,
        workspaceId,
        eventType: lines.length
          ? "transaction.splits_replaced"
          : "transaction.splits_cleared",
        subjectType: "transaction",
        subjectId: transactionId,
        actor,
        before,
        after,
      });
      return {
        before,
        after,
        splits: after,
        split_version: nextVersion,
        audit_event_id: auditId,
      };
    });
  }

  async listAuditEvents(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { limit = 40 } = {},
  ) {
    const result = await this.#client().query(
      `
        SELECT *
        FROM plan_audit_events
        WHERE workspace_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2
      `,
      [workspaceId, Math.max(1, Math.min(100, Number(limit) || 40))],
    );
    return result.rows.map((row) => ({
      id: row.id,
      event_type: row.event_type,
      subject_type: row.subject_type,
      subject_id: row.subject_id,
      actor_type: row.actor_type,
      actor_id: row.actor_id ?? null,
      before: row.before_value ?? null,
      after: row.after_value ?? null,
      created_at: dateValue(row.created_at),
    }));
  }
}

async function insertAudit(
  client,
  {
    id,
    workspaceId,
    eventType,
    subjectType,
    subjectId,
    actor,
    before,
    after,
  },
) {
  await client.query(
    `
      INSERT INTO plan_audit_events (
        id,
        workspace_id,
        event_type,
        subject_type,
        subject_id,
        actor_type,
        actor_id,
        before_value,
        after_value
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      id,
      workspaceId,
      eventType,
      subjectType,
      subjectId,
      actor.type,
      actor.id,
      before,
      after,
    ],
  );
  return id;
}

function mapGoal(row) {
  const recordedAllocations = mapSourceAmounts(
    row.recorded_allocations ?? row.allocations ?? [],
  );
  const spending = mapSourceAmounts(row.spending ?? []);
  const recordedBySource = new Map(
    recordedAllocations.map((entry) => [
      entry.source,
      entry.amount_minor,
    ]),
  );
  const spentBySource = new Map(
    spending.map((entry) => [entry.source, entry.amount_minor]),
  );
  const sources = [
    ...new Set([
      ...recordedBySource.keys(),
      ...spentBySource.keys(),
    ]),
  ].sort();
  const allocations =
    row.status === "archived"
      ? []
      : deriveGoalAllocations(
          recordedBySource,
          spentBySource,
          sources,
        );
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose ?? "other",
    target_amount_minor: integer(row.target_amount_minor),
    currency_code: row.currency_code ?? "USD",
    target_on: row.target_on ? String(row.target_on) : null,
    status: row.status,
    version: Number(row.version),
    allocations,
    recorded_allocations: recordedAllocations,
    spending,
    schedules: (row.schedules ?? []).map((schedule) =>
      mapSchedule({
        ...schedule,
        goal_id: schedule.goal_id ?? row.id,
      }),
    ),
    archived_at: dateValue(row.archived_at),
    archive_outcome: row.archive_outcome ?? null,
    created_at: dateValue(row.created_at),
    updated_at: dateValue(row.updated_at),
  };
}

function deriveGoalAllocations(
  recordedBySource,
  spentBySource,
  sources,
) {
  const remainingBySource = new Map(
    sources.map((source) => [
      source,
      Math.max(
        0,
        (recordedBySource.get(source) ?? 0) -
          (spentBySource.get(source) ?? 0),
      ),
    ]),
  );
  for (const source of sources) {
    let overrun = Math.max(
      0,
      (spentBySource.get(source) ?? 0) -
        (recordedBySource.get(source) ?? 0),
    );
    if (overrun === 0) continue;
    for (const fallbackSource of sources) {
      if (fallbackSource === source || overrun === 0) continue;
      const available = remainingBySource.get(fallbackSource) ?? 0;
      const consumed = Math.min(available, overrun);
      remainingBySource.set(
        fallbackSource,
        available - consumed,
      );
      overrun -= consumed;
    }
  }
  return sources.map((source) => ({
    source,
    amount_minor: remainingBySource.get(source) ?? 0,
  }));
}

function mapSourceAmounts(entries) {
  return entries.map((entry) => ({
    source: entry.source,
    amount_minor: integer(entry.amount_minor),
  }));
}

function mapAllocation(row) {
  return {
    id: row.id,
    goal_id: row.goal_id,
    source: row.source,
    amount_delta_minor: integer(row.amount_delta_minor),
    created_at: dateValue(row.created_at),
  };
}

function mapSchedule(row) {
  return {
    id: row.id,
    goal_id: row.goal_id,
    source: row.source,
    cadence: row.cadence,
    amount_minor: integer(row.amount_minor),
    monthly_day:
      row.monthly_day == null ? null : Number(row.monthly_day),
    anchor_on: row.anchor_on ? String(row.anchor_on) : null,
    next_run_on: row.next_run_on ? String(row.next_run_on) : null,
    status: row.status,
    version: Number(row.version),
  };
}

function mapBudgetLine(row) {
  return {
    category_id: row.category_id ?? null,
    category: row.category,
    amount_minor: integer(row.amount_minor),
    currency_code: row.currency_code ?? "USD",
    tracking_mode: row.tracking_mode ?? "tracked",
    version: Number(row.version ?? 0),
    exact_month: Boolean(row.exact_month),
    effective_month_on: row.effective_month_on
      ? String(row.effective_month_on)
      : null,
  };
}

function mapSplit(row) {
  return {
    id: row.id,
    transaction_id: row.transaction_id,
    split_version: Number(row.split_version ?? 0),
    line_index: Number(row.line_index),
    category_id:
      row.resolved_category_id ??
      row.category_id ??
      null,
    category: row.resolved_category ?? row.category,
    amount_minor: integer(row.amount_minor),
    note: row.note ?? null,
  };
}

function mapGoalSpend(row) {
  return {
    id: row.id,
    transaction_id: row.transaction_id ?? null,
    transaction_provider_id: row.transaction_provider_id,
    goal_id: row.goal_id,
    source: row.source,
    line_index: Number(row.line_index),
    amount_minor: integer(row.amount_minor),
    status: row.status ?? "active",
    ended_reason: row.ended_reason ?? null,
    created_at: dateValue(row.created_at),
    updated_at: dateValue(row.updated_at),
    ended_at: dateValue(row.ended_at),
  };
}

function mapGoalSpendTransaction(row) {
  return {
    id: row.id,
    provider_transaction_id: row.provider_transaction_id,
    amount_minor: integer(row.amount_minor),
    currency_code: row.currency_code,
    posted_on: String(row.posted_on),
    pending: Boolean(row.pending),
    excluded_from_spending: Boolean(row.excluded_from_spending),
    goal_spend_version: Number(row.goal_spend_version ?? 0),
  };
}

function mapGoalVersion(row) {
  return {
    id: row.id,
    status: row.status,
    version: Number(row.version),
    archived_at: dateValue(row.archived_at),
    archive_outcome: row.archive_outcome ?? null,
  };
}

function normalizeGoalSpendLines(lines) {
  if (!Array.isArray(lines) || lines.length > 50) {
    return {
      error: {
        code: "invalid_goal_spend_lines",
        message:
          "Goal spending lines must be an array with at most 50 entries.",
      },
    };
  }
  const normalized = [];
  const indices = new Set();
  const goalSources = new Set();
  for (const line of lines) {
    const amountMinor = Number(line?.amount_minor);
    const lineIndex = Number(line?.line_index);
    const id = String(line?.id ?? "");
    const goalId = String(line?.goal_id ?? "");
    const source = String(line?.source ?? "");
    const goalSource = `${goalId}:${source}`;
    if (
      !id ||
      !goalId ||
      !["cash", "brokerage"].includes(source) ||
      !Number.isSafeInteger(lineIndex) ||
      lineIndex < 0 ||
      lineIndex > 49 ||
      !Number.isSafeInteger(amountMinor) ||
      amountMinor <= 0 ||
      indices.has(lineIndex) ||
      goalSources.has(goalSource)
    ) {
      return {
        error: {
          code: "invalid_goal_spend_lines",
          message:
            "Each goal spending line needs a unique index and goal/source pair with a positive safe-integer amount.",
        },
      };
    }
    indices.add(lineIndex);
    goalSources.add(goalSource);
    normalized.push({
      id,
      line_index: lineIndex,
      goal_id: goalId,
      source,
      amount_minor: amountMinor,
    });
  }
  normalized.sort(
    (left, right) =>
      left.line_index - right.line_index ||
      left.id.localeCompare(right.id),
  );
  return { lines: normalized };
}

function sameGoalSpendLines(current, proposed) {
  if (current.length !== proposed.length) return false;
  return current.every((line, index) => {
    const next = proposed[index];
    return (
      line.line_index === next.line_index &&
      line.goal_id === next.goal_id &&
      line.source === next.source &&
      line.amount_minor === next.amount_minor
    );
  });
}

function addsGoalSpending(current, proposed) {
  const currentByGoalSource = sumGoalSpendLines(current);
  const proposedByGoalSource = sumGoalSpendLines(proposed);
  return [...proposedByGoalSource].some(
    ([goalSource, amountMinor]) =>
      amountMinor > (currentByGoalSource.get(goalSource) ?? 0),
  );
}

function sumGoalSpendLines(lines) {
  const result = new Map();
  for (const line of lines) {
    const key = goalSpendKey(line);
    result.set(key, (result.get(key) ?? 0) + line.amount_minor);
  }
  return result;
}

function goalSpendKey(line) {
  return `${line.goal_id}:${line.source}`;
}

function goalVersionMap(value) {
  if (value instanceof Map) return value;
  if (Array.isArray(value)) {
    return new Map(
      value.map((entry) => [
        entry.goal_id ?? entry.id,
        Number(entry.version),
      ]),
    );
  }
  if (value && typeof value === "object") {
    return new Map(
      Object.entries(value).map(([goalId, version]) => [
        goalId,
        Number(version),
      ]),
    );
  }
  return new Map();
}

function validationFailure(error, current) {
  return {
    validation: true,
    code: error.code,
    message: error.message,
    current,
    ...(error.goal_id ? { goal_id: error.goal_id } : {}),
    ...(error.source ? { source: error.source } : {}),
    ...(error.available_minor == null
      ? {}
      : { available_minor: error.available_minor }),
  };
}

function integer(value) {
  if (value == null) return null;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized)) {
    throw new TypeError("Database money value exceeds safe integer bounds.");
  }
  return normalized;
}

function dateValue(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}
