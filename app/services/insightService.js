import { dateOnly, shiftDateOnly } from "./analytics.js";
import {
  detectInvestmentInsights,
  detectSubscriptionInsights,
  detectWeeklyInsights,
} from "./insightDetectors.js";
import { narrativeContextHash } from "./narrativeService.js";

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
    if (freshness.partial) {
      return {
        weekly: [],
        investments: [],
        subscriptions: [],
        skipped: true,
        reason: "partial_freshness",
        freshness,
      };
    }
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
      if (this.#narrativeService) {
        const feedback =
          (await this.#repository.getInsightFeedbackSummary?.(
            workspaceId,
            {
              family,
              limit: 12,
            },
          )) ?? { bad: [], archived: [] };
        const narrative = await this.#narrativeService.generate(
          family,
          findings,
          feedback,
        );
        if (narrative) {
          await this.#repository.saveNarrative(workspaceId, {
            family,
            findingsHash: narrativeContextHash(findings, feedback),
            ...narrative,
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
