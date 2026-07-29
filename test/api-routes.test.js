import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import express from "express";
import request from "supertest";

import { createApiRouter } from "../app/routes/api.js";
import { createWebRouter } from "../app/routes/web.js";

function apiApp(financeService) {
  const app = express();
  app.use(express.json());
  app.use(createApiRouter({ financeService }));
  return app;
}

function planningApiApp(planningService) {
  const app = express();
  app.use(express.json());
  app.use(
    createApiRouter({
      financeService: {},
      planningService,
    }),
  );
  return app;
}

test("Plaid Link uses an opaque member ID and server-owned OAuth redirect", async () => {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.user = {
      id: "member-opaque-1",
      email: "member@example.com",
    };
    next();
  });
  app.use(
    createApiRouter({
      requireAdmin: (_request, _response, next) => next(),
      requireCsrf: (_request, _response, next) => next(),
      financeService: {},
      plaidRedirectUri: "https://money.example.com/plaid/oauth",
      plaidSyncService: {
        createLinkToken(input) {
          calls.push(input);
          return {
            linkToken: "link-production",
            expiration: "2026-08-01T00:00:00Z",
          };
        },
        createUpdateLinkToken(input) {
          calls.push(input);
          return {
            linkToken: "link-update-production",
            expiration: "2026-08-01T00:00:00Z",
          };
        },
      },
    }),
  );

  await request(app)
    .post("/api/v1/plaid/link-token")
    .send({ redirect_uri: "https://evil.example/plaid/oauth" })
    .expect(200, {
      link_token: "link-production",
      expiration: "2026-08-01T00:00:00Z",
    });
  await request(app)
    .post("/api/v1/plaid/items/item-1/link-token")
    .send({ redirect_uri: "https://evil.example/plaid/oauth" })
    .expect(200, {
      link_token: "link-update-production",
      expiration: "2026-08-01T00:00:00Z",
    });

  assert.deepEqual(calls, [
    {
      userId: "member-opaque-1",
      redirectUri: "https://money.example.com/plaid/oauth",
    },
    {
      itemId: "item-1",
      userId: "member-opaque-1",
      redirectUri: "https://money.example.com/plaid/oauth",
    },
  ]);
});

test("Safe-to-Spend REST preserves expected-bill projection metadata", async () => {
  const payload = {
    data: {
      liquid_cash: { amount_minor: 1_000_000, currency: "USD" },
      current_card_liabilities: {
        amount_minor: 0,
        currency: "USD",
      },
      expected_bills: { amount_minor: 500_000, currency: "USD" },
      expected_bill_occurrence_count: 1,
      expected_bills_through_on: "2026-08-27",
      excluded_expected_bill_count: 0,
      cash_goal_earmarks: { amount_minor: 0, currency: "USD" },
      safe_to_spend: { amount_minor: 500_000, currency: "USD" },
    },
    warnings: [],
  };
  const app = planningApiApp({
    async getSafeToSpend() {
      return payload;
    },
  });

  await request(app)
    .get("/api/v1/plan/safe-to-spend")
    .expect(200, payload);
});

test("a fresh budget can create its first current standing category from the browser route", async () => {
  const calls = [];
  const app = planningApiApp({
    executeIdempotentWrite(operation, input, actor) {
      calls.push({ operation, input, actor });
      return { saved: true };
    },
  });

  await request(app)
    .post("/api/v1/plan/budget")
    .send({
      category: "Childcare",
      amount_minor: 120_000,
      expected_version: 0,
      idempotency_key: "budget-childcare-2026-08",
    })
    .expect(200, { saved: true });

  assert.deepEqual(calls, [
    {
      operation: "set_category_budget",
      input: {
        category: "Childcare",
        amount_minor: 120_000,
        expected_version: 0,
        idempotency_key: "budget-childcare-2026-08",
      },
      actor: undefined,
    },
  ]);
});

