import test from "node:test";
import assert from "node:assert/strict";
import {
  LmStudioNarrativeService,
  NARRATIVE_PROMPT_VERSION,
  narrativeContextHash,
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
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
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
          };
        },
      };
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
  const result = await service.generate("all", findings, {
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

test("invalid LM ranking output fails closed without displaying model prose", async () => {
  const service = new LmStudioNarrativeService({
    endpoint: "http://lm-studio.test",
    model: "local-model",
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
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
        };
      },
    }),
  });

  assert.equal(await service.generate("all", findings), null);
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

  assert.equal(prompt.findings.length, 12);
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
