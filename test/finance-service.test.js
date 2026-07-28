import test from "node:test";
import assert from "node:assert/strict";

import { createFinanceService } from "../app/services/financeService.js";

test("settings can update insight rules by their public family.rule key", async () => {
  const updates = [];
  const repository = {
    async getInsightRules() {
      return {
        "weekly.spend_less": {
          enabled: false,
          minimum_change_minor: 2_500,
          minimum_change_basis_points: 1_500,
        },
      };
    },
    async updateInsightRule(workspaceId, update) {
      updates.push({ workspaceId, ...update });
      return update;
    },
  };
  const service = createFinanceService({ repository });

  await service.updateInsightRule({
    rule_id: "weekly.spend_less",
    settings: {
      minimum_change_minor: 4_000,
      minimum_change_basis_points: 2_000,
    },
  });

  assert.deepEqual(updates, [
    {
      workspaceId: "shared",
      family: "weekly",
      ruleKey: "spend_less",
      enabled: false,
      settings: {
        minimum_change_minor: 4_000,
        minimum_change_basis_points: 2_000,
      },
    },
  ]);
});

test("settings reject unknown insight rules before touching storage", async () => {
  const service = createFinanceService({
    repository: {
      async updateInsightRule() {
        assert.fail("unknown rules must not reach storage");
      },
    },
  });

  await assert.rejects(
    service.updateInsightRule({
      rule_id: "weekly.make_it_up",
      settings: {},
    }),
    /Unknown insight rule/,
  );
});

test("enabled-only public rule updates preserve stored settings", async () => {
  const updates = [];
  const repository = {
    async getInsightRules() {
      return {
        "subscriptions.expensive": {
          enabled: true,
          monthly_threshold_minor: 5_000,
        },
      };
    },
    async updateInsightRule(_workspaceId, update) {
      updates.push(update);
      return update;
    },
  };
  const service = createFinanceService({ repository });

  await service.updateInsightRule({
    rule_id: "subscriptions.expensive",
    enabled: false,
  });

  assert.deepEqual(updates, [
    {
      family: "subscriptions",
      ruleKey: "expensive",
      enabled: false,
      settings: undefined,
    },
  ]);
});

test("spending categories create nested paths and update by optimistic version", async () => {
  const calls = [];
  const repository = {
    async createSpendingCategory(workspaceId, input) {
      calls.push(["create", workspaceId, input]);
      return {
        id: "category-gas",
        name: "Gas",
        path: "Car / Gas",
        classification: "flexible",
        parent_category_id: "category-car",
        version: 1,
      };
    },
    async updateSpendingCategory(workspaceId, input) {
      calls.push(["update", workspaceId, input]);
      return {
        id: input.categoryId,
        name: input.name,
        path: `Car / ${input.name}`,
        classification: input.classification,
        parent_category_id: input.parentCategoryId,
        version: input.expectedVersion + 1,
      };
    },
  };
  const service = createFinanceService({ repository });
  const actor = { id: "user-admin" };

  const created = await service.createSpendingCategory(
    {
      name: "Gas",
      classification: "flexible",
      parent_category_id: "category-car",
    },
    actor,
  );
  const updated = await service.updateSpendingCategory(
    {
      category_id: "category-gas",
      name: "Fuel",
      classification: "flexible",
      parent_category_id: "category-car",
      expected_version: 1,
    },
    actor,
  );

  assert.equal(created.category.path, "Car / Gas");
  assert.equal(updated.category.path, "Car / Fuel");
  assert.deepEqual(calls, [
    [
      "create",
      "shared",
      {
        name: "Gas",
        classification: "flexible",
        parentCategoryId: "category-car",
        userId: "user-admin",
      },
    ],
    [
      "update",
      "shared",
      {
        categoryId: "category-gas",
        name: "Fuel",
        classification: "flexible",
        parentCategoryId: "category-car",
        expectedVersion: 1,
        userId: "user-admin",
      },
    ],
  ]);
});

test("category merges carry exact versions and a nested new destination", async () => {
  let captured;
  const service = createFinanceService({
    repository: {
      async mergeSpendingCategories(workspaceId, input) {
        captured = { workspaceId, ...input };
        return {
          id: "category-gas",
          path: "Car / Gas",
          classification: "flexible",
          version: 1,
        };
      },
    },
  });

  const result = await service.mergeSpendingCategories(
    {
      source_category_ids: [
        "category-transportation",
        "category-tolls",
      ],
      destination: {
        name: "Gas",
        classification: "flexible",
        parent_category_id: "category-car",
      },
      expected_versions: {
        "category-transportation": 2,
        "category-tolls": 4,
      },
    },
    { id: "user-admin" },
  );

  assert.equal(result.category.path, "Car / Gas");
  assert.deepEqual(captured, {
    workspaceId: "shared",
    sourceCategoryIds: [
      "category-transportation",
      "category-tolls",
    ],
    destinationCategoryId: null,
    destination: {
      name: "Gas",
      classification: "flexible",
      parentCategoryId: "category-car",
    },
    expectedVersions: {
      "category-transportation": 2,
      "category-tolls": 4,
    },
    userId: "user-admin",
  });
});

test("merged categories split out with their exact version", async () => {
  let captured;
  const service = createFinanceService({
    repository: {
      async splitSpendingCategory(workspaceId, input) {
        captured = { workspaceId, ...input };
        return {
          id: "category-tolls",
          name: "Tolls",
          path: "Car / Tolls",
          classification: "flexible",
          version: 5,
        };
      },
    },
  });

  const result = await service.splitSpendingCategory(
    {
      category_id: "category-tolls",
      expected_version: 4,
    },
    { id: "user-admin" },
  );

  assert.equal(result.category.path, "Car / Tolls");
  assert.deepEqual(captured, {
    workspaceId: "shared",
    categoryId: "category-tolls",
    expectedVersion: 4,
    userId: "user-admin",
  });
});