test("the browser can submit one idempotent atomic budget batch", async () => {
  const calls = [];
  const app = planningApiApp({
    executeIdempotentWrite(operation, input, actor) {
      calls.push({ operation, input, actor });
      return { saved: true };
    },
  });
  const lines = [
    {
      category_id: "category_car",
      amount_minor: 30_000,
      tracking_mode: "tracked",
      expected_version: 0,
    },
    {
      category_id: "category_home",
      amount_minor: 200_000,
      tracking_mode: "tracked",
      expected_version: 2,
    },
  ];

  await request(app)
    .post("/api/v1/plan/budget/batch")
    .send({
      lines,
      idempotency_key: "budget-car-home-2026-08",
    })
    .expect(200, { saved: true });

  assert.deepEqual(calls, [
    {
      operation: "set_category_budgets",
      input: {
        lines,
        idempotency_key: "budget-car-home-2026-08",
      },
      actor: undefined,
    },
  ]);
});

test("transaction goal-spending routes read, spend, and reverse with path-bound IDs", async () => {
  const calls = [];
  const middlewareCalls = [];
  const actor = {
    id: "member-1",
    email: "member@example.com",
  };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.user = actor;
    next();
  });
  app.use(
    createApiRouter({
      requireCsrf(request, _response, next) {
        middlewareCalls.push(request.method);
        next();
      },
      financeService: {},
      planningService: {
        getTransactionGoalSpending(input) {
          calls.push(["read", input]);
          return {
            data: {
              transaction_id: input.transaction_id,
              goal_spend_version: 2,
              goal_spends: [],
            },
          };
        },
        executeIdempotentWrite(operation, input, routeActor) {
          calls.push([operation, input, routeActor]);
          return {
            title:
              operation === "spend_from_finance_goal"
                ? "Goal spending recorded"
                : "Goal spending reversed",
          };
        },
      },
    }),
  );

  await request(app)
    .get("/api/v1/transactions/txn-1/goal-spends")
    .expect(200)
    .expect(({ body }) => {
      assert.equal(body.data.transaction_id, "txn-1");
      assert.equal(body.data.goal_spend_version, 2);
    });

  await request(app)
    .post("/api/v1/transactions/txn-1/goal-spends")
    .send({
      transaction_id: "spoofed-transaction",
      goal_id: "goal-1",
      source: "cash",
      amount_minor: 12_500,
      expected_goal_version: 3,
      expected_transaction_version: 2,
      idempotency_key: "goal-spend-txn-1-v2",
    })
    .expect(201, { title: "Goal spending recorded" });

  await request(app)
    .delete(
      "/api/v1/transactions/txn-1/goal-spends/goal-spend-1",
    )
    .send({
      transaction_id: "spoofed-transaction",
      goal_spend_id: "spoofed-spend",
      expected_goal_version: 4,
      expected_transaction_version: 3,
      idempotency_key: "goal-spend-reverse-txn-1-v3",
    })
    .expect(200, { title: "Goal spending reversed" });

  assert.deepEqual(middlewareCalls, ["POST", "DELETE"]);
  assert.deepEqual(calls, [
    ["read", { transaction_id: "txn-1" }],
    [
      "spend_from_finance_goal",
      {
        transaction_id: "txn-1",
        goal_id: "goal-1",
        source: "cash",
        amount_minor: 12_500,
        expected_goal_version: 3,
        expected_transaction_version: 2,
        idempotency_key: "goal-spend-txn-1-v2",
      },
      actor,
    ],
    [
      "reverse_goal_spend",
      {
        transaction_id: "txn-1",
        goal_spend_id: "goal-spend-1",
        expected_goal_version: 4,
        expected_transaction_version: 3,
        idempotency_key: "goal-spend-reverse-txn-1-v3",
      },
      actor,
    ],
  ]);
});

