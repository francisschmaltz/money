import test from "node:test";
import assert from "node:assert/strict";

import { createFinanceService } from "../app/services/financeService.js";

const FRESHNESS = {
  data_as_of: "2026-07-26T18:42:00.000Z",
  partial: false,
  warnings: [],
};

function finding(family, index) {
  return {
    id: `${family}-${index}`,
    family,
    finding_type: `${family}_finding`,
    type: `${family}_finding`,
    severity: "info",
    title: `${family} finding ${index}`,
    explanation: `Evidence-backed ${family} finding ${index}.`,
    period_start: "2026-07-19",
    period_end: "2026-07-26",
    metrics: {},
    rule: { key: `${family}_rule` },
    confidence_basis_points: 9_000,
    evidence: [],
    actions: [],
    generated_at: "2026-07-26T18:00:00.000Z",
    data_as_of: FRESHNESS.data_as_of,
    state: "active",
  };
}

function repository(queries = []) {
  const findings = [
    ...Array.from({ length: 5 }, (_, index) =>
      finding("weekly", index + 1),
    ),
    ...Array.from({ length: 5 }, (_, index) =>
      finding("investments", index + 1),
    ),
    ...Array.from({ length: 5 }, (_, index) =>
      finding("subscriptions", index + 1),
    ),
  ];
  return {
    async getDataFreshness() {
      return FRESHNESS;
    },
    async listInsightFindings(_workspaceId, query) {
      queries.push(query);
      return findings;
    },
    async getLatestNarrative() {
      return null;
    },
    async getHoldings() {
      return [];
    },
    async getHoldingSnapshots() {
      return [];
    },
    async getInvestmentTransactions() {
      return [];
    },
    async listAccounts() {
      return [];
    },
    async listRecurringStreams() {
      return [];
    },
  };
}

test("Insights page can render more than the all-sections card cap", async () => {
  const queries = [];
  const service = createFinanceService({
    repository: repository(queries),
    now: () => new Date("2026-07-26T20:00:00.000Z"),
  });

  const page = await service.getPageData("insights", { query: {} });
  assert.equal(page.insights.weekly.length, 5);
  assert.equal(page.insights.investments.length, 5);
  assert.equal(page.insights.subscriptions.length, 5);
  assert.equal(page.insightData.returned_finding_count, 15);
  assert.equal(page.insightData.weekly.has_more, false);
  assert.equal(page.insightView, "active");
  assert.equal(page.insightData.view, "active");
  assert.equal(queries[0].scope, "active");
  assert.equal(
    page.insights.weekly[0].timeframe,
    "Jul 19–25 vs Jul 12–18",
  );

  const card = await service.getFinanceInsights({
    section: "all",
    limitPerSection: 25,
  });
  assert.equal(card.data.weekly.findings.length, 2);
  assert.equal(card.data.investments.findings.length, 2);
  assert.equal(card.data.subscriptions.findings.length, 2);
  assert.equal(card.data.returned_finding_count, 6);
  assert.match(card.warnings[0], /Card delivery is limited to 2 findings/);
  assert.equal("scope" in queries[1], false);
});

test("Insights archive requests archived rows without changing MCP delivery", async () => {
  const queries = [];
  const service = createFinanceService({
    repository: repository(queries),
    now: () => new Date("2026-07-26T20:00:00.000Z"),
  });

  const page = await service.getPageData("insights", {
    query: { view: "archive" },
  });

  assert.equal(page.insightView, "archive");
  assert.equal(page.insightData.view, "archive");
  assert.equal(queries[0].scope, "archive");
});
