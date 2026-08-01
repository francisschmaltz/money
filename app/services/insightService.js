import { randomUUID } from "node:crypto";
import { dateOnly, shiftDateOnly } from "./analytics.js";
import {
  detectInvestmentInsights,
  detectSubscriptionInsights,
  detectWeeklyInsights,
} from "./insightDetectors.js";
import {
  DEFAULT_INSIGHT_LLM_SETTINGS,
  insightLlmPromptHash,
  narrativeContextHash,
  validateInsightLlmSettings,
} from "./narrativeService.js";

export class InsightService {
  #repository;
  #narrativeService;
  #workspaceId;
  #currency;
  #baseUrl;
  #now;

  constructor({
    repository,
    narrativeService = null,
    workspaceId = "shared",
    currency = "USD",
    baseUrl = "https://money.example.com",
    now = () => new Date(),
  }) {
    this.#repository = repository;
    this.#narrativeService = narrativeService;
    this.#workspaceId = workspaceId;
    this.#currency = currency;
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#now = now;
  }

  async generateAll({ workspaceId = this.#workspaceId } = {}) {
    const generationSettings =
      (await this.#repository.getInsightSettings?.(workspaceId)) ?? {
        enabled: true,
      };
    if (generationSettings.enabled === false) {
      return {
        weekly: [],
        investments: [],
        subscriptions: [],
        skipped: true,
        reason: "manual_pause",
      };
    }
    const now = this.#now();
    // Nightly insight generation also advances local history on quiet days;
    // otherwise unchanged balances would leave holes and make performance
    // calculations look incomplete forever.
    await this.#repository.takeDailySnapshots(workspaceId, dateOnly(now));
    const [
      freshness,
      rules,
      categories,
      streams,
      holdings,
      snapshots,
      investmentTransactions,
    ] =
      await Promise.all([
        this.#repository.getDataFreshness(workspaceId),
        this.#repository.getInsightRules(workspaceId),
        typeof this.#repository.listSpendingCategories === "function"
          ? this.#repository.listSpendingCategories(workspaceId)
          : [],
        this.#repository.listRecurringStreams(workspaceId, {
          includeInactive: true,
        }),
        this.#repository.getHoldings(workspaceId),
        this.#repository.getHoldingSnapshots(workspaceId, {
          startOn: shiftDateOnly(now, -400),
          endOn: shiftDateOnly(now, 1),
          activeAccountsOnly: true,
        }),
        this.#repository.getInvestmentTransactions(workspaceId, {
          startOn: shiftDateOnly(now, -400),
          endOn: shiftDateOnly(now, 1),
          activeAccountsOnly: true,
        }),
      ]);
    const weeklyTransactions =
      await this.#repository.getTransactionsForPeriod(workspaceId, {
        startOn: shiftDateOnly(now, -89),
        endOn: shiftDateOnly(now, 1),
        activeAccountsOnly: true,
      });
    const subscriptionTransactionIds = [
      ...new Set(
        streams
          .filter(
            (stream) =>
              stream.stream_type === "subscription" &&
              stream.currency_code === this.#currency,
          )
          .flatMap((stream) =>
            (stream.transaction_ids ?? []).slice(-5),
          ),
      ),
    ].slice(0, 200);
    const subscriptionTransactions =
      typeof this.#repository.getTransactionsByIds === "function"
        ? await this.#repository.getTransactionsByIds(
            workspaceId,
            subscriptionTransactionIds,
          )
        : weeklyTransactions.filter((transaction) =>
            subscriptionTransactionIds.includes(transaction.id),
          );
    const dataAsOf = freshness.data_as_of ?? now;
    const weeklyRule = rules["weekly.spend_less"] ?? {};
    const fixedCategoriesRule = rules["weekly.fixed_categories"] ?? {};
    const investmentRule = rules["investments.concentration"] ?? {};
    const subscriptionRule = rules["subscriptions.expensive"] ?? {};
    const fixedCategories = categories.length
      ? categories
          .filter((category) => category.classification === "fixed")
          .map((category) => category.path)
      : fixedCategoriesRule.enabled === false
        ? []
        : fixedCategoriesRule.categories ?? [];

    const detectedFamilies = {
      weekly: detectWeeklyInsights(weeklyTransactions, {
        asOf: now,
        dataAsOf,
        currency: this.#currency,
        baseUrl: this.#baseUrl,
        minimumChangeMinor:
          weeklyRule.minimum_change_minor ?? 2_500,
        minimumChangeBasisPoints:
          weeklyRule.minimum_change_basis_points ?? 1_500,
        fixedCategories,
        spendLessEnabled: weeklyRule.enabled !== false,
      }),
      investments: detectInvestmentInsights({
        holdings,
        snapshots,
        investmentTransactions,
        asOf: now,
        dataAsOf,
        currency: this.#currency,
        baseUrl: this.#baseUrl,
        concentrationBasisPoints:
          investmentRule.threshold_basis_points ?? 2_500,
        concentrationEnabled: investmentRule.enabled !== false,
        investmentHistoryComplete: !freshness.partial,
      }),
      subscriptions: detectSubscriptionInsights(
        streams,
        subscriptionTransactions,
        {
          asOf: now,
          dataAsOf,
          currency: this.#currency,
          baseUrl: this.#baseUrl,
          expensiveThresholdMinor:
            subscriptionRule.monthly_threshold_minor ?? 5_000,
          expensiveEnabled: subscriptionRule.enabled !== false,
        },
      ),
    };
    const families = Object.fromEntries(
      Object.entries(detectedFamilies).map(([family, findings]) => [
        family,
        selectHighQualityFindings(findings, 5),
      ]),
    );

    for (const [family, findings] of Object.entries(families)) {
      await this.#repository.replaceInsightFindings(
        workspaceId,
        family,
        findings,
      );
    }

    if (this.#narrativeService) {
      const storedSettings =
        (await this.#repository.getInsightLlmSettings?.(
          workspaceId,
        )) ?? DEFAULT_INSIGHT_LLM_SETTINGS;
      // One immutable settings snapshot governs all three family calls. A
      // concurrent save therefore activates on the next insight run.
      const settings = validateInsightLlmSettings(storedSettings);
      const runId = randomUUID();
      for (const family of Object.keys(families)) {
        const findings = await this.#repository.listInsightFindings(
          workspaceId,
          {
            family,
            scope: "active",
            limit: 200,
          },
        );
        const feedback =
          settings.feedback_mode === "none" ||
          settings.feedback_limit === 0
            ? { bad: [], archived: [] }
            : (await this.#repository.getInsightFeedbackSummary?.(
                workspaceId,
                {
                  family,
                  limit: settings.feedback_limit,
                },
              )) ?? { bad: [], archived: [] };
        const execution = await executeNarrativeProduction(
          this.#narrativeService,
          family,
          findings,
          feedback,
          settings,
        );
        await this.#repository.upsertInsightLlmCallStatus?.(
          workspaceId,
          {
            ...execution.telemetry,
            family,
            run_id: runId,
            guidance_revision: settings.revision,
            status: execution.status,
          },
        );
        if (
          execution.status === "succeeded" &&
          execution.narrative
        ) {
          await this.#repository.saveNarrative(workspaceId, {
            family,
            findingsHash:
              execution.context_hash ??
              narrativeContextHash(findings, feedback, {
                family,
                settings,
                model: execution.model ?? null,
              }),
            guidanceRevision: settings.revision,
            promptHash:
              execution.prompt_hash ??
              insightLlmPromptHash(family, settings),
            model:
              execution.model ??
              execution.telemetry?.model ??
              "",
            presentation: execution.narrative,
          });
        }
      }
    }
    await this.#repository.rebuildSearchDocuments?.(workspaceId);
    return families;
  }
}