test("transaction goal-spending writes require idempotency keys", async () => {
  let called = false;
  const app = planningApiApp({
    executeIdempotentWrite() {
      called = true;
      return { saved: true };
    },
  });

  await request(app)
    .post("/api/v1/transactions/txn-1/goal-spends")
    .send({
      goal_id: "goal-1",
      source: "cash",
      amount_minor: 12_500,
      expected_goal_version: 3,
      expected_transaction_version: 2,
    })
    .expect(400);
  await request(app)
    .delete(
      "/api/v1/transactions/txn-1/goal-spends/goal-spend-1",
    )
    .send({
      expected_goal_version: 4,
      expected_transaction_version: 3,
    })
    .expect(400);

  assert.equal(called, false);
});

test("finance REST routes pass account and portfolio filters through", async () => {
  const calls = [];
  const app = apiApp({
    listAccounts(input) {
      calls.push(["accounts", input]);
      return { data: { groups: [] } };
    },
    getPortfolioSummary(input) {
      calls.push(["portfolio", input]);
      return { data: { holdings: [] } };
    },
  });

  await request(app)
    .get(
      "/api/v1/accounts?account_type=investment&institution_id=ins_1&balance_group=retirement&include_closed=true&limit=17&cursor=next",
    )
    .expect(200);
  await request(app)
    .get(
      "/api/v1/portfolio?period=1y&account_id=acc_1&scope=retirement&retirement_scope=only&holdings_limit=23&start_on=2025-07-01&end_on=2026-07-01",
    )
    .expect(200);

  assert.deepEqual(calls, [
    [
      "accounts",
      {
        accountType: "investment",
        institutionId: "ins_1",
        balanceGroup: "retirement",
        includeClosed: true,
        limit: 17,
        cursor: "next",
      },
    ],
    [
      "portfolio",
      {
        startOn: "2025-07-01",
        endOn: "2026-07-01",
        period: "1y",
        accountId: "acc_1",
        scope: "retirement",
        retirementScope: "only",
        holdingsLimit: 23,
      },
    ],
  ]);
});

test("wealth mutation routes validate and call the finance service", async () => {
  const calls = [];
  const app = apiApp({
    updateAccountBalanceGroup(input) {
      calls.push(["group", input]);
      return { updated: true };
    },
    createManualAsset(input) {
      calls.push(["create", input]);
      return { created: true, asset: { id: "asset_1" } };
    },
    updateManualAsset(input) {
      calls.push(["update", input]);
      return { updated: true };
    },
    archiveManualAsset(input) {
      calls.push(["archive", input]);
      return { archived: true };
    },
  });

  await request(app)
    .put("/api/v1/accounts/acc_1/balance-group")
    .send({ balance_group: "taxable_investment" })
    .expect(200);
  await request(app)
    .put("/api/v1/accounts/acc_1/balance-group")
    .send({ balance_group: null })
    .expect(200);

  const asset = {
    name: "Home",
    asset_type: "real_estate",
    description: "Independent appraisal",
    currency_code: "USD",
    value_minor: 42_500_000,
    valued_on: "2026-07-26",
  };
  await request(app).post("/api/v1/manual-assets").send(asset).expect(201);
  await request(app)
    .put("/api/v1/manual-assets/asset_1")
    .send({ ...asset, value_minor: 43_000_000 })
    .expect(200);
  await request(app)
    .delete("/api/v1/manual-assets/asset_1")
    .expect(200);

  assert.deepEqual(calls, [
    [
      "group",
      {
        account_id: "acc_1",
        balance_group: "taxable_investment",
        user_id: undefined,
      },
    ],
    [
      "group",
      {
        account_id: "acc_1",
        balance_group: null,
        user_id: undefined,
      },
    ],
    [
      "create",
      {
        ...asset,
        user_id: undefined,
      },
    ],
    [
      "update",
      {
        asset_id: "asset_1",
        ...asset,
        value_minor: 43_000_000,
        user_id: undefined,
      },
    ],
    [
      "archive",
      {
        asset_id: "asset_1",
        user_id: undefined,
      },
    ],
  ]);
});

