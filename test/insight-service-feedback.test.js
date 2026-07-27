import test from "node:test";
import assert from "node:assert/strict";
import { InsightService } from "../app/services/insightService.js";
import { narrativeContextHash } from "../app/services/narrativeService.js";

test("nightly insight generation scopes feedback and hashes it with each narrative", async () => {
  const feedbackByFamily = {
    weekly: {
      bad: [
        {
          feedback_key: "weekly:spend_less:dining",
          count: 1,
          reason_codes: ["not_useful"],
        },
      ],
      archived: [],
    },
    investments: {
      bad: [],
      archived: [
        {
          feedback_key: "investments:concentration:vti",
          count: 1,
        },
      ],
    },
    subscriptions: { bad: [], archived: [] },
  };
  const initialFeedback = structuredClone(feedbackByFamily);
  const feedbackRequests = [];
  const narrativeCalls = [];
  const savedNarratives = [];
  const repository = {
    async takeDailySnapshots() {},
    async getDataFreshness() {
      return {
        data_as_of: new Date("2026-07-26T10:00:00Z"),
        partial: false,
      };
    },
    async getInsightRules() {
      return {};
    },
    async getTransactionsForPeriod() {
      return [];
    },
    async listRecurringStreams() {
      return [];
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
    async replaceInsightFindings() {},
    async getInsightFeedbackSummary(workspaceId, options) {
      feedbackRequests.push({ workspaceId, ...options });
      return structuredClone(feedbackByFamily[options.family]);
    },
    async saveNarrative(workspaceId, narrative) {
      savedNarratives.push({ workspaceId, ...narrative });
    },
    async rebuildSearchDocuments() {},
  };
  const narrativeService = {
    async generate(family, findings, feedback) {
      narrativeCalls.push({
        family,
        findings: structuredClone(findings),
        feedback: structuredClone(feedback),
      });
      return {
        headline: `${family} action`,
        bullets: [`Review ${family}`],
        findingIds: [],
      };
    },
  };
  const service = new InsightService({
    repository,
    narrativeService,
    workspaceId: "shared",
    now: () => new Date("2026-07-26T12:00:00Z"),
  });

  await service.generateAll();
  feedbackByFamily.weekly = {
    bad: [
      {
        feedback_key: "weekly:spend_less:dining",
        count: 2,
        reason_codes: ["not_useful"],
      },
    ],
    archived: [],
  };
  await service.generateAll();

  assert.deepEqual(
    feedbackRequests,
    [0, 1].flatMap(() =>
      ["weekly", "investments", "subscriptions"].map((family) => ({
        workspaceId: "shared",
        family,
        limit: 12,
      })),
    ),
  );
  assert.equal(narrativeCalls.length, 6);
  assert.equal(savedNarratives.length, 6);
  assert.deepEqual(
    Object.fromEntries(
      narrativeCalls
        .slice(0, 3)
        .map(({ family, feedback }) => [family, feedback]),
    ),
    initialFeedback,
  );

  for (let index = 0; index < narrativeCalls.length; index += 1) {
    const generated = narrativeCalls[index];
    const saved = savedNarratives[index];
    assert.equal(saved.workspaceId, "shared");
    assert.equal(saved.family, generated.family);
    assert.equal(
      saved.findingsHash,
      narrativeContextHash(generated.findings, generated.feedback),
    );
  }

  const firstRunHashes = Object.fromEntries(
    savedNarratives
      .slice(0, 3)
      .map(({ family, findingsHash }) => [family, findingsHash]),
  );
  const secondRunHashes = Object.fromEntries(
    savedNarratives
      .slice(3)
      .map(({ family, findingsHash }) => [family, findingsHash]),
  );
  assert.notEqual(firstRunHashes.weekly, secondRunHashes.weekly);
  assert.equal(
    firstRunHashes.investments,
    secondRunHashes.investments,
  );
  assert.equal(
    firstRunHashes.subscriptions,
    secondRunHashes.subscriptions,
  );
});
