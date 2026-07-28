import assert from "node:assert/strict";
import test from "node:test";

import { createFinanceService } from "../app/services/financeService.js";

const SETTINGS = {
  revision: 7,
  base_guidance: "Prefer findings with a clear next action.",
  family_guidance: {
    weekly: "Prefer recent changes.",
    investments: "",
    subscriptions: "",
  },
  candidate_limit: 2,
  result_limit: 2,
  feedback_mode: "bad",
  feedback_limit: 4,
  context_length: null,
};

function finding(id, family = "weekly") {
  return {
    id,
    finding_key: `${id}-key`,
    family,
    type: "spend_less",
    severity: "attention",
    title: `Review ${id}`,
    explanation: `Check ${id}`,
    period_start: "2026-07-20",
    period_end: "2026-07-27",
    actions: [{ type: "review" }],
    evidence: [
      {
        entity_type: "transaction",
        entity_id: "must-never-leave",
      },
    ],
    data_as_of: "2026-07-27T18:00:00.000Z",
  };
}

function repositoryWith(overrides = {}) {
  return {
    async getInsightLlmSettings() {
      return structuredClone(SETTINGS);
    },
    async listInsightFindings() {
      return [finding("finding-1"), finding("finding-2")];
    },
    async getInsightFeedbackSummary() {
      return {
        bad: [
          {
            feedback_key: "bad-key",
            count: 2,
            reason_codes: ["wrong_data"],
          },
        ],
        archived: [],
      };
    },
    async getDataFreshness() {
      return {
        data_as_of: "2026-07-27T18:00:00.000Z",
        partial: false,
        warnings: [],
      };
    },
    async getInsightLlmCallStatus() {
      return null;
    },
    async listInsightLlmCallStatuses() {
      return [];
    },
    async getLatestNarrative() {
      return null;
    },
    ...overrides,
  };
}

function narrativeServiceWith(overrides = {}) {
  return {
    async metadata() {
      return {
        configured: true,
        model: "qwen",
        destination_host: "lm.local:1234",
        model_state: "loaded",
        context_length: 8192,
        context_length_source: "model",
      };
    },
    async preview(input) {
      return {
        family: input.family,
        request_body: {
          model: "qwen",
          messages: [],
        },
        counts: {
          candidate_count: input.findings.length,
          bad_feedback_count: input.feedback.bad.length,
          archived_feedback_count: input.feedback.archived.length,
        },
        data_as_of: input.dataAsOf,
        estimated_input_tokens: 200,
        output_token_reserve: 256,
        estimated_total_tokens: 456,
        context_length: 8192,
        utilization: { percent: 5.6, state: "normal" },
        model_state: "loaded",
        model: "qwen",
        destination_host: "lm.local:1234",
        last_actual_usage: input.lastActualUsage,
        prompt_hash: "prompt-hash",
        guidance_revision: input.settings.revision,
      };
    },
    async executeTest(input) {
      return {
        status: "succeeded",
        narrative: null,
        selection: {
          lead_finding_id: input.findings[0].id,
          finding_ids: [input.findings[0].id],
        },
        telemetry: {
          guidance_revision: input.settings.revision,
          model: "qwen",
          status: "succeeded",
          estimated_input_tokens: 200,
          prompt_tokens: 190,
          completion_tokens: 20,
          total_tokens: 210,
          context_length: 8192,
          finish_reason: "stop",
          latency_ms: 80,
        },
        raw_response: '{"finding_ids":["finding-1"]}',
        prompt_hash: "prompt-hash",
        guidance_revision: input.settings.revision,
      };
    },
    ...overrides,
  };
}

test("preview re-reads active findings and ignores a client-supplied revision", async () => {
  let findingQuery;
  let feedbackQuery;
  let previewInput;
  const service = createFinanceService({
    repository: repositoryWith({
      async listInsightFindings(_workspaceId, query) {
        findingQuery = query;
        return [finding("finding-1"), finding("finding-2")];
      },
      async getInsightFeedbackSummary(_workspaceId, query) {
        feedbackQuery = query;
        return {
          bad: [
            {
              feedback_key: "bad-key",
              count: 1,
              reason_codes: ["wrong_data"],
            },
          ],
          archived: [{ feedback_key: "archived-key", count: 1 }],
        };
      },
      async getDataFreshness() {
        return {
          data_as_of: "2026-07-27T18:00:00.000Z",
          partial: true,
          warnings: [{ message: "One connection needs attention." }],
        };
      },
      async getInsightLlmCallStatus() {
        return {
          family: "weekly",
          prompt_tokens: 150,
          completion_tokens: 30,
          total_tokens: 180,
        };
      },
    }),
    narrativeService: narrativeServiceWith({
      async preview(input) {
        previewInput = input;
        return narrativeServiceWith().preview(input);
      },
    }),
  });

  const result = await service.previewInsightLlm({
    family: "weekly",
    settings: {
      ...structuredClone(SETTINGS),
      revision: 999,
      context_length: 4_096,
    },
  });

  assert.deepEqual(findingQuery, {
    family: "weekly",
    scope: "active",
    limit: 2,
  });
  assert.deepEqual(feedbackQuery, {
    family: "weekly",
    limit: 4,
  });
  assert.equal(previewInput.settings.revision, 7);
  assert.equal(previewInput.settings.context_length, 4_096);
  assert.equal(result.guidance_revision, 7);
  assert.equal(result.data_stale, true);
  assert.equal(result.stale_reason, "One connection needs attention.");
  assert.equal(result.last_actual_usage.total_tokens, 180);
});