test("wealth mutation routes reject bad groups and invalid asset money", async () => {
  const app = apiApp({
    updateAccountBalanceGroup() {
      throw new Error("must not be called");
    },
    createManualAsset() {
      throw new Error("must not be called");
    },
  });

  await request(app)
    .put("/api/v1/accounts/acc_1/balance-group")
    .send({ balance_group: "vibes" })
    .expect(400);
  await request(app)
    .post("/api/v1/manual-assets")
    .send({
      name: "Car",
      asset_type: "vehicle",
      currency_code: "USD",
      value_minor: 12.34,
      valued_on: "2026-02-31",
    })
    .expect(400);
});

test("transaction cleanup routes enforce admin mutations and preserve omitted changes", async () => {
  const calls = [];
  const middlewareCalls = [];
  const actor = {
    id: "user_admin",
    email: "admin@example.com",
    is_admin: true,
  };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.user = actor;
    next();
  });
  app.use(
    createApiRouter({
      requireAdmin(request, _response, next) {
        middlewareCalls.push(`admin:${request.method}`);
        next();
      },
      requireCsrf(request, _response, next) {
        middlewareCalls.push(`csrf:${request.method}`);
        next();
      },
      financeService: {
        findTransactionMatches(input, routeActor) {
          calls.push(["matches", input, routeActor]);
          return {
            query: input.q,
            anchor: null,
            matches: [],
            available_tags: [],
          };
        },
        batchEditTransactions(input, routeActor) {
          calls.push(["batch", input, routeActor]);
          return {
            updated_count: input.transaction_ids.length,
            transaction_ids: input.transaction_ids,
          };
        },
      },
    }),
  );

  await request(app)
    .get(
      "/api/v1/transactions/matches?transaction_id=txn_1&q=whole&limit=999",
    )
    .expect(200);
  await request(app)
    .post("/api/v1/transactions/batch-edit")
    .send({
      transaction_ids: ["txn_1", "txn_2"],
      changes: {
        display_name: "  Whole Foods  ",
        tags: ["Groceries", "Reimbursable"],
        excluded_from_spending: true,
        budget_month_offset: -1,
      },
    })
    .expect(200);

  assert.deepEqual(middlewareCalls, [
    "admin:GET",
    "admin:POST",
    "csrf:POST",
  ]);
  assert.deepEqual(calls, [
    [
      "matches",
      {
        transaction_id: "txn_1",
        q: "whole",
        limit: 50,
      },
      actor,
    ],
    [
      "batch",
      {
        transaction_ids: ["txn_1", "txn_2"],
        changes: {
          display_name: "Whole Foods",
          tags: ["Groceries", "Reimbursable"],
          excluded_from_spending: true,
          budget_month_offset: -1,
        },
      },
      actor,
    ],
  ]);
  assert.equal(
    Object.hasOwn(calls[1][1].changes, "category_primary"),
    false,
  );
});

test("transaction cleanup routes reject empty searches and malformed batches", async () => {
  let serviceCalls = 0;
  const app = apiApp({
    findTransactionMatches() {
      serviceCalls += 1;
    },
    batchEditTransactions() {
      serviceCalls += 1;
    },
  });

  await request(app)
    .get("/api/v1/transactions/matches?q=%20%20")
    .expect(400);
  await request(app)
    .post("/api/v1/transactions/batch-edit")
    .send({
      transaction_ids: ["txn_1", "txn_1"],
      changes: { tags: [] },
    })
    .expect(400);
  await request(app)
    .post("/api/v1/transactions/batch-edit")
    .send({
      transaction_ids: ["txn_1"],
      changes: {},
    })
    .expect(400);
  await request(app)
    .post("/api/v1/transactions/batch-edit")
    .send({
      transaction_ids: Array.from(
        { length: 101 },
        (_, index) => `txn_${index}`,
      ),
      changes: { tags: [] },
    })
    .expect(400);
  await request(app)
    .post("/api/v1/transactions/batch-edit")
    .send({
      transaction_ids: ["txn_1"],
      changes: { budget_month_offset: 2 },
    })
    .expect(400);

  assert.equal(serviceCalls, 0);
});

