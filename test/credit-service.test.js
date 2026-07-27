import test from "node:test";
import assert from "node:assert/strict";

import { FINANCE_TOOL_NAMES } from "../app/mcp/constants.js";
import { createDemoFinanceService } from "../app/services/demoFinanceService.js";
import { createFinanceService } from "../app/services/financeService.js";

const FRESHNESS = {
  data_as_of: "2026-07-26T18:42:00.000Z",
  partial: false,
  warnings: [],
};

function creditAccount(overrides = {}) {
  return {
    id: "card",
    item_id: "item",
    institution_id: "institution",
    institution_name: "Bank",
    name: "Everyday card",
    official_name: null,
    mask: "1234",
    type: "credit",
    subtype: "credit_card",
    currency_code: "USD",
    current_balance_minor: 250_000,
    available_balance_minor: 750_000,
    credit_limit_minor: 1_000_000,
    is_liability: true,
    balance_group_override: null,
    balance_group: "credit_card",
    active: true,
    last_synced_at: FRESHNESS.data_as_of,
    ...overrides,
  };
}

function snapshot(
  date,
  balance,
  limit = 1_000_000,
  accountId = "card",
) {
  return {
    account_id: accountId,
    account_name: "Everyday card",
    snapshot_on: date,
    current_balance_minor: balance,
    available_balance_minor:
      limit == null ? null : limit - Math.max(balance ?? 0, 0),
    credit_limit_minor: limit,
    currency_code: "USD",
    type: "credit",
    subtype: "credit_card",
    is_liability: true,
    balance_group_override: null,
    balance_group: "credit_card",
  };
}

function repository({
  accounts = [creditAccount()],
  snapshots = [snapshot("2026-07-01", 200_000)],
  onSnapshotRead = () => {},
} = {}) {
  return {
    async listAccounts() {
      return accounts;
    },
    async getAccountSnapshots(_workspaceId, options) {
      onSnapshotRead(options);
      return snapshots.filter(
        (entry) =>
          entry.snapshot_on >= options.startOn &&
          entry.snapshot_on < options.endOn,
      );
    },
    async getDataFreshness() {
      return FRESHNESS;
    },
  };
}

test("credit summary defaults to one month and appends the current account point", async () => {
  const reads = [];
  const service = createFinanceService({
    repository: repository({
      onSnapshotRead: (options) => reads.push(options),
    }),
    now: () => new Date("2026-07-26T20:00:00.000Z"),
  });

  const result = await service.getCreditSummary();

  assert.deepEqual(reads, [
    {
      startOn: "2026-06-26",
      endOn: "2026-07-27",
    },
  ]);
  assert.deepEqual(result.data.period, {
    name: "1m",
    label: "Last month",
    start_on: "2026-06-26",
    end_on: "2026-07-27",
  });
  assert.equal(result.data.summary.total_balance_owed.amount_minor, 250_000);
  assert.equal(result.data.summary.total_credit_limit.amount_minor, 1_000_000);
  assert.equal(result.data.summary.utilization_basis_points, 2_500);
  assert.equal(result.data.series.at(-1).timestamp, "2026-07-26");
  assert.equal(
    result.data.cards[0].series.at(-1).balance_owed.amount_minor,
    250_000,
  );
  assert.equal(result.partial, false);
});

test("credit history and every per-card series are bounded to 80 points", async () => {
  const snapshots = Array.from({ length: 120 }, (_, index) => {
    const date = new Date("2026-03-28T00:00:00.000Z");
    date.setUTCDate(date.getUTCDate() + index);
    return snapshot(
      date.toISOString().slice(0, 10),
      100_000 + index * 1_000,
    );
  });
  const service = createFinanceService({
    repository: repository({ snapshots }),
    now: () => new Date("2026-07-26T20:00:00.000Z"),
  });

  const result = await service.getCreditSummary({ period: "1y" });

  assert.equal(result.data.series.length, 80);
  assert.equal(result.data.cards[0].series.length, 80);
  assert.equal(result.data.series.at(-1).timestamp, "2026-07-26");
  assert.match(result.warnings.at(-1), /bounded to 80 points/);
});

test("credit page data and accounts expose the same current credit facts", async () => {
  const service = createFinanceService({
    repository: repository(),
    now: () => new Date("2026-07-26T20:00:00.000Z"),
  });

  const page = await service.getPageData("credit", {
    query: { period: "1w" },
  });
  assert.equal(page.creditData.period.name, "1w");
  assert.equal(
    page.creditData.summary.utilization_basis_points,
    2_500,
  );

  const listed = await service.listAccounts();
  const account = listed.data.groups[0].accounts[0];
  assert.equal(account.credit_limit.amount_minor, 1_000_000);
  assert.equal(account.balance_owed.amount_minor, 250_000);
  assert.equal(account.available_credit.amount_minor, 750_000);
  assert.equal(account.utilization_basis_points, 2_500);
  assert.equal(account.over_limit, false);
  assert.equal(
    listed.data.credit_summary.total_credit_limit.amount_minor,
    1_000_000,
  );
});

test("demo credit data follows the production shape and exposes manual scores through MCP", async () => {
  const service = createDemoFinanceService();
  const credit = await service.getCreditSummary();
  const accounts = await service.listAccounts({
    balance_group: "credit_card",
  });

  assert.equal(credit.data.period.name, "1m");
  assert.equal(credit.data.summary.card_count, 1);
  assert.equal(
    credit.data.summary.total_credit_limit.amount_minor,
    1_000_000,
  );
  assert.equal(
    accounts.data.groups[0].accounts[0].credit_limit.amount_minor,
    1_000_000,
  );
  assert.equal(
    accounts.data.credit_summary.utilization_basis_points,
    2_815,
  );
  assert.equal(FINANCE_TOOL_NAMES.length, 10);
  assert.equal(
    FINANCE_TOOL_NAMES.includes("get_credit_score_summary"),
    true,
  );
});
