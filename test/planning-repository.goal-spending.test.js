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
      return handler(query, params, calls);
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
        return handler(query, params, calls);
      },
    },
  };
}

test("goal reads spill source overruns across the remaining funding", async () => {
  const db = transactionalPool(async () => ({
    rows: [
      {
        id: "goal-trip",
        name: "Family trip",
        target_amount_minor: "5000",
        currency_code: "USD",
        target_on: null,
        status: "active",
        version: "4",
        recorded_allocations: [
          { source: "cash", amount_minor: "1000" },
          { source: "brokerage", amount_minor: "2000" },
        ],
        spending: [
          { source: "cash", amount_minor: "1300" },
          { source: "brokerage", amount_minor: "500" },
        ],
        schedules: [],
      },
      {
        id: "goal-cross-source-over",
        name: "Cross-source overrun",
        target_amount_minor: "10000",
        currency_code: "USD",
        target_on: null,
        status: "active",
        version: "2",
        recorded_allocations: [
          { source: "cash", amount_minor: "10000" },
          { source: "brokerage", amount_minor: "0" },
        ],
        spending: [
          { source: "brokerage", amount_minor: "11000" },
        ],
        schedules: [],
      },
      {
        id: "goal-cross-source-partial",
        name: "Cross-source partial",
        target_amount_minor: "10000",
        currency_code: "USD",
        target_on: null,
        status: "active",
        version: "2",
        recorded_allocations: [
          { source: "cash", amount_minor: "5000" },
          { source: "brokerage", amount_minor: "5000" },
        ],
        spending: [
          { source: "brokerage", amount_minor: "8000" },
        ],
        schedules: [],
      },
    ],
  }));
  const repository = new PgPlanningRepository(db.pool);

  const [goal, overrun, partial] =
    await repository.listGoals("shared");

  assert.deepEqual(goal.recorded_allocations, [
    { source: "cash", amount_minor: 1_000 },
    { source: "brokerage", amount_minor: 2_000 },
  ]);
  assert.deepEqual(goal.spending, [
    { source: "cash", amount_minor: 1_300 },
    { source: "brokerage", amount_minor: 500 },
  ]);
  assert.deepEqual(goal.allocations, [
    { source: "brokerage", amount_minor: 1_200 },
    { source: "cash", amount_minor: 0 },
  ]);
  assert.deepEqual(overrun.allocations, [
    { source: "brokerage", amount_minor: 0 },
    { source: "cash", amount_minor: 0 },
  ]);
  assert.deepEqual(partial.allocations, [
    { source: "brokerage", amount_minor: 0 },
    { source: "cash", amount_minor: 2_000 },
  ]);
  assert.match(
    db.calls[0].sql,
    /FROM goal_transaction_spends WHERE goal_id = goal\.id AND status = 'active'/,
  );
});

test("goal reads keep the parent ID on funding schedules", async () => {
  const db = transactionalPool(async () => ({
    rows: [
      {
        id: "goal-trip",
        name: "Family trip",
        target_amount_minor: "5000",
        currency_code: "USD",
        target_on: null,
        status: "active",
        version: "4",
        recorded_allocations: [],
        spending: [],
        schedules: [
          {
            id: "schedule-trip",
            source: "cash",
            cadence: "biweekly_friday",
            amount_minor: "100",
            monthly_day: null,
            anchor_on: "2026-07-31",
            next_run_on: "2026-07-31",
            status: "active",
            version: "1",
          },
        ],
      },
    ],
  }));
  const repository = new PgPlanningRepository(db.pool);

  const [goal] = await repository.listGoals("shared");

  assert.equal(goal.schedules[0].goal_id, "goal-trip");
  assert.match(
    db.calls[0].sql,
    /'goal_id', funding\.goal_id/,
  );
});

test("transaction goal-spending reads expose the optimistic parent version", async () => {
  let queryNumber = 0;
  const db = transactionalPool(async (sql) => {
    queryNumber += 1;
    if (sql.includes("FROM transactions")) {
      return {
        rows: [
          {
            id: "transaction-1",
            provider_transaction_id: "provider-1",
            amount_minor: "-1000",
            currency_code: "USD",
            posted_on: "2026-07-27",
            pending: false,
            goal_spend_version: "3",
          },
        ],
      };
    }
    return {
      rows: [
        {
          id: "spend-1",
          transaction_id: "transaction-1",
          transaction_provider_id: "provider-1",
          goal_id: "goal-trip",
          source: "cash",
          line_index: "0",
          amount_minor: "600",
          status: "active",
        },
      ],
    };
  });
  const repository = new PgPlanningRepository(db.pool);

  const result = await repository.getTransactionGoalSpending(
    "shared",
    "transaction-1",
  );

  assert.equal(queryNumber, 2);
  assert.equal(result.goal_spend_version, 3);
  assert.equal(result.transaction.amount_minor, -1_000);
  assert.equal(result.goal_spends[0].amount_minor, 600);
  assert.equal(result.goal_spends[0].source, "cash");
  assert.match(
    db.calls[0].sql,
    /JOIN transaction_effective_spending_treatments treatment/,
  );
});

