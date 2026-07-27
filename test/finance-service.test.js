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
