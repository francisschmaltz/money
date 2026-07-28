import { createHash } from "node:crypto";
import { presentInsightForWeb } from "./insightPresentation.js";

export const NARRATIVE_PROMPT_VERSION = 1;

const MAX_RANKED_FINDINGS = 3;
const MAX_CANDIDATE_FINDINGS = 12;
const MAX_FEEDBACK_ENTRIES = 12;
const RESPONSE_KEYS = [
  "finding_ids",
  "lead_finding_id",
  "prompt_version",
];
const RANKING_SYSTEM_PROMPT =
  "Select the most useful next actions from the supplied deterministic finance findings. Use feedback only to rank or omit. Never create or modify facts, amounts, dates, entities, causes, or investment recommendations. Return JSON only with exactly prompt_version, lead_finding_id, and finding_ids. finding_ids must contain 1 to 3 unique supplied IDs in priority order, with the lead ID first.";

export class LmStudioNarrativeService {
  #endpoint;
  #model;
  #fetch;
  #apiKey;

  constructor({
    endpoint =
      process.env.LM_STUDIO_BASE_URL ?? process.env.LM_STUDIO_URL,
    model = process.env.LM_STUDIO_MODEL,
    apiKey = process.env.LM_STUDIO_API_KEY,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.#endpoint = endpoint?.replace(/\/$/, "") ?? null;
    this.#model = model ?? null;
    this.#apiKey = apiKey ?? null;
    this.#fetch = fetchImpl;
  }

  async generate(family, findings, feedback = {}) {
    if (!this.#endpoint || !this.#model || !findings.length) return null;
    const facts = rankingFacts(findings);
    const boundedFeedback = boundedFeedbackAggregates(feedback);
    try {
      const response = await this.#fetch(
        `${this.#endpoint}${this.#endpoint.endsWith("/v1") ? "" : "/v1"}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.#apiKey
              ? { authorization: `Bearer ${this.#apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: this.#model,
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content: RANKING_SYSTEM_PROMPT,
              },
              {
                role: "user",
                content: JSON.stringify({
                  prompt_version: NARRATIVE_PROMPT_VERSION,
                  family,
                  max_items: MAX_RANKED_FINDINGS,
                  findings: facts,
                  feedback: boundedFeedback,
                }),
              },
            ],
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) return null;
      const payload = await response.json();
      const raw = payload.choices?.[0]?.message?.content;
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      const selection = validateNarrativeSelection(parsed, facts);
      return selection
        ? presentNarrativeSelection(selection, findings)
        : null;
    } catch {
      return null;
    }
  }
}

export function validateNarrativeSelection(
  value,
  findings,
  { promptVersion = NARRATIVE_PROMPT_VERSION } = {},
) {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== RESPONSE_KEYS.length ||
    keys.some((key, index) => key !== RESPONSE_KEYS[index])
  ) {
    return null;
  }
  if (
    value.prompt_version !== promptVersion ||
    typeof value.lead_finding_id !== "string" ||
    !Array.isArray(value.finding_ids) ||
    value.finding_ids.length < 1 ||
    value.finding_ids.length > MAX_RANKED_FINDINGS ||
    value.finding_ids[0] !== value.lead_finding_id
  ) {
    return null;
  }
  const knownIds = new Set(findings.map((finding) => finding.id));
  const selectedIds = new Set();
  for (const id of value.finding_ids) {
    if (
      typeof id !== "string" ||
      !knownIds.has(id) ||
      selectedIds.has(id)
    ) {
      return null;
    }
    selectedIds.add(id);
  }
  return {
    leadFindingId: value.lead_finding_id,
    findingIds: [...value.finding_ids],
  };
}

export function narrativeContextHash(findings, feedback = {}) {
  const context = {
    prompt_version: NARRATIVE_PROMPT_VERSION,
    findings: rankingFacts(findings),
    feedback: boundedFeedbackAggregates(feedback),
  };
  return createHash("sha256")
    .update(canonicalJson(context))
    .digest("hex");
}

