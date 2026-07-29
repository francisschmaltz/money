import assert from "node:assert/strict";
import test from "node:test";

import { PlanningService } from "../app/services/planningService.js";

test("budget status nets active goal attribution in the effective Plan month", async () => {
  const calls = {
    goalSpendTransactionIds: null,
  };
  const repository = {
    async getWorkspaceTimezone() {
      return "America/Los_Angeles";
    },
    async listResolvedBudgetLines() {
      return [
        {
          category_id: "category_car",
          category: "Car",
          amount_minor: 8_000_000,
          currency_code: "USD",
          tracking_mode: "tracked",
          version: 1,
          exact_month: true,
        },
      ];
    },
    async listBudgetCategoryVersions() {
      return [
        {
          category_id: "category_car",
          category: "Car",
          version: 1,
        },
      ];
    },
    async getBudgetSettings() {
      return { version: 0, income_category_ids: [] };
    },
    async listTransactionSplits() {
      return [];
    },
    async listActiveGoalSpendTotals(_workspaceId, transactionIds) {
      calls.goalSpendTransactionIds = [...transactionIds];
      return [
        {
          transaction_id: "car-wire",
          amount_minor: 7_000_000,
        },
      ];
    },
  };
  const financeRepository = {
    async listSpendingCategories() {
      return [
        {
          id: "category_car",
          name: "Car",
          path: "Car",
          parent_category_id: null,
        },
        {
          id: "category_other",
          name: "Other",
          path: "Other",
          parent_category_id: null,
        },
      ];
    },
    async getTransactionsForPeriod() {
      return [
        {
          id: "car-wire",
          posted_on: "2026-07-02",
          budget_month_on: "2026-06-01",
          pending: false,
          excluded_from_spending: false,
          currency_code: "USD",
          amount_minor: -7_000_000,
          category_id: "category_car",
          category_primary: "Car",
        },
        {
          id: "ordinary-spending",
          posted_on: "2026-06-18",
          budget_month_on: null,
          pending: false,
          excluded_from_spending: false,
          currency_code: "USD",
          amount_minor: -2_444_779,
          category_id: "category_other",
          category_primary: "Other",
        },
      ];
    },
    async getDataFreshness() {
      return {
        data_as_of: "2026-07-28T12:00:00.000Z",
        partial: false,
      };
    },
  };
  const service = new PlanningService({
    repository,
    financeRepository,
    now: () => new Date("2026-07-28T12:00:00.000Z"),
  });

  const result = await service.getBudgetStatus({
    month_on: "2026-06-01",
  });

  assert.deepEqual(calls.goalSpendTransactionIds, [
    "car-wire",
    "ordinary-spending",
  ]);
  assert.equal(result.data.actual_total.amount_minor, 2_444_779);
  assert.equal(result.data.goal_attributed_total.amount_minor, 7_000_000);
  assert.equal(result.data.actual_leftover.amount_minor, -2_444_779);
  assert.equal(result.data.lines[0].actual.amount_minor, 0);
  assert.equal(
    result.data.lines[0].goal_attributed.amount_minor,
    7_000_000,
  );
  assert.equal(
    result.data.category_actuals.find(
      (entry) => entry.category_id === "category_car",
    ).goal_attributed.amount_minor,
    7_000_000,
  );
});
