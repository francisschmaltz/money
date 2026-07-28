import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_INSIGHT_LLM_SETTINGS,
  INSIGHT_LLM_OUTPUT_TOKEN_RESERVE,
  LOCKED_RANKING_CONTRACT,
  LmStudioNarrativeService,
  NARRATIVE_PROMPT_VERSION,
  buildInsightLlmRequest,
  estimateInputTokens,
  narrativeContextHash,
  validateInsightLlmSettings,
  validateNarrativeSelection,
} from "../app/services/narrativeService.js";

const findings = [
  {
    id: "finding_dining",
    family: "weekly",
    type: "spend_less",
    severity: "important",
    finding_key: "weekly:spend_less:dining",
    priority_basis_points: 9_200,
    action_title: "Spend less on Dining",
    action_detail:
      "This month you spent $750 more on dining than last month at this same time.",
    period_label: "Jul 1–14 vs Jun 1–14",
    title: "Dining spending rose",
    explanation: "Dining increased.",
    metrics: { change: { amount_minor: 75_000, currency: "USD" } },
    evidence: [{ label: "Private restaurant name" }],
    actions: [
      {
        type: "review",
        label: "Review transactions",
        web_url: "https://money.example.com/transactions",
      },
    ],
  },
  {
    id: "finding_subscription",
    family: "subscriptions",
    type: "possible_duplicate",
    severity: "attention",
    feedback_key: "subscriptions:possible_duplicate:video",
    action_title: "Review duplicate video subscriptions",
    action_detail: "Confirm whether both active services are still needed.",
    period_label: "Current subscriptions",
    title: "Possible duplicate subscriptions",
    explanation: "Two services may overlap.",
    actions: [{ type: "review", label: "Review", web_url: "/recurring" }],
  },
];

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return structuredClone(payload);
    },
  };
}

test("settings validation locks the bounded inspector surface", () => {
  assert.deepEqual(
    validateInsightLlmSettings({
      ...DEFAULT_INSIGHT_LLM_SETTINGS,
      base_guidance: "Prefer immediate actions.",
      family_guidance: {
        weekly: "Prefer repeated spending.",
        investments: "",
        subscriptions: "",
      },
      candidate_limit: 4,
      result_limit: 2,
      feedback_mode: "bad",
      feedback_limit: 6,
      context_length: null,
    }),
    {
      revision: 0,
      base_guidance: "Prefer immediate actions.",
      family_guidance: {
        weekly: "Prefer repeated spending.",
        investments: "",
        subscriptions: "",
      },
      candidate_limit: 4,
      result_limit: 2,
      feedback_mode: "bad",
      feedback_limit: 6,
      context_length: null,
    },
  );

  const invalid = [
    { base_guidance: "x".repeat(4_001) },
    {
      family_guidance: {
        weekly: "x".repeat(2_001),
      },
    },
    { candidate_limit: 6 },
    { result_limit: 0 },
    { feedback_mode: "everything" },
    { feedback_limit: 13 },
    { context_length: 255 },
    { context_length: 1_048_577 },
    { context_length: 4_096.5 },
    { arbitrary_json: {} },
  ];
  for (const value of invalid) {
    assert.throws(() =>
      validateInsightLlmSettings(value),
    );
  }
});

