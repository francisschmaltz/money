import assert from "node:assert/strict";
import test from "node:test";

import { PgPlanningRepository } from "../app/db/planningRepository.js";

function normalized(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function transactionalPool(handler) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const query = normalized(sql);
      calls.push({ sql: query, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(query)) {
        return { rows: [] };
      }
      return handler(query, params);
    },
    release() {},
  };
  return {
    calls,
    pool: {
      async connect() {
        return client;
      },
      async query(sql, params = []) {
        const query = normalized(sql);
        calls.push({ sql: query, params });
        return handler(query, params);
      },
    },
  };
}

function goalRow(overrides = {}) {
  return {
    id: "goal-trip",
    workspace_id: "shared",
    name: "Family trip",
    purpose: "vacation",
    target_amount_minor: "500000",
    currency_code: "USD",
    target_on: "2026-08-01",
    status: "active",
    version: "1",
    archived_at: null,
    archive_outcome: null,
    recorded_allocations: [],
    spending: [],
    schedules: [],
    ...overrides,
  };
}

test("goal creation persists purpose and maps lifecycle fields", async () => {
  const db = transactionalPool(async (sql) => {
    if (sql.startsWith("INSERT INTO finance_goals")) {
      return { rows: [goalRow()] };
    }
    return { rows: [] };
  });
  const repository = new PgPlanningRepository(db.pool);

  const result = await repository.createGoal(
    "shared",
    {
      id: "goal-trip",
      name: "Family trip",
      purpose: "vacation",
      target_amount_minor: 500_000,
      currency_code: "USD",
      target_on: "2026-08-01",
      audit_event_id: "audit-create",
    },
    { type: "member", id: "member-1" },
  );

  const insert = db.calls.find((call) =>
    call.sql.startsWith("INSERT INTO finance_goals"),
  );
  assert.match(insert.sql, /\bpurpose\b/);
  assert.equal(insert.params[3], "vacation");
  assert.equal(result.goal.purpose, "vacation");
  assert.equal(result.goal.archive_outcome, null);
});

test("goal updates stay active-only and archival records its outcome", async () => {
  let state = goalRow({
    recorded_allocations: [
      { source: "cash", amount_minor: "500" },
    ],
    spending: [{ source: "cash", amount_minor: "100" }],
  });
  const db = transactionalPool(async (sql, params) => {
    if (sql.includes("FROM finance_goals goal")) {
      return { rows: [state] };
    }
    if (
      sql.startsWith("UPDATE finance_goals") &&
      sql.includes("purpose = COALESCE")
    ) {
      state = goalRow({
        ...state,
        name: params[2] ?? state.name,
        purpose: params[3] ?? state.purpose,
        version: String(Number(state.version) + 1),
      });
      return { rows: [state] };
    }
    if (
      sql.startsWith("UPDATE finance_goals") &&
      sql.includes("status = 'archived'")
    ) {
      state = goalRow({
        ...state,
        status: "archived",
        archived_at: "2026-08-10T12:00:00.000Z",
        archive_outcome: params[4] ?? "completed",
        version: String(Number(state.version) + 1),
      });
      return { rows: [{ id: state.id }] };
    }
    return { rows: [] };
  });
  const repository = new PgPlanningRepository(db.pool);
  const actor = { type: "member", id: "member-1" };

  const updated = await repository.updateGoal(
    "shared",
    "goal-trip",
    { purpose: "event" },
    1,
    actor,
    { auditEventId: "audit-update" },
  );
  assert.equal(updated.goal.purpose, "event");
  const update = db.calls.find(
    (call) =>
      call.sql.startsWith("UPDATE finance_goals") &&
      call.sql.includes("purpose = COALESCE"),
  );
  assert.match(update.sql, /AND status = 'active'/);
  assert.equal(update.params[3], "event");

  const archived = await repository.archiveGoal(
    "shared",
    "goal-trip",
    2,
    actor,
    {
      auditEventId: "audit-archive",
      outcome: "completed",
    },
  );
  const archive = db.calls.find(
    (call) =>
      call.sql.startsWith("UPDATE finance_goals") &&
      call.sql.includes("status = 'archived'"),
  );
  assert.equal(archive.params[4], "completed");
  assert.equal(archived.goal.status, "archived");
  assert.equal(archived.goal.archive_outcome, "completed");
  assert.deepEqual(archived.goal.allocations, []);
  assert.equal(
    archived.goal.recorded_allocations[0].amount_minor,
    500,
  );
  assert.equal(archived.audit_event_id, "audit-archive");
});
