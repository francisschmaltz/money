import { withTransaction } from "./pool.js";

const DEFAULT_WORKSPACE_ID = "shared";

export class PgPlanningRepository {
  #pool;

  constructor(pool) {
    if (!pool) throw new TypeError("pool is required");
    this.#pool = pool;
  }

  async getWorkspaceTimezone(workspaceId = DEFAULT_WORKSPACE_ID) {
    const result = await this.#pool.query(
      `SELECT timezone FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    return result.rows[0]?.timezone ?? "America/Los_Angeles";
  }

  async claimPlanWrite(
    workspaceId,
    { actor, operation, idempotencyKey, requestHash },
  ) {
    return withTransaction(this.#pool, async (client) => {
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
    const result = await this.#pool.query(
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
    await this.#pool.query(
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
    client = this.#pool,
  ) {
    const result = await client.query(
      `
        SELECT
          goal.*,
          COALESCE(allocation.allocations, '[]'::jsonb) AS allocations,
          COALESCE(schedule.schedules, '[]'::jsonb) AS schedules
        FROM finance_goals goal
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(
            jsonb_build_object(
              'source', grouped.source,
              'amount_minor', grouped.amount_minor
            )
            ORDER BY grouped.source
          ) AS allocations
          FROM (
            SELECT source, SUM(amount_delta_minor)::bigint AS amount_minor
            FROM goal_allocation_events
            WHERE goal_id = goal.id
            GROUP BY source
          ) grouped
        ) allocation ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', funding.id,
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
    client = this.#pool,
  ) {
    const goals = await this.listGoals(
      workspaceId,
      { includeArchived: true },
      client,
    );
    return goals.find((goal) => goal.id === goalId) ?? null;
  }

  async createGoal(workspaceId, goal, actor) {
    return withTransaction(this.#pool, async (client) => {
      const result = await client.query(
        `
          INSERT INTO finance_goals (
            id,
            workspace_id,
            name,
            target_amount_minor,
            currency_code,
            target_on,
            created_by,
            updated_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
          RETURNING *
        `,
        [
          goal.id,
          workspaceId,
          goal.name,
          goal.target_amount_minor,
          goal.currency_code,
          goal.target_on,
          actor.id,
        ],
      );
      const created = mapGoal({
        ...result.rows[0],
        allocations: [],
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
    return withTransaction(this.#pool, async (client) => {
      const before = await this.getGoal(workspaceId, goalId, client);
      if (!before) return null;
      const result = await client.query(
        `
          UPDATE finance_goals
          SET
            name = COALESCE($3, name),
            target_amount_minor = COALESCE($4, target_amount_minor),
            target_on = CASE WHEN $5::boolean THEN $6::date ELSE target_on END,
            updated_by = $7,
            updated_at = now(),
            version = version + 1
          WHERE workspace_id = $1
            AND id = $2
            AND version = $8
          RETURNING *
        `,
        [
          workspaceId,
          goalId,
          changes.name ?? null,
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
    return withTransaction(this.#pool, async (client) => {
      const before = await this.getGoal(workspaceId, goalId, client);
      if (!before) return null;
      const result = await client.query(
        `
          UPDATE finance_goals
          SET
            status = 'archived',
            archived_at = now(),
            updated_by = $3,
            updated_at = now(),
            version = version + 1
          WHERE workspace_id = $1
            AND id = $2
            AND status = 'active'
            AND version = $4
          RETURNING id
        `,
        [workspaceId, goalId, actor.id, expectedVersion],
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
        eventType: "goal.archived",
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
    return withTransaction(this.#pool, async (client) => {
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
  ) {
    return withTransaction(this.#pool, async (client) => {
      const existing = schedule.id
        ? await client.query(
            `
              SELECT * FROM goal_funding_schedules
              WHERE workspace_id = $1 AND id = $2
              FOR UPDATE
            `,
            [workspaceId, schedule.id],
          )
        : { rows: [] };
      const before = existing.rows[0]
        ? mapSchedule(existing.rows[0])
        : null;
      if (before && before.goal_id !== schedule.goal_id) {
        return { conflict: true, current: before };
      }
      if (before && before.version !== expectedVersion) {
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
              WHERE workspace_id = $1 AND id = $2
              RETURNING *
            `,
            [
              workspaceId,
              schedule.id,
              schedule.source,
              schedule.cadence,
              schedule.amount_minor,
              schedule.monthly_day,
              schedule.anchor_on,
              schedule.next_run_on,
              schedule.status,
              actor.id,
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
    const result = await this.#pool.query(
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
    },
  ) {
    return withTransaction(this.#pool, async (client) => {
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
      await client.query(
        `
          UPDATE goal_funding_schedules
          SET
            next_run_on = $3,
            status = CASE WHEN $4::boolean THEN 'paused' ELSE status END,
            updated_at = now(),
            version = CASE
              WHEN $4::boolean THEN version + 1
              ELSE version
            END
          WHERE workspace_id = $1 AND id = $2
        `,
        [workspaceId, schedule.id, nextRunOn, pauseSchedule],
      );
      return { replayed: false, run_id: runId };
    });
  }

  async listGoalScheduleRuns(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { limit = 30 } = {},
  ) {
    const result = await this.#pool.query(
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
    client = this.#pool,
  ) {
    const result = await client.query(
      `
        WITH defaults AS (
          SELECT DISTINCT ON (category)
            category,
            amount_minor,
            currency_code,
            effective_month_on
          FROM budget_default_revisions
          WHERE workspace_id = $1
            AND effective_month_on <= $2
          ORDER BY category, effective_month_on DESC
        ),
        overrides AS (
          SELECT category, amount_minor, currency_code
          FROM budget_lines
          WHERE workspace_id = $1 AND month_on = $2
        )
        SELECT
          COALESCE(overrides.category, defaults.category) AS category,
          COALESCE(overrides.amount_minor, defaults.amount_minor) AS amount_minor,
          COALESCE(overrides.currency_code, defaults.currency_code) AS currency_code,
          (overrides.category IS NOT NULL) AS exact_month,
          defaults.effective_month_on
        FROM defaults
        FULL OUTER JOIN overrides USING (category)
        ORDER BY category
      `,
      [workspaceId, monthOn],
    );
    return result.rows.map(mapBudgetLine);
  }

  async ensureBudgetMonthSnapshot(
    workspaceId,
    monthOn,
    actorId = "budget-snapshot",
  ) {
    return withTransaction(this.#pool, async (client) => {
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
            amount_minor,
            currency_code,
            updated_by
          )
          SELECT
            $1,
            $2,
            resolved.category,
            resolved.amount_minor,
            resolved.currency_code,
            $3
          FROM (
            SELECT DISTINCT ON (category)
              category,
              amount_minor,
              currency_code
            FROM budget_default_revisions
            WHERE workspace_id = $1
              AND effective_month_on <= $2
            ORDER BY category, effective_month_on DESC
          ) resolved
          ON CONFLICT (workspace_id, month_on, category) DO NOTHING
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
      amountMinor,
      scope,
      auditEventId,
    },
    actor,
  ) {
    return withTransaction(this.#pool, async (client) => {
      const table =
        scope === "future_default"
          ? "budget_default_revisions"
          : "budget_lines";
      const dateColumn =
        scope === "future_default" ? "effective_month_on" : "month_on";
      const dateValueInput =
        scope === "future_default" ? effectiveMonthOn : monthOn;
      if (scope !== "future_default") {
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
      const before = await client.query(
        `
          SELECT category, amount_minor, currency_code
          FROM ${table}
          WHERE workspace_id = $1 AND ${dateColumn} = $2 AND category = $3
        `,
        [workspaceId, dateValueInput, category],
      );
      const result = await client.query(
        `
          INSERT INTO ${table} (
            workspace_id,
            ${dateColumn},
            category,
            amount_minor,
            currency_code,
            updated_by
          )
          VALUES ($1, $2, $3, $4, 'USD', $5)
          ON CONFLICT (workspace_id, category, ${dateColumn})
          DO UPDATE SET
            amount_minor = EXCLUDED.amount_minor,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
          RETURNING category, amount_minor, currency_code
        `,
        [workspaceId, dateValueInput, category, amountMinor, actor.id],
      );
      const after = mapBudgetLine(result.rows[0]);
      const auditId = await insertAudit(client, {
        id: auditEventId,
        workspaceId,
        eventType:
          scope === "future_default"
            ? "budget.default_set"
            : "budget.month_set",
        subjectType: "budget_line",
        subjectId: `${dateValueInput}:${category}`,
        actor,
        before: before.rows[0] ? mapBudgetLine(before.rows[0]) : null,
        after,
      });
      return {
        before: before.rows[0]
          ? mapBudgetLine(before.rows[0])
          : null,
        after,
        line: after,
        audit_event_id: auditId,
      };
    });
  }

  async replaceBudgetMonth(
    workspaceId,
    { monthOn, copiedFromMonthOn, lines, auditEventId },
    actor,
  ) {
    return withTransaction(this.#pool, async (client) => {
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
              amount_minor,
              currency_code,
              updated_by
            )
            VALUES ($1, $2, $3, $4, 'USD', $5)
          `,
          [workspaceId, monthOn, line.category, line.amount_minor, actor.id],
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

  async listTransactionSplits(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { transactionIds = null, startOn = null, endOn = null } = {},
  ) {
    const result = await this.#pool.query(
      `
        SELECT split.*
        FROM transaction_splits split
        JOIN transactions transaction ON transaction.id = split.transaction_id
        WHERE split.workspace_id = $1
          AND ($2::text[] IS NULL OR split.transaction_id = ANY($2))
          AND ($3::date IS NULL OR transaction.posted_on >= $3)
          AND ($4::date IS NULL OR transaction.posted_on < $4)
        ORDER BY split.transaction_id, split.line_index
      `,
      [workspaceId, transactionIds, startOn, endOn],
    );
    return result.rows.map(mapSplit);
  }

  async replaceTransactionSplits(
    workspaceId,
    transactionId,
    lines,
    actor,
    auditEventId,
  ) {
    return withTransaction(this.#pool, async (client) => {
      const beforeResult = await client.query(
        `
          SELECT * FROM transaction_splits
          WHERE workspace_id = $1 AND transaction_id = $2
          ORDER BY line_index
        `,
        [workspaceId, transactionId],
      );
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
          SELECT * FROM transaction_splits
          WHERE workspace_id = $1 AND transaction_id = $2
          ORDER BY line_index
        `,
        [workspaceId, transactionId],
      );
      const before = beforeResult.rows.map(mapSplit);
      const after = afterResult.rows.map(mapSplit);
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
        audit_event_id: auditId,
      };
    });
  }

  async listAuditEvents(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { limit = 40 } = {},
  ) {
    const result = await this.#pool.query(
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
  return {
    id: row.id,
    name: row.name,
    target_amount_minor: integer(row.target_amount_minor),
    currency_code: row.currency_code ?? "USD",
    target_on: row.target_on ? String(row.target_on) : null,
    status: row.status,
    version: Number(row.version),
    allocations: (row.allocations ?? []).map((entry) => ({
      source: entry.source,
      amount_minor: integer(entry.amount_minor),
    })),
    schedules: (row.schedules ?? []).map(mapSchedule),
    archived_at: dateValue(row.archived_at),
    created_at: dateValue(row.created_at),
    updated_at: dateValue(row.updated_at),
  };
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
    category: row.category,
    amount_minor: integer(row.amount_minor),
    currency_code: row.currency_code ?? "USD",
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
    line_index: Number(row.line_index),
    category: row.category,
    amount_minor: integer(row.amount_minor),
    note: row.note ?? null,
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