export function selectHighQualityFindings(findings, limit = 5) {
  const severity = { important: 0, attention: 1, info: 2 };
  const typePriority = {
    needs_review: 0,
    possible_duplicate: 0,
    price_increase: 1,
  };
  const ranked = [...findings].sort(
    (left, right) =>
      (typePriority[left.type] ?? 2) - (typePriority[right.type] ?? 2) ||
      (severity[left.severity] ?? 3) - (severity[right.severity] ?? 3) ||
      (right.confidence_basis_points ?? 0) -
        (left.confidence_basis_points ?? 0) ||
      left.id.localeCompare(right.id),
  );
  const usedEvidence = new Set();
  const selected = [];
  for (const finding of ranked) {
    const evidenceKeys = (finding.evidence ?? [])
      .map((entry) => `${entry.entity_type}:${entry.entity_id}`)
      .filter((key) => !key.endsWith(":undefined"));
    if (
      evidenceKeys.length &&
      evidenceKeys.some((key) => usedEvidence.has(key))
    ) {
      continue;
    }
    selected.push(finding);
    evidenceKeys.forEach((key) => usedEvidence.add(key));
    if (selected.length >= limit) break;
  }
  return selected;
}

export function createInsightService(options) {
  return new InsightService(options);
}

async function executeNarrativeProduction(
  service,
  family,
  findings,
  feedback,
  settings,
) {
  if (typeof service.executeProduction === "function") {
    return service.executeProduction({
      family,
      findings,
      feedback,
      settings,
    });
  }
  const narrative = await service.generate(
    family,
    findings,
    feedback,
    settings,
  );
  return {
    status: narrative ? "succeeded" : "provider_error",
    narrative,
    model: "",
    prompt_hash: insightLlmPromptHash(family, settings),
    context_hash: narrativeContextHash(findings, feedback, {
      family,
      settings,
    }),
    telemetry: {
      model: "",
      estimated_input_tokens: 0,
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      context_length: null,
      finish_reason: null,
      latency_ms: null,
      called_at: new Date().toISOString(),
    },
  };
}