test("transaction notes are member-editable, CSRF protected, and path bound", async () => {
  const calls = [];
  const middlewareCalls = [];
  const actor = { id: "member-1", is_admin: false };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.user = actor;
    next();
  });
  app.use(
    createApiRouter({
      requireAdmin() {
        throw new Error("note route must not require admin");
      },
      requireCsrf(request, _response, next) {
        middlewareCalls.push(request.method);
        next();
      },
      financeService: {
        updateTransactionNote(input, routeActor) {
          calls.push({ input, routeActor });
          return {
            transaction_id: input.transaction_id,
            note: input.note,
            note_version: 4,
          };
        },
      },
    }),
  );

  await request(app)
    .put("/api/v1/transactions/txn-1/note")
    .send({
      transaction_id: "spoofed",
      note: "  Dinner with Sam  ",
      expected_note_version: 3,
    })
    .expect(400);
  await request(app)
    .put("/api/v1/transactions/txn-1/note")
    .send({
      note: "  Dinner with Sam  ",
      expected_note_version: 3,
    })
    .expect(200, {
      transaction_id: "txn-1",
      note: "Dinner with Sam",
      note_version: 4,
    });

  assert.deepEqual(middlewareCalls, ["PUT", "PUT"]);
  assert.deepEqual(calls, [
    {
      input: {
        transaction_id: "txn-1",
        note: "Dinner with Sam",
        expected_note_version: 3,
      },
      routeActor: actor,
    },
  ]);
});

test("insight lifecycle routes keep mutations admin-only and use DELETE for deletion", async () => {
  const calls = [];
  const middlewareCalls = [];
  const actor = {
    id: "user_admin",
    email: "admin@example.com",
    is_admin: true,
  };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.user = actor;
    next();
  });
  app.use(
    createApiRouter({
      requireAdmin(request, _response, next) {
        middlewareCalls.push(`admin:${request.method}`);
        next();
      },
      requireCsrf(request, _response, next) {
        middlewareCalls.push(`csrf:${request.method}`);
        next();
      },
      financeService: {
        actOnFinding(input, routeActor) {
          calls.push([input, routeActor]);
          return {
            updated: true,
            finding_id: input.finding_id,
            action: input.action,
          };
        },
      },
    }),
  );

  await request(app)
    .post("/api/v1/insights/finding-1/actions/archive")
    .send({})
    .expect(200);
  await request(app)
    .post("/api/v1/insights/finding-1/actions/mark_bad")
    .send({})
    .expect(200);
  await request(app)
    .post("/api/v1/insights/finding-1/actions/restore")
    .send({})
    .expect(200);
  await request(app)
    .delete("/api/v1/insights/finding-1")
    .expect(200);
  await request(app)
    .post("/api/v1/insights/finding-1/actions/delete")
    .send({})
    .expect(400);

  assert.deepEqual(calls, [
    [
      { finding_id: "finding-1", action: "archive" },
      actor,
    ],
    [
      { finding_id: "finding-1", action: "mark_bad" },
      actor,
    ],
    [
      { finding_id: "finding-1", action: "restore" },
      actor,
    ],
    [
      { finding_id: "finding-1", action: "delete" },
      actor,
    ],
  ]);
  assert.deepEqual(middlewareCalls, [
    "admin:POST",
    "csrf:POST",
    "admin:POST",
    "csrf:POST",
    "admin:POST",
    "csrf:POST",
    "admin:DELETE",
    "csrf:DELETE",
    "admin:POST",
    "csrf:POST",
  ]);
});

