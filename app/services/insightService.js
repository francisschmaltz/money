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
    const [freshness, rules, transactions, streams, holdings, snapshots, investmentTransactions] =
      await Promise.all([
        this.#repository.getDataFreshness(workspaceId),
        this.#repository.getInsightRules(workspaceId),
        this.#repository.getTransactionsForPeriod(workspaceId, {
          startOn: shiftDateOnly(now, -400),
          endOn: shiftDateOnly(now, 1),
          activeAccountsOnly: true,
        }),
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
    const dataAsOf = freshness.data_as_of ?? now;
    const weeklyRule = rules["weekly.spend_less"] ?? {};
    const fixedCategoriesRule = rules["weekly.fixed_categories"] ?? {};
    const investmentRule = rules["investments.concentration"] ?? {};
    const subscriptionRule = rules["subscriptions.expensive"] ?? {};

    const families = {
      weekly: detectWeeklyInsights(transactions, {
        asOf: now,
        dataAsOf,
        currency: this.#currency,
        baseUrl: this.#baseUrl,
        minimumChangeMinor:
          weeklyRule.minimum_change_minor ?? 2_500,
        minimumChangeBasisPoints:
          weeklyRule.minimum_change_basis_points ?? 1_500,
        fixedCategories:
          fixedCategoriesRule.enabled === false
            ? []
            : fixedCategoriesRule.categories ?? [],
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
      subscriptions: detectSubscriptionInsights(streams, transactions, {
        asOf: now,
        dataAsOf,
        currency: this.#currency,
        baseUrl: this.#baseUrl,
        expensiveThresholdMinor:
          subscriptionRule.monthly_threshold_minor ?? 5_000,
        expensiveEnabled: subscriptionRule.enabled !== false,
      }),
    };

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

export function createInsightService(options) {
  return new InsightService(options);
}