test("canonical requests keep guidance editable, the contract locked, and finance data allowlisted", () => {
  const settings = {
    ...DEFAULT_INSIGHT_LLM_SETTINGS,
    revision: 7,
    base_guidance: "Prefer the clearest next step.",
    family_guidance: {
      ...DEFAULT_INSIGHT_LLM_SETTINGS.family_guidance,
      weekly: "Prefer the weekly outlier.",
    },
    candidate_limit: 2,
    result_limit: 1,
    feedback_mode: "bad",
    feedback_limit: 1,
  };
  const request = buildInsightLlmRequest({
    family: "weekly",
    findings,
    feedback: {
      bad: [
        {
          feedback_key: "weekly:bad:first",
          count: 2,
          reason_codes: ["wrong_data"],
          note: "private feedback note",
        },
        {
          feedback_key: "weekly:bad:second",
          count: 1,
        },
      ],
      archived: [
        {
          feedback_key: "weekly:archived",
          count: 9,
        },
      ],
    },
    settings,
    model: "local-model",
  });

  assert.equal(request.temperature, 0);
  assert.equal(
    request.max_tokens,
    INSIGHT_LLM_OUTPUT_TOKEN_RESERVE,
  );
  assert.match(
    request.messages[0].content,
    /Prefer the clearest next step/,
  );
  assert.match(
    request.messages[0].content,
    /Prefer the weekly outlier/,
  );
  assert.ok(
    request.messages[0].content.endsWith(
      LOCKED_RANKING_CONTRACT,
    ),
  );
  const data = JSON.parse(request.messages[1].content);
  assert.equal(data.max_items, 1);
  assert.equal(data.findings.length, 2);
  assert.deepEqual(data.feedback, {
    bad: [
      {
        feedback_key: "weekly:bad:first",
        count: 2,
        reason_codes: ["wrong_data"],
      },
    ],
    archived: [],
  });
  const serialized = JSON.stringify(request);
  assert.doesNotMatch(
    serialized,
    /Private restaurant|amount_minor|transactions|evidence|web_url|private feedback note/,
  );
  assert.equal(
    estimateInputTokens(request),
    Math.ceil(Buffer.byteLength(serialized, "utf8") / 3) + 32,
  );
});

test("ranking responses accept only a versioned lead and one to three known ordered IDs", () => {
  assert.deepEqual(
    validateNarrativeSelection(
      {
        prompt_version: NARRATIVE_PROMPT_VERSION,
        lead_finding_id: "finding_dining",
        finding_ids: ["finding_dining", "finding_subscription"],
      },
      findings,
    ),
    {
      leadFindingId: "finding_dining",
      findingIds: ["finding_dining", "finding_subscription"],
    },
  );

  const invalid = [
    {
      prompt_version: NARRATIVE_PROMPT_VERSION + 1,
      lead_finding_id: "finding_dining",
      finding_ids: ["finding_dining"],
    },
    {
      prompt_version: NARRATIVE_PROMPT_VERSION,
      lead_finding_id: "finding_subscription",
      finding_ids: ["finding_dining", "finding_subscription"],
    },
    {
      prompt_version: NARRATIVE_PROMPT_VERSION,
      lead_finding_id: "finding_unknown",
      finding_ids: ["finding_unknown"],
    },
    {
      prompt_version: NARRATIVE_PROMPT_VERSION,
      lead_finding_id: "finding_dining",
      finding_ids: ["finding_dining", "finding_dining"],
    },
    {
      prompt_version: NARRATIVE_PROMPT_VERSION,
      lead_finding_id: "finding_dining",
      finding_ids: ["finding_dining"],
      headline: "Model-written prose is forbidden",
    },
  ];
  for (const value of invalid) {
    assert.equal(validateNarrativeSelection(value, findings), null);
  }
});