function presentNarrativeSelection(selection, findings) {
  const findingsById = new Map(
    findings.map((finding) => [finding.id, finding]),
  );
  const selected = selection.findingIds
    .map((id) => findingsById.get(id))
    .filter(Boolean);
  const lead = findingsById.get(selection.leadFindingId);
  if (!lead || !selected.length) return null;
  return {
    headline: actionTitle(lead),
    bullets: selected
      .map(actionBullet)
      .filter(Boolean)
      .slice(0, MAX_RANKED_FINDINGS),
    findingIds: [...selection.findingIds],
  };
}

function rankingFacts(findings) {
  return deduplicateFindings(prioritizedFindings(findings))
    .slice(0, MAX_CANDIDATE_FINDINGS)
    .map((finding) => ({
      id: String(finding.id),
      family: boundedText(finding.family, 40),
      type: boundedText(finding.type, 80),
      severity: boundedText(finding.severity, 24),
      feedback_key: validFeedbackKey(
        finding.feedback_key ?? finding.finding_key,
      )
        ? finding.feedback_key ?? finding.finding_key
        : null,
      priority_basis_points: boundedBasisPoints(
        finding.priority_basis_points,
      ),
      action_title: actionTitle(finding),
      action_detail: actionDetail(finding),
      period_label: periodLabel(finding),
      cta_keys: Array.isArray(finding.actions)
        ? finding.actions
            .map((action) => action?.type)
            .filter(
              (type) =>
                typeof type === "string" &&
                /^[a-z][a-z0-9_]{0,39}$/.test(type),
            )
            .slice(0, 5)
        : [],
    }));
}

function deduplicateFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = String(
      finding.finding_key ?? finding.feedback_key ?? finding.id,
    );
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function prioritizedFindings(findings) {
  const severityRank = {
    important: 0,
    attention: 1,
    info: 2,
  };
  return findings
    .map((finding, index) => ({
      finding,
      index,
      demoted: presentInsightForWeb(finding).isDemoted ? 1 : 0,
      severity:
        severityRank[String(finding.severity ?? "").toLowerCase()] ?? 3,
    }))
    .sort(
      (left, right) =>
        left.demoted - right.demoted ||
        left.severity - right.severity ||
        left.index - right.index,
    )
    .map(({ finding }) => finding);
}

function boundedFeedbackAggregates(feedback) {
  const source = isRecord(feedback) ? feedback : {};
  let remaining = MAX_FEEDBACK_ENTRIES;
  const bad = sanitizeFeedbackGroup(source.bad, {
    includeReasons: true,
    limit: remaining,
  });
  remaining -= bad.length;
  const archived = sanitizeFeedbackGroup(source.archived, {
    includeReasons: false,
    limit: remaining,
  });
  return { bad, archived };
}

function sanitizeFeedbackGroup(
  entries,
  { includeReasons, limit },
) {
  if (!Array.isArray(entries) || limit < 1) return [];
  const seen = new Set();
  const sanitized = [];
  for (const entry of entries) {
    if (
      sanitized.length >= limit ||
      !isRecord(entry) ||
      !validFeedbackKey(entry.feedback_key) ||
      seen.has(entry.feedback_key)
    ) {
      continue;
    }
    const count = Number(entry.count);
    if (!Number.isInteger(count) || count < 1) continue;
    seen.add(entry.feedback_key);
    sanitized.push({
      feedback_key: entry.feedback_key,
      count: Math.min(count, 99),
      ...(includeReasons
        ? {
            reason_codes: Array.isArray(entry.reason_codes)
              ? [
                  ...new Set(
                    entry.reason_codes.filter(
                      (reason) =>
                        typeof reason === "string" &&
                        /^[a-z][a-z0-9_]{0,31}$/.test(reason),
                    ),
                  ),
                ].slice(0, 3)
              : [],
          }
        : {}),
    });
  }
  return sanitized;
}

function validFeedbackKey(value) {
  return (
    typeof value === "string" &&
    /^[a-z0-9][a-z0-9_.:-]{0,159}$/i.test(value)
  );
}

function actionTitle(finding) {
  const presentation = deterministicPresentation(finding);
  return (
    boundedText(presentation.actionTitle, 140) ||
    boundedText(presentation.title, 140) ||
    "Review this finance insight"
  );
}

function actionDetail(finding) {
  const presentation = deterministicPresentation(finding);
  return (
    boundedText(presentation.detail, 240) ||
    boundedText(presentation.explanation, 240) ||
    ""
  );
}

