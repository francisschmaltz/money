import assert from "node:assert/strict";
import test from "node:test";

import { createFinanceService } from "../app/services/financeService.js";

function storedRule(overrides = {}) {
  return {
    id: "cleanup_rule_1",
    match_field: "normalized_merchant",
    match_mode: "exact",
    match_value: "AAPL SRV 0042",
    normalized_match_value: "aapl srv",
    display_name: "Apple Services",
    category_primary: "Subscriptions",
    tags: ["Recurring"],
    enabled: true,
    matched_transaction_count: 4,
    created_at: "2026-07-27T12:00:00.000Z",
    updated_at: "2026-07-27T12:00:00.000Z",
    ...overrides,
  };
}

test("cleanup rule service normalizes matchers and returns their mode", async () => {
  const calls = [];
  const jobs = [];
  const repository = {
    async listTransactionCleanupRules(workspaceId, options) {
      calls.push(["list", workspaceId, options]);
      return [storedRule()];
    },
    async createTransactionCleanupRule(workspaceId, input) {
      calls.push(["create", workspaceId, input]);
      return storedRule({
        match_mode: input.matchMode,
        match_value: input.matchValue,
        normalized_match_value: input.normalizedMatchValue,
        match_amount_operator: input.matchAmountOperator,
        match_amount_minor: input.matchAmountMinor,
        display_name: input.displayName,
        category_primary: input.categoryPrimary,
        cash_flow_role: input.cashFlowRole,
        tags: input.tags,
        enabled: input.enabled,
      });
    },
  };
  const service = createFinanceService({
    repository,
    jobQueue: {
      async enqueue(...args) {
        jobs.push(args);
      },
    },
  });

  const listed = await service.listTransactionCleanupRules();
  assert.deepEqual(listed, {
    rules: [
      {
        id: "cleanup_rule_1",
        matcher: {
          field: "normalized_merchant",
          mode: "exact",
          value: "AAPL SRV 0042",
          normalized_value: "aapl srv",
        },
        changes: {
          display_name: "Apple Services",
          category_primary: "Subscriptions",
          tags: ["Recurring"],
        },
        enabled: true,
        matched_transaction_count: 4,
        created_at: "2026-07-27T12:00:00.000Z",
        updated_at: "2026-07-27T12:00:00.000Z",
      },
    ],
  });

  const created = await service.createTransactionCleanupRule(
    {
      matcher: {
        field: "normalized_merchant",
        mode: "contains",
        value: "  AAPL SRV 0042  ",
        amount: { operator: "more_than", amount_minor: 100_000 },
      },
      changes: {
        display_name: "Apple Services",
        category_primary: "bank fees",
        cash_flow_role: "obligation",
        tags: [],
      },
      enabled: false,
    },
    { id: "user_admin" },
  );

  assert.equal(created.created, true);
  assert.deepEqual(created.rule.matcher, {
    field: "normalized_merchant",
    mode: "contains",
    value: "AAPL SRV 0042",
    normalized_value: "aapl srv",
    amount: { operator: "more_than", amount_minor: 100_000 },
  });
  assert.deepEqual(created.rule.changes, {
    display_name: "Apple Services",
    category_primary: "Fees & Interest",
    cash_flow_role: "obligation",
    tags: [],
  });
  assert.deepEqual(calls[0], [
    "list",
    "shared",
    { includeDisabled: true },
  ]);
  assert.deepEqual(calls[1], [
    "create",
    "shared",
    {
      matchField: "normalized_merchant",
      matchMode: "contains",
      matchValue: "AAPL SRV 0042",
      normalizedMatchValue: "aapl srv",
      matchAmountOperator: "more_than",
      matchAmountMinor: 100_000,
      displayName: "Apple Services",
      categoryPrimary: "Fees & Interest",
      cashFlowRole: "obligation",
      tags: [],
      enabled: false,
      userId: "user_admin",
    },
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(jobs, [
    [
      "finance.detect_recurring",
      { workspaceId: "shared" },
      { dedupeKey: "shared" },
    ],
  ]);
});

test("settings page data preserves manual asset values and cleanup rules", async () => {
  const repository = {
    async getDataFreshness() {
      return {
        data_as_of: "2026-07-26T18:42:00.000Z",
        partial: false,
        warnings: [],
      };
    },
    async listPlaidItems() {
      return [];
    },
    async getInsightRules() {
      return {};
    },
    async listTransactionCategories() {
      return [];
    },
    async listManualAssets() {
      return [
        {
          id: "asset-car",
          name: "Car",
          asset_type: "vehicle",
          currency_code: "USD",
          current_value_minor: 3_471_461,
          valued_on: "2026-07-26",
          active: true,
        },
      ];
    },
    async getManualAssetValuations() {
      return [];
    },
    async listAccounts() {
      return [];
    },
    async listTransactionTags() {
      return [];
    },
    async listTransactionCleanupRules() {
      return [storedRule()];
    },
  };
  const service = createFinanceService({ repository });

  const page = await service.getPageData("settings");

  assert.deepEqual(page.manualAssets[0].value, {
    amount_minor: 3_471_461,
    currency: "USD",
  });
  assert.equal(page.transactionRules.length, 1);
  assert.equal(page.transactionRules[0].id, "cleanup_rule_1");
  assert.equal(
    page.transactionRules[0].matcher.value,
    "AAPL SRV 0042",
  );
});

test("cleanup rule service updates and deletes full rules", async () => {
  const calls = [];
  const jobs = [];
  const repository = {
    async updateTransactionCleanupRule(workspaceId, input) {
      calls.push(["update", workspaceId, input]);
      return storedRule({
        id: input.ruleId,
        match_field: input.matchField,
        match_mode: input.matchMode,
        match_value: input.matchValue,
        normalized_match_value: input.normalizedMatchValue,
        display_name: input.displayName ?? null,
        category_primary: input.categoryPrimary ?? null,
        tags: input.tags,
        enabled: input.enabled,
      });
    },
    async deleteTransactionCleanupRule(workspaceId, input) {
      calls.push(["delete", workspaceId, input]);
      return true;
    },
  };
  const service = createFinanceService({
    repository,
    jobQueue: {
      async enqueue(...args) {
        jobs.push(args);
      },
    },
  });

  const updated = await service.updateTransactionCleanupRule(
    {
      rule_id: "cleanup.rule:2",
      matcher: {
        field: "normalized_name",
        mode: "contains",
        value: "APPLE.COM/BILL 0042",
      },
      changes: { tags: ["Subscription"] },
      enabled: true,
    },
    { id: "user_admin" },
  );
  assert.deepEqual(updated.rule.matcher, {
    field: "normalized_name",
    mode: "contains",
    value: "APPLE.COM/BILL 0042",
    normalized_value: "apple com bill",
  });
  assert.deepEqual(updated.rule.changes, {
    tags: ["Subscription"],
  });

  const deleted = await service.deleteTransactionCleanupRule(
    { rule_id: "cleanup.rule:2" },
    { id: "user_admin" },
  );
  assert.deepEqual(deleted, {
    deleted: true,
    rule_id: "cleanup.rule:2",
  });
  assert.deepEqual(calls[0], [
    "update",
    "shared",
    {
      ruleId: "cleanup.rule:2",
      matchField: "normalized_name",
      matchMode: "contains",
      matchValue: "APPLE.COM/BILL 0042",
      normalizedMatchValue: "apple com bill",
      tags: ["Subscription"],
      enabled: true,
      userId: "user_admin",
    },
  ]);
  assert.deepEqual(calls[1], [
    "delete",
    "shared",
    {
      ruleId: "cleanup.rule:2",
      userId: "user_admin",
    },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(jobs.length, 2);
});

test("cleanup rule service rejects unsafe or ambiguous rules before repository writes", async () => {
  let writes = 0;
  const service = createFinanceService({
    repository: {
      async createTransactionCleanupRule() {
        writes += 1;
      },
      async updateTransactionCleanupRule() {
        writes += 1;
      },
      async deleteTransactionCleanupRule() {
        writes += 1;
      },
    },
  });

  await assert.rejects(
    service.createTransactionCleanupRule({
      matcher: { field: "fuzzy", value: "Apple" },
      changes: { display_name: "Apple" },
    }),
    /matcher\.field is not supported/,
  );
  await assert.rejects(
    service.createTransactionCleanupRule({
      matcher: {
        field: "normalized_merchant",
        mode: "similar",
        value: "Apple",
      },
      changes: { display_name: "Apple" },
    }),
    /matcher\.mode is not supported/,
  );
  await assert.rejects(
    service.createTransactionCleanupRule({
      matcher: {
        field: "normalized_merchant",
        mode: "contains",
        value: "A",
      },
      changes: { display_name: "Apple" },
    }),
    /contains matchers require at least 3 normalized characters/,
  );
  await assert.rejects(
    service.createTransactionCleanupRule({
      matcher: { field: "normalized_merchant", value: "0042" },
      changes: { display_name: "Apple" },
    }),
    /must produce between 1 and 160 normalized characters/,
  );
  await service.createTransactionCleanupRule({
    matcher: { field: "normalized_merchant", value: "Apple" },
    changes: {},
  });
  await assert.rejects(
    service.createTransactionCleanupRule({
      matcher: { field: "normalized_merchant", value: "Apple" },
      changes: { tags: ["Bills", "bïlls"] },
    }),
    /tags must be unique names/,
  );
  await assert.rejects(
    service.createTransactionCleanupRule({
      matcher: { field: "normalized_merchant", value: "Apple" },
      changes: { cash_flow_role: "bill-ish" },
    }),
    /cash_flow_role must be spending, obligation, or transfer/,
  );
  await assert.rejects(
    service.createTransactionCleanupRule({
      matcher: { field: "normalized_merchant", value: "Apple" },
      changes: { display_name: "Apple" },
      enabled: "yes",
    }),
    /enabled must be a boolean/,
  );
  await assert.rejects(
    service.deleteTransactionCleanupRule({ rule_id: "../../oops" }),
    /rule_id is required/,
  );
  assert.equal(writes, 1);
});

test("cleanup rule service reports missing updates and deletes", async () => {
  const service = createFinanceService({
    repository: {
      async updateTransactionCleanupRule() {
        return null;
      },
      async deleteTransactionCleanupRule() {
        return null;
      },
    },
  });
  const rule = {
    rule_id: "cleanup_rule_missing",
    matcher: { field: "normalized_merchant", value: "Apple" },
    changes: { display_name: "Apple" },
  };
  await assert.rejects(
    service.updateTransactionCleanupRule(rule),
    (error) =>
      error.statusCode === 404 &&
      error.message === "Transaction cleanup rule not found",
  );
  await assert.rejects(
    service.deleteTransactionCleanupRule({
      rule_id: "cleanup_rule_missing",
    }),
    (error) =>
      error.statusCode === 404 &&
      error.message === "Transaction cleanup rule not found",
  );
});

test("cleanup rule service converts duplicate matchers to a safe conflict", async () => {
  const duplicate = new Error("raw database detail");
  duplicate.code = "23505";
  const service = createFinanceService({
    repository: {
      async createTransactionCleanupRule() {
        throw duplicate;
      },
      async updateTransactionCleanupRule() {
        return { conflict: true };
      },
    },
  });
  const rule = {
    rule_id: "cleanup_rule_1",
    matcher: {
      field: "normalized_merchant",
      value: "AAPL SRV",
    },
    changes: { display_name: "Apple Services" },
  };

  await assert.rejects(
    service.createTransactionCleanupRule(rule),
    (error) =>
      error.statusCode === 409 &&
      error.message ===
        "A cleanup rule already uses this matcher" &&
      !error.message.includes("database"),
  );
  await assert.rejects(
    service.updateTransactionCleanupRule(rule),
    (error) =>
      error.statusCode === 409 &&
      error.message ===
        "A cleanup rule already uses this matcher",
  );
});