test("LM Studio ranks IDs while the server supplies every displayed word", async () => {
  let request;
  const service = new LmStudioNarrativeService({
    endpoint: "http://lm-studio.test/v1",
    model: "local-model",
    fetchImpl: async (url, options) => {
      if (url === "http://lm-studio.test/api/v1/models") {
        return jsonResponse({
          models: [
            {
              key: "local-model",
              loaded_instances: [
                {
                  id: "local-model",
                  config: { context_length: 8_192 },
                },
              ],
              max_context_length: 65_536,
            },
          ],
        });
      }
      request = JSON.parse(options.body);
      return jsonResponse({
        model: "local-model",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                prompt_version: NARRATIVE_PROMPT_VERSION,
                lead_finding_id: "finding_dining",
                finding_ids: [
                  "finding_dining",
                  "finding_subscription",
                ],
              }),
            },
          },
        ],
        usage: {
          prompt_tokens: 421,
          completion_tokens: 32,
          total_tokens: 453,
        },
      });
    },
  });

  const bad = Array.from({ length: 8 }, (_, index) => ({
    feedback_key: `weekly:bad:${index}`,
    count: index + 1,
    reason_codes: ["expected", "contains spaces", "bad_data"],
    amount_minor: 9_999_999,
    evidence: "feedback evidence must not leave the service",
  }));
  const archived = Array.from({ length: 8 }, (_, index) => ({
    feedback_key: `weekly:archived:${index}`,
    count: 1,
    amount_minor: 8_888_888,
  }));
  const result = await service.generate("weekly", findings, {
    bad,
    archived,
    raw_note: "never send this note",
  });

  assert.deepEqual(result, {
    headline: "Spend less on Dining",
    bullets: [
      "Jul 1–14 vs Jun 1–14 — This month you spent $750 more on dining than last month at this same time.",
      "Current subscriptions — Confirm whether both active services are still needed.",
    ],
    findingIds: ["finding_dining", "finding_subscription"],
  });
  assert.equal(request.temperature, 0);
  assert.equal(request.max_tokens, 256);
  assert.deepEqual(request.response_format, {
    type: "json_object",
  });
  const prompt = JSON.parse(request.messages[1].content);
  assert.equal(prompt.prompt_version, NARRATIVE_PROMPT_VERSION);
  assert.equal(prompt.findings.length, 2);
  assert.equal(prompt.feedback.bad.length, 8);
  assert.equal(prompt.feedback.archived.length, 4);
  assert.deepEqual(prompt.feedback.bad[0], {
    feedback_key: "weekly:bad:0",
    count: 1,
    reason_codes: ["expected", "bad_data"],
  });
  assert.doesNotMatch(
    request.messages[1].content,
    /amount_minor|feedback evidence|never send this note|Private restaurant/,
  );
  assert.deepEqual(prompt.findings[0].cta_keys, ["review"]);
});

test("preview and test use the identical request and expose truthful model/token state", async () => {
  let postedBody = null;
  const service = new LmStudioNarrativeService({
    endpoint: "http://secret-user:secret-pass@lm-studio.test:1234/v1",
    model: "local-model",
    apiKey: "top-secret-api-key",
    fetchImpl: async (url, options) => {
      if (url.includes("/api/v1/models")) {
        return jsonResponse({
          models: [
            {
              key: "local-model",
              loaded_instances: [
                {
                  id: "local-model",
                  config: { context_length: 4_096 },
                },
              ],
              max_context_length: 99_999,
            },
          ],
        });
      }
      postedBody = options.body;
      assert.equal(
        options.headers.authorization,
        "Bearer top-secret-api-key",
      );
      return jsonResponse({
        model: "local-model",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                prompt_version: NARRATIVE_PROMPT_VERSION,
                lead_finding_id: "finding_dining",
                finding_ids: ["finding_dining"],
              }),
            },
          },
        ],
        usage: {
          prompt_tokens: 310,
          completion_tokens: 18,
          total_tokens: 328,
        },
      });
    },
  });
  const input = {
    family: "weekly",
    findings,
    feedback: {},
    settings: {
      ...DEFAULT_INSIGHT_LLM_SETTINGS,
      revision: 4,
      context_length: 3_072,
    },
  };

  const preview = await service.preview({
    ...input,
    dataAsOf: "2026-07-28T12:00:00Z",
    dataStale: true,
    staleReason: "One connection needs attention.",
  });
  const tested = await service.executeTest(input);

  assert.equal(
    postedBody,
    JSON.stringify(preview.request_body),
  );
  assert.equal(preview.context_length, 3_072);
  assert.equal(preview.context_length_source, "settings");
  assert.equal(preview.model_state, "loaded");
  assert.equal(preview.destination_host, "lm-studio.test:1234");
  assert.equal(preview.data_stale, true);
  assert.equal(
    preview.stale_reason,
    "One connection needs attention.",
  );
  assert.doesNotMatch(
    JSON.stringify(preview),
    /top-secret-api-key|secret-user|secret-pass/,
  );
  assert.equal(tested.status, "succeeded");
  assert.equal(tested.telemetry.context_length, 3_072);
  assert.equal(
    Object.hasOwn(preview.request_body, "context_length"),
    false,
  );
  assert.deepEqual(tested.selection, {
    lead_finding_id: "finding_dining",
    finding_ids: ["finding_dining"],
  });
  assert.deepEqual(
    {
      prompt_tokens: tested.telemetry.prompt_tokens,
      completion_tokens: tested.telemetry.completion_tokens,
      total_tokens: tested.telemetry.total_tokens,
      finish_reason: tested.telemetry.finish_reason,
    },
    {
      prompt_tokens: 310,
      completion_tokens: 18,
      total_tokens: 328,
      finish_reason: "stop",
    },
  );
  assert.match(tested.raw_response, /finding_dining/);
});