test("bulk insight actions validate one atomic admin request", async () => {
  const calls = [];
  const middlewareCalls = [];
  const actor = { id: "user-admin", is_admin: true };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.user = actor;
    next();
  });
  app.use(
    createApiRouter({
      requireAdmin(request, _response, next) {
        middlewareCalls.push(`admin:${request.method}`);
        next();
      },
      requireCsrf(request, _response, next) {
        middlewareCalls.push(`csrf:${request.method}`);
        next();
      },
      financeService: {
        batchActOnFindings(input, routeActor) {
          calls.push([input, routeActor]);
          return {
            updated: true,
            action: input.action,
            updated_count: input.finding_ids.length,
            finding_ids: input.finding_ids,
          };
        },
      },
    }),
  );

  await request(app)
    .post("/api/v1/insights/batch-action")
    .send({
      finding_ids: [" finding-1 ", "finding-2"],
      action: "report_incorrect",
      reason_code: "wrong_data",
    })
    .expect(200, {
      updated: true,
      action: "report_incorrect",
      updated_count: 2,
      finding_ids: ["finding-1", "finding-2"],
    });

  for (const body of [
    { finding_ids: [], action: "archive" },
    {
      finding_ids: ["finding-1", "finding-1"],
      action: "archive",
    },
    {
      finding_ids: Array.from(
        { length: 101 },
        (_, index) => `finding-${index}`,
      ),
      action: "archive",
    },
    { finding_ids: ["finding-1"], action: "delete" },
    {
      finding_ids: ["finding-1"],
      action: "report_incorrect",
    },
    {
      finding_ids: ["finding-1"],
      action: "archive",
      reason_code: "wrong_data",
    },
    {
      finding_ids: ["finding-1"],
      action: "mark_bad",
      reason_code: "made_up",
    },
  ]) {
    await request(app)
      .post("/api/v1/insights/batch-action")
      .send(body)
      .expect(400);
  }

  assert.deepEqual(calls, [
    [
      {
        finding_ids: ["finding-1", "finding-2"],
        action: "report_incorrect",
        reason_code: "wrong_data",
      },
      actor,
    ],
  ]);
  assert.deepEqual(
    middlewareCalls.slice(0, 2),
    ["admin:POST", "csrf:POST"],
  );
  assert.equal(middlewareCalls.length, 16);
});

test("insight admin controls expose status and protect run and clear mutations", async () => {
  const calls = [];
  const middlewareCalls = [];
  const actor = {
    id: "user_admin",
    email: "admin@example.com",
    is_admin: true,
  };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.user = actor;
    next();
  });
  app.use(
    createApiRouter({
      requireAdmin(request, _response, next) {
        middlewareCalls.push(`admin:${request.method}`);
        next();
      },
      requireCsrf(request, _response, next) {
        middlewareCalls.push(`csrf:${request.method}`);
        next();
      },
      financeService: {
        getInsightStatus(input) {
          calls.push(["status", input]);
          return {
            state: "ready",
            last_run_at: "2026-07-28T09:00:00.000Z",
            active_count: 4,
          };
        },
        forceRunInsights(input, routeActor) {
          calls.push(["run", input, routeActor]);
          return {
            queued: true,
            job_id: "job-insights-1",
            status: "queued",
          };
        },
        clearInsights(input, routeActor) {
          calls.push(["clear", input, routeActor]);
          return {
            cleared: true,
            findings_deleted: 4,
            feedback_preserved: true,
          };
        },
      },
    }),
  );

  await request(app)
    .get("/api/v1/settings/insights/status")
    .expect(200, {
      state: "ready",
      last_run_at: "2026-07-28T09:00:00.000Z",
      active_count: 4,
    });
  await request(app)
    .post("/api/v1/settings/insights/run")
    .send({})
    .expect(202, {
      queued: true,
      job_id: "job-insights-1",
      status: "queued",
    });
  await request(app)
    .delete("/api/v1/settings/insights")
    .expect(200, {
      cleared: true,
      findings_deleted: 4,
      feedback_preserved: true,
    });

  assert.deepEqual(calls, [
    ["status", {}],
    ["run", {}, actor],
    ["clear", {}, actor],
  ]);
  assert.deepEqual(middlewareCalls, [
    "admin:GET",
    "admin:POST",
    "csrf:POST",
    "admin:DELETE",
    "csrf:DELETE",
  ]);
});

