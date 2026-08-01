import assert from "node:assert/strict";
import test from "node:test";

import {
  createDemoFinanceService,
} from "../app/services/demoFinanceService.js";

test("demo LLM ranking state is representative and never calls a network", async () => {
  const service = createDemoFinanceService();
  const state = await service.getInsightLlmAdminState();
  const draft = {
    ...structuredClone(state.settings),
    context_length: 4_096,
  };
  const preview = await service.previewInsightLlm({
    family: "weekly",
    settings: draft,
  });

  assert.equal(state.metadata.configured, true);
  assert.equal(state.metadata.model_state, "loaded");
  assert.equal(state.throughput.run_id, "demo-insight-run-1");
  assert.equal(preview.request_body.temperature, 0);
  assert.equal(preview.request_body.max_tokens, 256);
  assert.equal(preview.context_length, 4_096);
  assert.equal(preview.context_length_source, "settings");
  assert.equal("context_length" in preview.request_body, false);
  assert.equal(preview.data_stale, false);
  assert.doesNotMatch(
    JSON.stringify(preview.request_body),
    /transaction_ids?|evidence|must-never-leave/i,
  );
});

test("paused demo data still previews and is labeled stale", async () => {
  const service = createDemoFinanceService({
    scenario: "ux-stress",
    insightsPaused: true,
  });
  const state = await service.getInsightLlmAdminState();
  const preview = await service.previewInsightLlm({
    family: "weekly",
    settings: structuredClone(state.settings),
  });

  assert.equal((await service.getInsightStatus()).can_run, false);
  assert.equal(preview.data_stale, true);
  assert.match(preview.stale_reason, /stale or incomplete/i);
  assert.ok(preview.request_body);
});

test("demo manual insight control persists across status and page reads", async () => {
  const service = createDemoFinanceService();

  await service.setInsightsEnabled({ enabled: false });
  assert.equal((await service.getInsightStatus()).state, "paused");
  assert.equal(
    (await service.getFinanceInsights()).insights_enabled,
    false,
  );

  await service.setInsightsEnabled({ enabled: true });
  assert.equal((await service.getInsightStatus()).state, "ready");
  assert.equal(
    (await service.getFinanceInsights()).insights_enabled,
    true,
  );
});

test("demo test draft is side-effect free while save increments revision", async () => {
  const service = createDemoFinanceService();
  const before = await service.getInsightLlmAdminState();
  const tested = await service.testInsightLlmDraft({
    family: "subscriptions",
    settings: structuredClone(before.settings),
  });
  const afterTest = await service.getInsightLlmAdminState();

  assert.equal(tested.status, "succeeded");
  assert.equal(afterTest.settings.revision, before.settings.revision);

  const saved = await service.saveInsightLlmSettings(
    {
      expected_revision: before.settings.revision,
      settings: {
        ...structuredClone(before.settings),
        base_guidance: "Prefer reversible next actions.",
      },
    },
    { id: "demo-admin" },
  );

  assert.equal(saved.settings.revision, before.settings.revision + 1);
  assert.equal(
    saved.settings.base_guidance,
    "Prefer reversible next actions.",
  );
});