test("context estimates fall back to loaded model config and otherwise stay unknown", async () => {
  const loaded = new LmStudioNarrativeService({
    endpoint: "http://lm-studio.test/v1",
    model: "local-model",
    fetchImpl: async () =>
      jsonResponse({
        models: [
          {
            key: "local-model",
            loaded_instances: [
              {
                id: "local-model",
                config: { context_length: 6_144 },
              },
            ],
            max_context_length: 99_999,
          },
        ],
      }),
  });
  const loadedPreview = await loaded.preview({
    family: "weekly",
    findings,
  });
  assert.equal(loadedPreview.context_length, 6_144);
  assert.equal(loadedPreview.context_length_source, "model");

  const unavailable = new LmStudioNarrativeService({
    endpoint: "http://lm-studio.test/v1",
    model: "local-model",
    fetchImpl: async () =>
      jsonResponse(
        { error: { message: "offline" } },
        { ok: false, status: 503 },
      ),
  });
  const unknownPreview = await unavailable.preview({
    family: "weekly",
    findings,
  });
  assert.equal(unknownPreview.context_length, null);
  assert.equal(unknownPreview.context_length_source, "unknown");
  assert.deepEqual(unknownPreview.utilization, {
    percent: null,
    state: "unknown",
  });
});

test("execution normalizes timeout, context, and output-length failures without a narrative", async () => {
  async function executeWith(chatResponse) {
    const service = new LmStudioNarrativeService({
      endpoint: "http://lm-studio.test/v1",
      model: "local-model",
      fetchImpl: async (url) => {
        if (url.endsWith("/api/v1/models")) {
          return jsonResponse({
            models: [
              {
                key: "local-model",
                loaded_instances: [
                  {
                    id: "local-model",
                    config: { context_length: 2_048 },
                  },
                ],
              },
            ],
          });
        }
        if (chatResponse instanceof Error) throw chatResponse;
        return chatResponse;
      },
    });
    return service.executeProduction({
      family: "weekly",
      findings,
    });
  }

  const timeout = new Error("timed out");
  timeout.name = "TimeoutError";
  const timedOut = await executeWith(timeout);
  assert.equal(timedOut.status, "timeout");
  assert.equal(timedOut.narrative, null);
  assert.equal(Object.hasOwn(timedOut, "raw_response"), false);

  const contextFailure = await executeWith(
    jsonResponse(
      {
        error: {
          message:
            "Prompt exceeds the maximum context length token limit.",
        },
      },
      { ok: false, status: 400 },
    ),
  );
  assert.equal(contextFailure.status, "context_error");
  assert.equal(contextFailure.narrative, null);

  const truncated = await executeWith(
    jsonResponse({
      choices: [
        {
          finish_reason: "length",
          message: {
            content: JSON.stringify({
              prompt_version: NARRATIVE_PROMPT_VERSION,
              lead_finding_id: "finding_dining",
              finding_ids: ["finding_dining"],
            }),
          },
        },
      ],
      usage: {
        prompt_tokens: 1_900,
        completion_tokens: 148,
        total_tokens: 2_048,
      },
    }),
  );
  assert.equal(truncated.status, "length");
  assert.equal(truncated.narrative, null);
  assert.equal(truncated.telemetry.total_tokens, 2_048);
});