test("quality feedback and recurring classification routes validate structured admin input", async () => {
  const calls = [];
  const actor = { id: "user-admin", is_admin: true };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.user = actor;
    next();
  });
  app.use(
    createApiRouter({
      requireAdmin: (_request, _response, next) => next(),
      requireCsrf: (_request, _response, next) => next(),
      financeService: {
        actOnFinding(input, routeActor) {
          calls.push(["insight", input, routeActor]);
          return { updated: true };
        },
        updateRecurringClassification(input, routeActor) {
          calls.push(["recurring", input, routeActor]);
          return { updated: true };
        },
        upsertTransactionRecurringPattern(input, routeActor) {
          calls.push(["pattern-upsert", input, routeActor]);
          return { updated: true };
        },
        removeTransactionRecurringPattern(input, routeActor) {
          calls.push(["pattern-remove", input, routeActor]);
          return { updated: true, removed: true };
        },
      },
    }),
  );

  await request(app)
    .post("/api/v1/insights/finding-1/actions/ignore")
    .send({})
    .expect(200);
  await request(app)
    .post(
      "/api/v1/insights/finding-1/actions/report_incorrect",
    )
    .send({ reason_code: "not_subscription" })
    .expect(200);
  await request(app)
    .post(
      "/api/v1/insights/finding-1/actions/report_incorrect",
    )
    .send({ reason_code: "freeform_nonsense" })
    .expect(400);
  await request(app)
    .put("/api/v1/recurring/stream-1/classification")
    .send({ type: "frequent_spending" })
    .expect(200);
  await request(app)
    .put(
      "/api/v1/transactions/transaction-1/recurring-pattern",
    )
    .send({
      transaction_id: "wrong-id",
      type: "bill",
      cadence: "monthly",
    })
    .expect(200);
  await request(app)
    .delete(
      "/api/v1/transactions/transaction-1/recurring-pattern",
    )
    .send({})
    .expect(200);

  assert.deepEqual(calls, [
    [
      "insight",
      { finding_id: "finding-1", action: "ignore" },
      actor,
    ],
    [
      "insight",
      {
        finding_id: "finding-1",
        action: "report_incorrect",
        reason_code: "not_subscription",
      },
      actor,
    ],
    [
      "recurring",
      { stream_id: "stream-1", type: "frequent_spending" },
      actor,
    ],
    [
      "pattern-upsert",
      {
        transaction_id: "transaction-1",
        type: "bill",
        cadence: "monthly",
      },
      actor,
    ],
    [
      "pattern-remove",
      { transaction_id: "transaction-1" },
      actor,
    ],
  ]);
});

test("spending category routes are admin-only, CSRF-protected, and preserve merge input", async () => {
  const calls = [];
  const middleware = [];
  const actor = { id: "user-admin", is_admin: true };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.user = actor;
    next();
  });
  app.use(
    createApiRouter({
      requireAdmin: (request, _response, next) => {
        middleware.push(`admin:${request.method}`);
        next();
      },
      requireCsrf: (request, _response, next) => {
        middleware.push(`csrf:${request.method}`);
        next();
      },
      financeService: {
        listSpendingCategories(input) {
          calls.push(["list", input]);
          return { categories: [] };
        },
        createSpendingCategory(input, routeActor) {
          calls.push(["create", input, routeActor]);
          return { created: true };
        },
        updateSpendingCategory(input, routeActor) {
          calls.push(["update", input, routeActor]);
          return { updated: true };
        },
        mergeSpendingCategories(input, routeActor) {
          calls.push(["merge", input, routeActor]);
          return { merged: true };
        },
        deleteSpendingCategory(input, routeActor) {
          calls.push(["delete", input, routeActor]);
          return { deleted: true };
        },
        splitSpendingCategory(input, routeActor) {
          calls.push(["split", input, routeActor]);
          return { split: true };
        },
      },
    }),
  );

  await request(app).get("/api/v1/categories").expect(200);
  await request(app)
    .post("/api/v1/categories")
    .send({
      name: "Gas",
      classification: "flexible",
      parent_category_id: "category-car",
    })
    .expect(201);
  await request(app)
    .patch("/api/v1/categories/category-gas")
    .send({ name: "Fuel", expected_version: 1 })
    .expect(200);
  const mergeBody = {
    source_category_ids: ["category-tolls"],
    destination: { category_id: "category-gas" },
    expected_versions: {
      "category-tolls": 1,
      "category-gas": 2,
    },
  };
  await request(app)
    .post("/api/v1/categories/merge")
    .send(mergeBody)
    .expect(200);
  await request(app)
    .delete("/api/v1/categories/category-gas")
    .send({ expected_version: 3 })
    .expect(200);
  await request(app)
    .post("/api/v1/categories/category-tolls/split")
    .send({ expected_version: 2 })
    .expect(200);

  assert.deepEqual(calls, [
    ["list", { include_merged: false }],
    [
      "create",
      {
        name: "Gas",
        classification: "flexible",
        parent_category_id: "category-car",
      },
      actor,
    ],
    [
      "update",
      {
        name: "Fuel",
        expected_version: 1,
        category_id: "category-gas",
      },
      actor,
    ],
    ["merge", mergeBody, actor],
    [
      "delete",
      {
        expected_version: 3,
        category_id: "category-gas",
      },
      actor,
    ],
    [
      "split",
      {
        expected_version: 2,
        category_id: "category-tolls",
      },
      actor,
    ],
  ]);
  assert.deepEqual(middleware, [
    "admin:GET",
    "admin:POST",
    "csrf:POST",
    "admin:PATCH",
    "csrf:PATCH",
    "admin:POST",
    "csrf:POST",
    "admin:DELETE",
    "csrf:DELETE",
    "admin:POST",
    "csrf:POST",
  ]);
});

