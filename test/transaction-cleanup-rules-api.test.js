import assert from "node:assert/strict";
import test from "node:test";

import express from "express";
import request from "supertest";

import { createApiRouter } from "../app/routes/api.js";

function appWith({ financeService, middlewareCalls = [] }) {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.user = { id: "user_admin", is_admin: true };
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
      financeService,
    }),
  );
  return app;
}

test("cleanup rule API exposes admin CRUD with CSRF on mutations", async () => {
  const calls = [];
  const middlewareCalls = [];
  const app = appWith({
    middlewareCalls,
    financeService: {
      listTransactionCleanupRules(input) {
        calls.push(["list", input]);
        return { rules: [] };
      },
      createTransactionCleanupRule(input, actor) {
        calls.push(["create", input, actor]);
        return { created: true, rule: { id: "rule_1" } };
      },
      updateTransactionCleanupRule(input, actor) {
        calls.push(["update", input, actor]);
        return { updated: true, rule: { id: input.rule_id } };
      },
      deleteTransactionCleanupRule(input, actor) {
        calls.push(["delete", input, actor]);
        return { deleted: true, rule_id: input.rule_id };
      },
      rerunTransactionCleanupRules(input, actor) {
        calls.push(["rerun", input, actor]);
        return {
          rerun: true,
          transaction_count: 42,
          rule_count: 3,
        };
      },
    },
  });
  const body = {
    matcher: {
      field: "normalized_merchant",
      mode: "contains",
      value: "  AAPL SRV 0042  ",
      amount: { operator: "less_than", amount_minor: 5_000 },
    },
    changes: {
      display_name: "  Apple Services  ",
      category_primary: "  Subscriptions  ",
      tags: [],
    },
    enabled: true,
  };

  await request(app)
    .get("/api/v1/transaction-cleanup-rules")
    .expect(200);
  await request(app)
    .post("/api/v1/transaction-cleanup-rules")
    .send(body)
    .expect(201);
  await request(app)
    .put("/api/v1/transaction-cleanup-rules/rule_1")
    .send(body)
    .expect(200);
  await request(app)
    .delete("/api/v1/transaction-cleanup-rules/rule_1")
    .expect(200);
  await request(app)
    .post("/api/v1/transaction-cleanup-rules/rerun")
    .send({})
    .expect(200);

  const cleanedBody = {
    matcher: {
      field: "normalized_merchant",
      mode: "contains",
      value: "AAPL SRV 0042",
      amount: { operator: "less_than", amount_minor: 5_000 },
    },
    changes: {
      display_name: "Apple Services",
      category_primary: "Subscriptions",
      tags: [],
    },
    enabled: true,
  };
  assert.deepEqual(calls, [
    ["list", { include_disabled: true }],
    [
      "create",
      cleanedBody,
      { id: "user_admin", is_admin: true },
    ],
    [
      "update",
      { rule_id: "rule_1", ...cleanedBody },
      { id: "user_admin", is_admin: true },
    ],
    [
      "delete",
      { rule_id: "rule_1" },
      { id: "user_admin", is_admin: true },
    ],
    [
      "rerun",
      {},
      { id: "user_admin", is_admin: true },
    ],
  ]);
  assert.deepEqual(middlewareCalls, [
    "admin:GET",
    "admin:POST",
    "csrf:POST",
    "admin:PUT",
    "csrf:PUT",
    "admin:DELETE",
    "csrf:DELETE",
    "admin:POST",
    "csrf:POST",
  ]);
});

test("cleanup rule API accepts match-only rules and rejects malformed matchers", async () => {
  let calls = 0;
  const app = appWith({
    financeService: {
      createTransactionCleanupRule() {
        calls += 1;
      },
      updateTransactionCleanupRule() {
        calls += 1;
      },
    },
  });
  const invalidBodies = [
    {
      matcher: { field: "fuzzy", value: "Apple" },
      changes: { display_name: "Apple" },
    },
    {
      matcher: {
        field: "normalized_merchant",
        mode: "similar",
        value: "Apple",
      },
      changes: { display_name: "Apple" },
    },
    {
      matcher: {
        field: "normalized_merchant",
        value: "Apple",
        amount: { operator: "around", amount_minor: 5_000 },
      },
      changes: {},
    },
    {
      matcher: { field: "normalized_name", value: "Apple" },
      changes: { tags: "Subscriptions" },
    },
    {
      matcher: { field: "normalized_name", value: "Apple" },
      changes: { tags: [] },
      enabled: "true",
    },
    {
      matcher: { field: "normalized_name", value: "Apple" },
      changes: { display_name: "Apple" },
      surprise: true,
    },
  ];
  for (const body of invalidBodies) {
    await request(app)
      .post("/api/v1/transaction-cleanup-rules")
      .send(body)
      .expect(400);
    await request(app)
      .put("/api/v1/transaction-cleanup-rules/rule_1")
      .send(body)
      .expect(400);
  }
  await request(app)
    .post("/api/v1/transaction-cleanup-rules")
    .send({
      matcher: { field: "normalized_name", value: "Check Paid" },
      changes: {},
    })
    .expect(201);
  await request(app)
    .put("/api/v1/transaction-cleanup-rules/rule_1")
    .send({
      matcher: { field: "normalized_name", value: "Check Paid" },
      changes: {},
    })
    .expect(200);
  assert.equal(calls, 2);
});