test("active goal-spend totals are batched and ignore ended history", async () => {
  const db = transactionalPool(async () => ({
    rows: [
      {
        transaction_id: "transaction-1",
        amount_minor: "7000000",
      },
      {
        transaction_id: "transaction-2",
        amount_minor: "1250",
      },
    ],
  }));
  const repository = new PgPlanningRepository(db.pool);

  const result = await repository.listActiveGoalSpendTotals(
    "shared",
    ["transaction-2", "transaction-1", "transaction-2"],
  );

  assert.deepEqual(result, [
    { transaction_id: "transaction-1", amount_minor: 7_000_000 },
    { transaction_id: "transaction-2", amount_minor: 1_250 },
  ]);
  assert.deepEqual(db.calls[0].params, [
    "shared",
    ["transaction-2", "transaction-1"],
  ]);
  assert.match(
    db.calls[0].sql,
    /transaction_id = ANY\(\$2::text\[\]\)/,
  );
  assert.match(db.calls[0].sql, /status = 'active'/);
  assert.match(
    db.calls[0].sql,
    /SUM\(amount_minor\)::bigint AS amount_minor/,
  );
});

test("identical goal-spending replacement is a true no-op", async () => {
  const db = transactionalPool(async (sql) => {
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
    if (sql.includes("FROM transactions")) {
      return {
        rows: [
          {
            id: "transaction-1",
            provider_transaction_id: "provider-1",
            amount_minor: "-1000",
            currency_code: "USD",
            posted_on: "2026-07-27",
            pending: false,
            goal_spend_version: "2",
          },
        ],
      };
    }
    if (sql.includes("FROM goal_transaction_spends")) {
      return {
        rows: [
          {
            id: "spend-existing",
            transaction_id: "transaction-1",
            transaction_provider_id: "provider-1",
            goal_id: "goal-trip",
            source: "cash",
            line_index: "0",
            amount_minor: "600",
            status: "active",
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgPlanningRepository(db.pool);

  const result = await repository.replaceTransactionGoalSpending(
    "shared",
    "transaction-1",
    [
      {
        id: "spend-new-request-id",
        line_index: 0,
        goal_id: "goal-trip",
        source: "cash",
        amount_minor: 600,
      },
    ],
    2,
    { "goal-trip": 4 },
    { type: "member", id: "member-1" },
    "audit-noop",
  );

  assert.equal(result.noop, true);
  assert.equal(result.goal_spend_version, 2);
  assert.equal(result.audit_event_id, null);
  assert.equal(
    db.calls.some((call) =>
      call.sql.startsWith("UPDATE goal_transaction_spends"),
    ),
    false,
  );
  assert.equal(
    db.calls.some((call) =>
      call.sql.startsWith("INSERT INTO plan_audit_events"),
    ),
    false,
  );
});

test("goal-spending replacement permits overspending and advances versions", async () => {
  let spendSelectCount = 0;
  const inserted = {
    id: "spend-new",
    transaction_id: "transaction-1",
    transaction_provider_id: "provider-1",
    goal_id: "goal-trip",
    source: "cash",
    line_index: "0",
    amount_minor: "900",
    status: "active",
  };
  const db = transactionalPool(async (sql) => {
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
    if (
      sql.startsWith("SELECT t.id") &&
      sql.includes("FROM transactions")
    ) {
      return {
        rows: [
          {
            id: "transaction-1",
            provider_transaction_id: "provider-1",
            amount_minor: "-1000",
            currency_code: "USD",
            posted_on: "2026-07-27",
            pending: false,
            goal_spend_version: "0",
          },
        ],
      };
    }
    if (
      sql.startsWith("SELECT spend.*") &&
      sql.includes("FROM goal_transaction_spends")
    ) {
      spendSelectCount += 1;
      return { rows: spendSelectCount === 1 ? [] : [inserted] };
    }
    if (sql.includes("FROM finance_goals")) {
      return {
        rows: [
          {
            id: "goal-trip",
            workspace_id: "shared",
            status: "active",
            version: "4",
            archived_at: null,
          },
        ],
      };
    }
    if (sql.startsWith("UPDATE finance_goals")) {
      return {
        rows: [
          {
            id: "goal-trip",
            status: "active",
            version: "5",
            archived_at: null,
          },
        ],
      };
    }
    if (sql.startsWith("UPDATE transactions")) {
      return { rows: [{ goal_spend_version: "1" }] };
    }
    return { rows: [] };
  });
  const repository = new PgPlanningRepository(db.pool);

  const result = await repository.replaceTransactionGoalSpending(
    "shared",
    "transaction-1",
    [
      {
        id: "spend-new",
        line_index: 0,
        goal_id: "goal-trip",
        source: "cash",
        amount_minor: 900,
      },
    ],
    0,
    { "goal-trip": 4 },
    { type: "member", id: "member-1" },
    "audit-spend",
  );

  assert.equal(result.goal_spend_version, 1);
  assert.equal(result.goal_spends[0].amount_minor, 900);
  assert.equal(result.goals[0].version, 5);
  assert.equal(result.audit_event_id, "audit-spend");
  const lockedTransaction = db.calls.find(
    (call) =>
      call.sql.startsWith("SELECT t.id") &&
      call.sql.includes("FOR UPDATE"),
  );
  assert.match(
    lockedTransaction.sql,
    /JOIN transaction_effective_spending_treatments treatment/,
  );
  assert.match(
    lockedTransaction.sql,
    /treatment\.effective_excluded_from_spending AS excluded_from_spending/,
  );
  assert.match(lockedTransaction.sql, /FOR UPDATE OF t/);
  assert.equal(
    db.calls.some((call) =>
      call.sql.includes("pg_advisory_xact_lock"),
    ),
    true,
  );
  assert.equal(
    db.calls.some((call) =>
      call.sql.startsWith("WITH affected(goal_id) AS"),
    ),
    false,
  );
  assert.equal(
    db.calls.some((call) =>
      call.sql.startsWith("INSERT INTO goal_allocation_events"),
    ),
    false,
  );
  const goalUpdate = db.calls.find((call) =>
    call.sql.startsWith("UPDATE finance_goals"),
  );
  assert.match(
    goalUpdate.sql,
    /archive_outcome = CASE WHEN id = ANY\(\$3::text\[\]\) THEN NULL/,
  );
});

test("ineligible transactions may reduce existing goal spending", async () => {
  let spendSelectCount = 0;
  const existing = {
    id: "spend-existing",
    transaction_id: "transaction-1",
    transaction_provider_id: "provider-1",
    goal_id: "goal-trip",
    source: "cash",
    line_index: "0",
    amount_minor: "600",
    status: "active",
  };
  const reduced = {
    ...existing,
    id: "spend-reduced",
    amount_minor: "300",
  };
  const db = transactionalPool(async (sql) => {
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
    if (
      sql.startsWith("SELECT t.id") &&
      sql.includes("FROM transactions")
    ) {
      return {
        rows: [
          {
            id: "transaction-1",
            provider_transaction_id: "provider-1",
            amount_minor: "-1000",
            currency_code: "USD",
            posted_on: "2026-07-27",
            pending: false,
            excluded_from_spending: true,
            goal_spend_version: "3",
          },
        ],
      };
    }
    if (
      sql.startsWith("SELECT spend.*") &&
      sql.includes("FROM goal_transaction_spends")
    ) {
      spendSelectCount += 1;
      return {
        rows: spendSelectCount === 1 ? [existing] : [reduced],
      };
    }
    if (sql.includes("FROM finance_goals")) {
      return {
        rows: [
          {
            id: "goal-trip",
            workspace_id: "shared",
            status: "active",
            version: "4",
            archived_at: null,
          },
        ],
      };
    }
    if (sql.startsWith("UPDATE finance_goals")) {
      return {
        rows: [
          {
            id: "goal-trip",
            status: "active",
            version: "5",
            archived_at: null,
          },
        ],
      };
    }
    if (sql.startsWith("UPDATE transactions")) {
      return { rows: [{ goal_spend_version: "4" }] };
    }
    return { rows: [] };
  });
  const repository = new PgPlanningRepository(db.pool);

  const result = await repository.replaceTransactionGoalSpending(
    "shared",
    "transaction-1",
    [
      {
        id: "spend-reduced",
        line_index: 0,
        goal_id: "goal-trip",
        source: "cash",
        amount_minor: 300,
      },
    ],
    3,
    { "goal-trip": 4 },
    { type: "member", id: "member-1" },
    "audit-reduce",
  );

  assert.equal(result.validation, undefined);
  assert.equal(result.goal_spends[0].amount_minor, 300);
  assert.equal(result.goal_spend_version, 4);
  assert.equal(
    db.calls.some(
      (call) =>
        call.sql.startsWith("UPDATE goal_transaction_spends") &&
        call.params[2]?.includes("spend-existing"),
    ),
    true,
  );
  assert.equal(
    db.calls.some((call) =>
      call.sql.startsWith("INSERT INTO goal_transaction_spends"),
    ),
    true,
  );
});

test("ineligible transactions still reject increased goal spending", async () => {
  const db = transactionalPool(async (sql) => {
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
    if (sql.includes("FROM transactions")) {
      return {
        rows: [
          {
            id: "transaction-1",
            provider_transaction_id: "provider-1",
            amount_minor: "-1000",
            currency_code: "USD",
            posted_on: "2026-07-27",
            pending: false,
            excluded_from_spending: true,
            goal_spend_version: "0",
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgPlanningRepository(db.pool);

  const result = await repository.replaceTransactionGoalSpending(
    "shared",
    "transaction-1",
    [
      {
        id: "spend-new",
        line_index: 0,
        goal_id: "goal-trip",
        source: "cash",
        amount_minor: 100,
      },
    ],
    0,
    { "goal-trip": 1 },
    { type: "member", id: "member-1" },
    "audit-blocked",
  );

  assert.equal(result.validation, true);
  assert.equal(result.code, "transaction_not_posted_usd_expense");
  assert.equal(
    db.calls.some((call) =>
      call.sql.startsWith("INSERT INTO goal_transaction_spends"),
    ),
    false,
  );
});

test("goal spending remains capped by the source transaction", async () => {
  const db = transactionalPool(async (sql) => {
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
    if (sql.includes("FROM transactions")) {
      return {
        rows: [
          {
            id: "transaction-1",
            provider_transaction_id: "provider-1",
            amount_minor: "-1000",
            currency_code: "USD",
            posted_on: "2026-07-27",
            pending: false,
            goal_spend_version: "0",
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgPlanningRepository(db.pool);

  const result = await repository.replaceTransactionGoalSpending(
    "shared",
    "transaction-1",
    [
      {
        id: "spend-new",
        line_index: 0,
        goal_id: "goal-trip",
        source: "cash",
        amount_minor: 1_001,
      },
    ],
    0,
    { "goal-trip": 1 },
    { type: "member", id: "member-1" },
    "audit-too-much",
  );

  assert.equal(result.validation, true);
  assert.equal(result.code, "goal_spend_exceeds_transaction");
  assert.equal(
    db.calls.some((call) =>
      call.sql.startsWith("INSERT INTO goal_transaction_spends"),
    ),
    false,
  );
});

test("archived goals still reject new transaction spending", async () => {
  const db = transactionalPool(async (sql) => {
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
    if (sql.includes("FROM transactions")) {
      return {
        rows: [
          {
            id: "transaction-1",
            provider_transaction_id: "provider-1",
            amount_minor: "-1000",
            currency_code: "USD",
            posted_on: "2026-07-27",
            pending: false,
            goal_spend_version: "0",
          },
        ],
      };
    }
    if (
      sql.startsWith("SELECT spend.*") &&
      sql.includes("FROM goal_transaction_spends")
    ) {
      return { rows: [] };
    }
    if (sql.includes("FROM finance_goals")) {
      return {
        rows: [
          {
            id: "goal-trip",
            workspace_id: "shared",
            status: "archived",
            version: "1",
            archived_at: "2026-07-27T12:00:00.000Z",
            archive_outcome: "completed",
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgPlanningRepository(db.pool);

  const result = await repository.replaceTransactionGoalSpending(
    "shared",
    "transaction-1",
    [
      {
        id: "spend-new",
        line_index: 0,
        goal_id: "goal-trip",
        source: "cash",
        amount_minor: 100,
      },
    ],
    0,
    { "goal-trip": 1 },
    { type: "member", id: "member-1" },
    "audit-archived",
  );

  assert.equal(result.validation, true);
  assert.equal(result.code, "goal_archived");
  assert.equal(
    db.calls.some((call) =>
      call.sql.startsWith("INSERT INTO goal_transaction_spends"),
    ),
    false,
  );
});