test("global search passes entity filters and demo search honors them", async () => {
  let captured;
  const production = express();
  production.use(
    createWebRouter({
      financeService: {
        search(query, options) {
          captured = { query, options };
          return { query, groups: [] };
        },
      },
      demoMode: false,
    }),
  );
  await request(production)
    .get("/api/search?q=vehicle&entity_type=manual_asset")
    .expect(200);
  assert.deepEqual(captured, {
    query: "vehicle",
    options: { entityTypes: ["manual_asset"], limit: 30 },
  });

  const demo = express();
  demo.use(createWebRouter({ demoMode: true }));
  const result = await request(demo)
    .get("/api/search?q=vehicle&entity_type=manual_asset")
    .expect(200);
  assert.equal(result.body.groups.length, 1);
  assert.equal(result.body.groups[0].label, "Assets");
  assert.equal(result.body.groups[0].items[0].title, "2024 vehicle");

  await request(demo)
    .get("/api/search?q=vehicle&entity_type=bogus")
    .expect(400);
});

test("demo transaction category filters keep the detail card and ledger aligned", async () => {
  const app = express();
  app.set(
    "views",
    fileURLToPath(new URL("../app/views/", import.meta.url)),
  );
  app.set("view engine", "ejs");
  app.use(createWebRouter({ demoMode: true }));

  const result = await request(app)
    .get("/transactions?category=Fees%20%26%20Interest")
    .expect(200);

  assert.match(result.text, /<strong>\$116\.00<\/strong>/);
  assert.match(result.text, /100% · 2 transactions/);
  assert.match(result.text, /Seacomm Overdraft Fee/);
  assert.match(result.text, /Personal Loan Interest/);
  assert.doesNotMatch(result.text, /Whole Foods Market/);
});

test("legacy insight section queries still render the unified action groups", async () => {
  const app = express();
  app.set(
    "views",
    fileURLToPath(new URL("../app/views/", import.meta.url)),
  );
  app.set("view engine", "ejs");
  app.use(createWebRouter({ demoMode: true }));

  const result = await request(app)
    .get("/insights?section=weekly")
    .expect(200);

  assert.equal(
    (result.text.match(/class="insight-summary card"/g) ?? []).length,
    1,
  );
  assert.match(result.text, /id="review-now"/);
  assert.match(result.text, /id="spend-less"/);
  assert.match(result.text, /id="change-a-habit"/);
  assert.match(result.text, /id="investment-risk"/);
  assert.doesNotMatch(result.text, /role="tablist"|data-tab-panel/);
});
