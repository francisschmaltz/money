import test from "node:test";
import assert from "node:assert/strict";
import {
  InsightService,
  selectHighQualityFindings,
} from "../app/services/insightService.js";
import {
  DEFAULT_INSIGHT_LLM_SETTINGS,
  narrativeContextHash,
} from "../app/services/narrativeService.js";

test("nightly insight generation re-reads active findings and uses one settings revision and run ID", async () => {
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
  const activeFindingRequests = [];
  const telemetryRows = [];
  let settingsReads = 0;
  const settings = {
    ...DEFAULT_INSIGHT_LLM_SETTINGS,
    revision: 7,
  };
  const activeFindings = Object.fromEntries(
    ["weekly", "investments", "subscriptions"].map((family) => [
      family,
      [
        {
          id: `active-${family}`,
          family,
          type: "needs_review",
          severity: "important",
          title: `Review ${family}`,
          explanation: "Stored active corrected finding.",
          actions: [],
        },
      ],
    ]),
  );
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
    async listInsightFindings(workspaceId, options) {
      activeFindingRequests.push({ workspaceId, ...options });
      return structuredClone(activeFindings[options.family]);
    },
    async getInsightLlmSettings() {
      settingsReads += 1;
      return structuredClone(settings);
    },
    async getInsightFeedbackSummary(workspaceId, options) {
      feedbackRequests.push({ workspaceId, ...options });
      return structuredClone(feedbackByFamily[options.family]);
    },
    async saveNarrative(workspaceId, narrative) {
      savedNarratives.push({ workspaceId, ...narrative });
    },
    async upsertInsightLlmCallStatus(workspaceId, telemetry) {
      telemetryRows.push({ workspaceId, ...telemetry });
    },
    async rebuildSearchDocuments() {},
  };
  const narrativeService = {
    async executeProduction({
      family,
      findings,
      feedback,
      settings: callSettings,
    }) {
      narrativeCalls.push({
        family,
        findings: structuredClone(findings),
        feedback: structuredClone(feedback),
        settings: structuredClone(callSettings),
      });
      return {
        status: "succeeded",
        model: "local-model",
        prompt_hash: `prompt-${family}`,
        narrative: {
          headline: `${family} action`,
          bullets: [`Review ${family}`],
          findingIds: findings.map((finding) => finding.id),
        },
        telemetry: {
          model: "local-model",
          estimated_input_tokens: 123,
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          context_length: 4_096,
          finish_reason: "stop",
          latency_ms: 5,
          called_at: "2026-07-26T12:00:00.000Z",
        },
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
  assert.equal(settingsReads, 2);
  assert.deepEqual(
    activeFindingRequests,
    [0, 1].flatMap(() =>
      ["weekly", "investments", "subscriptions"].map((family) => ({
        workspaceId: "shared",
        family,
        scope: "active",
        limit: 200,
      })),
    ),
  );
  assert.deepEqual(
    Object.fromEntries(
      narrativeCalls
        .slice(0, 3)
        .map(({ family, feedback }) => [family, feedback]),
    ),
    initialFeedback,
  );
  assert.ok(
    narrativeCalls.every(
      ({ family, findings, settings: callSettings }) =>
        findings.length === 1 &&
        findings[0].id === `active-${family}` &&
        callSettings.revision === 7,
    ),
  );

  for (let index = 0; index < narrativeCalls.length; index += 1) {
    const generated = narrativeCalls[index];
    const saved = savedNarratives[index];
    assert.equal(saved.workspaceId, "shared");
    assert.equal(saved.family, generated.family);
    assert.equal(saved.guidanceRevision, 7);
    assert.equal(saved.promptHash, `prompt-${generated.family}`);
    assert.equal(saved.model, "local-model");
    assert.deepEqual(saved.presentation, {
      headline: `${generated.family} action`,
      bullets: [`Review ${generated.family}`],
      findingIds: [`active-${generated.family}`],
    });
    assert.equal(
      saved.findingsHash,
      narrativeContextHash(
        generated.findings,
        generated.feedback,
        {
          family: generated.family,
          settings,
          model: "local-model",
        },
      ),
    );
  }
  assert.equal(telemetryRows.length, 6);
  assert.deepEqual(
    new Set(telemetryRows.slice(0, 3).map((row) => row.run_id))
      .size,
    1,
  );
  assert.deepEqual(
    new Set(telemetryRows.slice(3).map((row) => row.run_id)).size,
    1,
  );
  assert.notEqual(
    telemetryRows[0].run_id,
    telemetryRows[3].run_id,
  );
  assert.ok(
    telemetryRows.every(
      (row) =>
        row.guidance_revision === 7 &&
        row.status === "succeeded",
    ),
  );

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

test("partial freshness preserves stored findings and skips transaction and model work", async () => {
  const calls = [];
  const repository = {
    async takeDailySnapshots() {},
    async getDataFreshness() {
      return { partial: true, data_as_of: null, warnings: [] };
    },
    async getInsightRules() {
      return {};
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
    async getTransactionsForPeriod() {
      calls.push("transactions");
      return [];
    },
    async replaceInsightFindings() {
      calls.push("replace");
    },
  };
  const service = new InsightService({
    repository,
    narrativeService: {
      async generate() {
        calls.push("model");
      },
    },
  });

  const result = await service.generateAll();

  assert.equal(result.skipped, true);
  assert.equal(result.reason, "partial_freshness");
  assert.deepEqual(calls, []);
});

test("healthy generation uses a 90-day weekly window and ID-only subscription evidence", async () => {
  const transactionQueries = [];
  const idQueries = [];
  const repository = {
    async takeDailySnapshots() {},
    async getDataFreshness() {
      return {
        partial: false,
        data_as_of: new Date("2026-07-26T10:00:00Z"),
      };
    },
    async getInsightRules() {
      return {};
    },
    async listRecurringStreams() {
      return [
        {
          id: "stream-1",
          stream_type: "subscription",
          transaction_ids: [
            "txn-1",
            "txn-2",
            "txn-3",
            "txn-4",
            "txn-5",
            "txn-6",
            "txn-7",
          ],
          currency_code: "USD",
          status: "active",
          service_family: "netflix",
          display_name: "Netflix",
          cadence: "monthly",
          expected_amount_minor: 1_999,
          monthly_equivalent_minor: 1_999,
          confidence_basis_points: 9_000,
          duplicate_state: "unknown",
          first_seen_on: "2026-01-01",
          last_seen_on: "2026-07-01",
        },
      ];
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
    async getTransactionsForPeriod(_workspaceId, options) {
      transactionQueries.push(options);
      return [];
    },
    async getTransactionsByIds(_workspaceId, ids) {
      idQueries.push(ids);
      return [];
    },
    async replaceInsightFindings() {},
    async rebuildSearchDocuments() {},
  };
  const service = new InsightService({
    repository,
    now: () => new Date("2026-07-26T12:00:00Z"),
  });

  await service.generateAll();

  assert.deepEqual(transactionQueries, [
    {
      startOn: "2026-04-28",
      endOn: "2026-07-27",
      activeAccountsOnly: true,
    },
  ]);
  assert.deepEqual(idQueries, [
    ["txn-3", "txn-4", "txn-5", "txn-6", "txn-7"],
  ]);
});

test("quality selection removes overlapping lectures and caps each family", () => {
  const findings = Array.from({ length: 8 }, (_, index) => ({
    id: `finding-${index}`,
    type: index === 1 ? "needs_review" : "spend_less",
    severity: index === 1 ? "important" : "attention",
    confidence_basis_points: 9_000 - index,
    evidence: [
      {
        entity_type: "transaction",
        entity_id: index < 2 ? "shared" : `txn-${index}`,
      },
    ],
  }));

  const selected = selectHighQualityFindings(findings);

  assert.equal(selected.length, 5);
  assert.equal(selected[0].id, "finding-1");
  assert.equal(
    selected.filter(
      (finding) => finding.evidence[0].entity_id === "shared",
    ).length,
    1,
  );
});