function periodLabel(finding) {
  const supplied = boundedText(
    deterministicPresentation(finding).timeframe,
    80,
  );
  if (supplied) return supplied;
  const start = boundedText(finding.period_start, 32);
  const end = boundedText(finding.period_end, 32);
  if (start && end) return `${start}–${end}`;
  return start || end || "";
}

function deterministicPresentation(finding) {
  return presentInsightForWeb({
    ...finding,
    actionTitle: finding.action_title ?? finding.actionTitle,
    detail: finding.action_detail ?? finding.detail,
    timeframe:
      finding.period_label ??
      finding.timeframe ??
      explicitPeriodLabel(finding),
  });
}

function explicitPeriodLabel(finding) {
  const start = boundedText(finding.period_start, 32);
  const end = boundedText(finding.period_end, 32);
  if (start && end) return `${start}–${end}`;
  return start || end || "";
}

function actionBullet(finding) {
  const detail = actionDetail(finding);
  const period = periodLabel(finding);
  return boundedText(
    [period, detail].filter(Boolean).join(" — "),
    240,
  );
}

function boundedBasisPoints(value) {
  return Number.isInteger(value) && value >= 0 && value <= 10_000
    ? value
    : null;
}

function boundedText(value, maximumLength) {
  if (value == null) return "";
  const text = String(value).trim();
  return text ? text.slice(0, maximumLength) : "";
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Kept for callers that still validate the original prose contract. New LM
// responses use validateNarrativeSelection and never supply model-written prose.
export function validateNarrative(value, findings) {
  if (
    !value ||
    typeof value.headline !== "string" ||
    value.headline.length < 1 ||
    value.headline.length > 140 ||
    !Array.isArray(value.bullets) ||
    value.bullets.length > 3 ||
    value.bullets.some(
      (bullet) => typeof bullet !== "string" || bullet.length > 240,
    ) ||
    !Array.isArray(value.finding_ids)
  ) {
    return null;
  }
  const knownIds = new Set(findings.map((finding) => finding.id));
  if (
    value.finding_ids.some(
      (id) => typeof id !== "string" || !knownIds.has(id),
    )
  ) {
    return null;
  }
  const allowedNumbers = new Set(
    JSON.stringify(findings).match(/-?\d+(?:\.\d+)?/g) ?? [],
  );
  const proseNumbers = [
    ...(value.headline.match(/-?\d+(?:\.\d+)?/g) ?? []),
    ...value.bullets.flatMap(
      (bullet) => bullet.match(/-?\d+(?:\.\d+)?/g) ?? [],
    ),
  ];
  if (proseNumbers.some((number) => !allowedNumbers.has(number))) {
    return null;
  }
  const sourceWords = normalizedWordSet(JSON.stringify(findings));
  const prose = [value.headline, ...value.bullets];
  if (
    prose.some((statement) =>
      [...normalizedWordSet(statement)].some(
        (word) =>
          !sourceWords.has(word) &&
          !SAFE_NARRATIVE_WORDS.has(word),
      ),
    )
  ) {
    return null;
  }
  return {
    headline: value.headline,
    bullets: value.bullets,
    findingIds: [...new Set(value.finding_ids)],
  };
}

const SAFE_NARRATIVE_WORDS = new Set(
  [
    "a",
    "about",
    "across",
    "an",
    "and",
    "are",
    "as",
    "at",
    "attention",
    "be",
    "been",
    "but",
    "by",
    "current",
    "deterministic",
    "finance",
    "financial",
    "finding",
    "findings",
    "for",
    "from",
    "had",
    "has",
    "have",
    "in",
    "insight",
    "insights",
    "investment",
    "investments",
    "is",
    "it",
    "its",
    "needs",
    "note",
    "of",
    "on",
    "or",
    "portfolio",
    "prior",
    "ready",
    "review",
    "show",
    "shows",
    "subscription",
    "subscriptions",
    "that",
    "the",
    "these",
    "this",
    "those",
    "to",
    "was",
    "were",
    "weekly",
    "with",
    "without",
    "you",
    "your",
  ],
);

function normalizedWordSet(value) {
  return new Set(
    String(value)
      .normalize("NFKD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .match(/[a-z][a-z0-9]*/g) ?? [],
  );
}