test("invalid LM ranking output fails closed without displaying model prose", async () => {
  const service = new LmStudioNarrativeService({
    endpoint: "http://lm-studio.test",
    model: "local-model",
    fetchImpl: async (url) =>
      url.endsWith("/api/v1/models")
        ? jsonResponse({
            models: [
              {
                key: "local-model",
                loaded_instances: [
                  {
                    id: "local-model",
                    config: { context_length: 4_096 },
                  },
                ],
              },
            ],
          })
        : jsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  prompt_version: NARRATIVE_PROMPT_VERSION,
                  lead_finding_id: "finding_dining",
                  finding_ids: ["finding_dining"],
                  bullets: ["Sell everything today."],
                }),
              },
            },
          ],
        }),
  });

  assert.equal(await service.generate("weekly", findings), null);
});

test("LM ranking context is bounded and keeps actionable important findings ahead of background stats", async () => {
  let prompt;
  const background = Array.from({ length: 30 }, (_, index) => ({
    id: `finding_performance_${index}`,
    family: "investments",
    type: "performance",
    severity: "info",
    title: `Portfolio performance ${index}`,
    explanation: "Background portfolio movement.",
    actions: [],
  }));
  const concentration = {
    id: "finding_concentration",
    family: "investments",
    type: "concentration",
    severity: "important",
    title: "VTI is a concentrated position",
    explanation: "VTI is above the configured concentration marker.",
    actions: [{ type: "review", web_url: "/portfolio?holding=VTI" }],
  };
  const service = new LmStudioNarrativeService({
    endpoint: "http://lm-studio.test",
    model: "local-model",
    fetchImpl: async (_url, options) => {
      prompt = JSON.parse(
        JSON.parse(options.body).messages[1].content,
      );
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    prompt_version: NARRATIVE_PROMPT_VERSION,
                    lead_finding_id: concentration.id,
                    finding_ids: [concentration.id],
                  }),
                },
              },
            ],
          };
        },
      };
    },
  });

  const result = await service.generate("investments", [
    ...background,
    concentration,
    { ...concentration },
  ]);

  assert.equal(prompt.findings.length, 5);
  assert.equal(prompt.findings[0].id, concentration.id);
  assert.equal(
    prompt.findings.filter((finding) => finding.id === concentration.id)
      .length,
    1,
  );
  assert.ok(
    prompt.findings.every(
      (finding) =>
        !Object.hasOwn(finding, "evidence") &&
        !Object.hasOwn(finding, "transactions") &&
        !Object.hasOwn(finding, "transaction_ids"),
    ),
  );
  assert.equal(result.headline, "Review VTI concentration");
});

test("narrative context hashes the prompt version and bounded safe context", () => {
  const feedback = {
    bad: [
      {
        feedback_key: "weekly:spend_less:dining",
        count: 2,
        reason_codes: ["expected"],
        amount_minor: 123_456,
        evidence: ["private"],
      },
    ],
  };
  const base = narrativeContextHash(findings, feedback);
  assert.equal(
    base,
    narrativeContextHash(findings, {
      bad: [
        {
          feedback_key: "weekly:spend_less:dining",
          count: 2,
          reason_codes: ["expected"],
        },
      ],
    }),
  );
  assert.notEqual(
    base,
    narrativeContextHash(findings, {
      bad: [
        {
          feedback_key: "weekly:spend_less:dining",
          count: 3,
          reason_codes: ["expected"],
        },
      ],
    }),
  );
  assert.notEqual(
    base,
    narrativeContextHash(
      findings.map((finding, index) =>
        index === 0
          ? { ...finding, action_title: "Review Dining spending" }
          : finding,
      ),
      feedback,
    ),
  );
  assert.match(base, /^[a-f0-9]{64}$/);
});