test("test draft returns usage without writing settings, telemetry, or narratives", async () => {
  const forbiddenWrites = [];
  const repository = repositoryWith({
    async upsertInsightLlmSettings() {
      forbiddenWrites.push("settings");
    },
    async upsertInsightLlmCallStatus() {
      forbiddenWrites.push("telemetry");
    },
    async saveNarrative() {
      forbiddenWrites.push("narrative");
    },
  });
  const service = createFinanceService({
    repository,
    narrativeService: narrativeServiceWith(),
  });

  const result = await service.testInsightLlmDraft({
    family: "weekly",
    settings: structuredClone(SETTINGS),
  });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.actual_usage, {
    prompt_tokens: 190,
    completion_tokens: 20,
    total_tokens: 210,
  });
  assert.match(result.raw_response, /finding-1/);
  assert.deepEqual(forbiddenWrites, []);
});

test("admin state groups throughput by one run and exposes older family narratives", async () => {
  const service = createFinanceService({
    repository: repositoryWith({
      async listInsightLlmCallStatuses() {
        return [
          {
            family: "weekly",
            run_id: "older-run",
            guidance_revision: 7,
            status: "succeeded",
            total_tokens: 900,
            called_at: "2026-07-27T18:00:00.000Z",
          },
          {
            family: "investments",
            run_id: "latest-run",
            guidance_revision: 7,
            status: "succeeded",
            total_tokens: 300,
            called_at: "2026-07-28T18:00:00.000Z",
          },
          {
            family: "subscriptions",
            run_id: "latest-run",
            guidance_revision: 7,
            status: "provider_error",
            total_tokens: null,
            called_at: "2026-07-28T18:00:01.000Z",
          },
        ];
      },
      async getLatestNarrative(_workspaceId, family) {
        if (family === "weekly") {
          return {
            family,
            guidance_revision: 6,
            prompt_hash: "weekly-old",
            model: "qwen",
            generated_at: "2026-07-27T18:00:00.000Z",
          };
        }
        if (family === "investments") {
          return {
            family,
            guidance_revision: 7,
            prompt_hash: "investments-current",
            model: "qwen",
            generated_at: "2026-07-28T18:00:00.000Z",
          };
        }
        return null;
      },
    }),
    narrativeService: narrativeServiceWith(),
  });

  const state = await service.getInsightLlmAdminState();

  assert.deepEqual(state.throughput, {
    run_id: "latest-run",
    total_tokens: 300,
    calls_with_usage: 1,
    call_count: 2,
  });
  assert.equal(state.last_applied_revision, null);
  assert.equal(state.mixed_applied_revisions, true);
  assert.deepEqual(state.older_narrative_families, ["weekly"]);
  assert.deepEqual(state.families_without_narrative, [
    "subscriptions",
  ]);
  assert.deepEqual(state.applied_revision_by_family, {
    weekly: 6,
    investments: 7,
    subscriptions: null,
  });
});

test("saving uses actor identity and returns a stale-revision conflict", async () => {
  let mutation;
  const service = createFinanceService({
    repository: repositoryWith({
      async upsertInsightLlmSettings(_workspaceId, input) {
        mutation = input;
        return {
          conflict: true,
          current: { ...SETTINGS, revision: 8 },
        };
      },
    }),
    narrativeService: narrativeServiceWith(),
  });

  await assert.rejects(
    service.saveInsightLlmSettings(
      {
        expected_revision: 7,
        settings: structuredClone(SETTINGS),
      },
      { id: "admin-1" },
    ),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "INSIGHT_LLM_REVISION_CONFLICT");
      assert.equal(error.currentSettings.revision, 8);
      return true;
    },
  );
  assert.equal(mutation.expectedRevision, 7);
  assert.equal(mutation.updatedBy, "admin-1");
  assert.equal(mutation.baseGuidance, SETTINGS.base_guidance);
  assert.equal(mutation.contextLength, null);
});
