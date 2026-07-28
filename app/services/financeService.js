import {
  buildCashFlow,
  buildBalanceSummary,
  buildCreditSummary,
  buildNetWorthHistory,
  buildOverview,
  buildPortfolioSummary,
  buildSpendingSummary,
  completedWeeklyPeriods,
  dateOnly,
  inferBalanceGroup,
  money,
  periodForMonth,
  shiftDateOnly,
  splitHoldingEquity,
} from "./analytics.js";
import { formatMinorMoney } from "../currency.js";
import { log } from "../log.js";
import {
  canonicalTransactionCategory,
  transactionCategoryLabel,
  transactionCategoryOptions,
} from "./transactionCategories.js";
import { presentInsightForWeb } from "./insightPresentation.js";
import {
  normalizeMerchant,
  normalizeTransactionName,
} from "../providers/plaidNormalizer.js";
import {
  cashCurrencyCode,
  isCashSecurity,
} from "./investmentSecurities.js";
import {
  buildCreditScoreSummary,
  CREDIT_SCORE_PRESETS,
} from "./creditScoreTracking.js";
import { expandTransactionsWithSplits } from "./planningAnalytics.js";

const CATEGORY_COLORS = [
  "#2fa94f",
  "#5cc576",
  "#91d8a5",
  "#8abde9",
  "#438bd7",
  "#2764ae",
  "#a7a7a7",
  "#666666",
];

const TRANSACTION_SORTS = new Set([
  "date",
  "merchant",
  "category",
  "cost",
]);
const INSIGHT_INCORRECT_REASON_CODES = new Set([
  "not_subscription",
  "wrong_data",
  "wrong_interpretation",
  "other_false_positive",
]);

export class FinanceService {
  #repository;
  #jobQueue;
  #now;
  #workspaceId;
  #currency;
  #baseUrl;

  constructor({
    repository,
    jobQueue = null,
    now = () => new Date(),
    workspaceId = "shared",
    currency = "USD",
    baseUrl = "https://money.example.com",
  }) {
    if (!repository) throw new TypeError("repository is required");
    this.#repository = repository;
    this.#jobQueue = jobQueue;
    this.#now = now;
    this.#workspaceId = workspaceId;
    this.#currency = currency;
    this.#baseUrl = baseUrl.replace(/\/$/, "");
  }

  async getFinanceOverview({ asOf, as_of } = {}) {
    const requestedAsOf = asOf ?? as_of ?? null;
    const runtimeNow = this.#now();
    const effectiveNow = parseAsOf(requestedAsOf, runtimeNow);
    const historical =
      requestedAsOf != null &&
      dateOnly(effectiveNow) < dateOnly(runtimeNow);
    const periods = periodForMonth(effectiveNow);
    periods.current.end_on = earlierDate(
      periods.current.end_on,
      shiftDateOnly(effectiveNow, 1),
    );
    const [
      currentAccounts,
      transactions,
      transactionSplits,
      holdings,
      recurringStreams,
      repositoryFreshness,
      accountSnapshots,
      rawManualAssets,
      manualAssetValuations,
    ] = await Promise.all([
      this.#repository.listAccounts(this.#workspaceId),
      this.#repository.getTransactionsForPeriod(this.#workspaceId, {
        startOn: periods.current.start_on,
        endOn: periods.current.end_on,
      }),
      optionalRepositoryCall(
        this.#repository,
        "listTransactionSplits",
        [],
        this.#workspaceId,
        {
          startOn: periods.current.start_on,
          endOn: periods.current.end_on,
        },
      ),
      historical
        ? []
        : this.#repository.getHoldings(this.#workspaceId),
      historical
        ? []
        : this.#repository.listRecurringStreams(this.#workspaceId),
      this.#repository.getDataFreshness(this.#workspaceId),
      historical
        ? optionalRepositoryCall(
            this.#repository,
            "getAccountSnapshots",
            [],
            this.#workspaceId,
            { endOn: shiftDateOnly(effectiveNow, 1) },
          )
        : [],
      optionalRepositoryCall(
        this.#repository,
        "listManualAssets",
        [],
        this.#workspaceId,
        {
          includeInactive: historical,
          asOf: dateOnly(effectiveNow),
        },
      ),
      optionalRepositoryCall(
        this.#repository,
        "getManualAssetValuations",
        [],
        this.#workspaceId,
        { endOn: shiftDateOnly(effectiveNow, 1) },
      ),
    ]);
    const accounts = historical
      ? accountsAtSnapshots(currentAccounts, accountSnapshots)
      : currentAccounts;
    const manualAssets = manualAssetsAt(
      rawManualAssets,
      manualAssetValuations,
      effectiveNow,
      { historical },
    );
    const data = buildOverview({
      accounts,
      transactions: expandTransactionsWithSplits(
        transactions,
        transactionSplits,
      ),
      holdings,
      recurringStreams,
      manualAssets,
      currency: this.#currency,
      periodStart: periods.current.start_on,
      periodEnd: periods.current.end_on,
    });
    data.portfolio = money(
      data.taxable_investments.amount_minor +
        data.retirement_assets.amount_minor,
      this.#currency,
    );
    data.manual_assets = manualAssets
      .filter((asset) => asset.currency_code === this.#currency)
      .slice(0, 25)
      .map(manualAssetCard);
    const historicalSnapshotMissing =
      historical &&
      currentAccounts.length > 0 &&
      accountSnapshots.length === 0;
    const baseFreshness = historicalFreshness(
      repositoryFreshness,
      requestedAsOf,
      historicalSnapshotMissing,
    );
    const warnings = [];
    if (historicalSnapshotMissing) {
      warnings.push(
        "Historical account balances are unavailable; current balances were not substituted.",
      );
    }
    if (manualAssets.length > data.manual_assets.length) {
      warnings.push("Manual assets were truncated to 25 items.");
    }
    if (data.unknown_balance_count > 0) {
      warnings.push(
        `${data.unknown_balance_count} USD balance${data.unknown_balance_count === 1 ? " is" : "s are"} unknown and excluded from totals.`,
      );
    }
    if (data.excluded_from_usd_total_count > 0) {
      warnings.push(
        `${data.excluded_from_usd_total_count} non-USD balance${data.excluded_from_usd_total_count === 1 ? " is" : "s are"} excluded from USD totals.`,
      );
    }
    const freshness = {
      ...baseFreshness,
      partial:
        baseFreshness.partial ||
        data.unknown_balance_count > 0,
    };
    return this.#result({
      data,
      freshness,
      warnings,
      title: "Finance overview",
      subtitle: formatMonth(effectiveNow),
      path: "/",
      summary: `Cash balance is ${formatMoney(data.cash_balance)}, short-term worth is ${formatMoney(data.short_term_worth)}, and net worth is ${formatMoney(data.net_worth)}. ${formatMoney(data.spending)} was spent this month. ${freshnessSentence(freshness)}`,
    });
  }

  async listAccounts(options = {}) {
    const runtimeNow = this.#now();
    const accountType =
      options.accountType ?? options.account_type ?? "all";
    const institutionId =
      options.institutionId ?? options.institution_id ?? null;
    const balanceGroup =
      options.balanceGroup ?? options.balance_group ?? null;
    if (balanceGroup != null) validatedBalanceGroup(balanceGroup);
    const includeClosed =
      booleanOption(options.includeClosed ?? options.include_closed, false);
    const limit = bounded(options.limit, 50, 100);
    const cursor = decodeOffsetCursor(options.cursor, "accounts");
    const [allAccounts, freshness, rawManualAssets, manualAssetValuations] =
      await Promise.all([
      this.#repository.listAccounts(this.#workspaceId, {
        includeInactive: includeClosed,
      }),
      this.#repository.getDataFreshness(this.#workspaceId),
      optionalRepositoryCall(
        this.#repository,
        "listManualAssets",
        [],
        this.#workspaceId,
        {
          includeInactive: includeClosed,
          asOf: dateOnly(runtimeNow),
        },
      ),
      optionalRepositoryCall(
        this.#repository,
        "getManualAssetValuations",
        [],
        this.#workspaceId,
        { endOn: shiftDateOnly(runtimeNow, 1) },
      ),
    ]);
    const manualAssets = manualAssetsAt(
      rawManualAssets,
      manualAssetValuations,
      runtimeNow,
    );
    const filtered = allAccounts.filter(
      (account) =>
        (accountType === "all" || account.type === accountType) &&
        (!institutionId || account.institution_id === institutionId) &&
        (!balanceGroup ||
          inferBalanceGroup(account) === balanceGroup),
    );
    const page = filtered.slice(cursor, cursor + limit);
    const groups = new Map();
    for (const account of page) {
      const key = account.institution_name ?? "Other";
      const group = groups.get(key) ?? {
        institution_id: account.institution_id,
        institution_name: key,
        accounts: [],
      };
      group.accounts.push(accountCard(account));
      groups.set(key, group);
    }
    const hasMore = cursor + limit < filtered.length;
    const balanceSummary = buildBalanceSummary({
      accounts: allAccounts,
      manualAssets,
      currency: this.#currency,
    });
    const creditSummary = buildCreditSummary({
      accounts: allAccounts,
      currency: this.#currency,
    }).summary;
    const warnings = [];
    if (manualAssets.length > 25) {
      warnings.push("Manual assets were truncated to 25 items.");
    }
    if (balanceSummary.unknown_balance_count > 0) {
      warnings.push(
        `${balanceSummary.unknown_balance_count} USD balance${balanceSummary.unknown_balance_count === 1 ? " is" : "s are"} unknown and excluded from totals.`,
      );
    }
    if (balanceSummary.excluded_from_usd_total_count > 0) {
      warnings.push(
        `${balanceSummary.excluded_from_usd_total_count} non-USD balance${balanceSummary.excluded_from_usd_total_count === 1 ? " is" : "s are"} excluded from USD totals.`,
      );
    }
    const resultFreshness = {
      ...freshness,
      partial:
        freshness.partial ||
        balanceSummary.unknown_balance_count > 0,
    };
    return this.#result({
      data: {
        groups: [...groups.values()],
        account_count: filtered.length,
        manual_assets: manualAssets.slice(0, 25).map(manualAssetCard),
        manual_asset_count: manualAssets.length,
        balance_summary: balanceSummary,
        credit_summary: creditSummary,
        page_info: {
          has_more: hasMore,
          next_cursor: hasMore
            ? encodeOffsetCursor("accounts", cursor + limit)
            : null,
        },
      },
      freshness: resultFreshness,
      title: "Accounts",
      subtitle: `${filtered.length} connected`,
      path: "/accounts",
      warnings,
      summary: `${filtered.length} connected account${filtered.length === 1 ? "" : "s"} matched and ${manualAssets.length} manual asset${manualAssets.length === 1 ? "" : "s"} exist. Cash balance is ${formatMoney(balanceSummary.cash_balance)} and net worth is ${formatMoney(balanceSummary.net_worth)}. ${freshnessSentence(freshness)}`,
    });
  }

  async getCreditSummary(options = {}) {
    const now = this.#now();
    const period = dashboardHistoryPeriod(
      options.period ?? "1m",
      now,
    );
    const currentOn = dateOnly(now);
    const snapshotRead = this.#repository
      .getAccountSnapshots(this.#workspaceId, {
        startOn: period.start_on,
        endOn: period.end_on,
      })
      .then((snapshots) => ({ snapshots, error: null }))
      .catch((error) => ({ snapshots: [], error }));
    const [accounts, snapshotResult, freshness] = await Promise.all([
      this.#repository.listAccounts(this.#workspaceId),
      snapshotRead,
      this.#repository.getDataFreshness(this.#workspaceId),
    ]);
    const { snapshots } = snapshotResult;
    if (snapshotResult.error) {
      log("error", "Credit history refresh failed", {
        requestId: options.requestId ?? null,
        error: {
          name: snapshotResult.error?.name,
          message: snapshotResult.error?.message,
        },
      });
    }
    const data = buildCreditSummary({
      accounts,
      snapshots,
      currency: this.#currency,
      currentOn,
    });
    const originalAggregateCount = data.series.length;
    data.series = sampleSeries(
      downsampleSeries(data.series, period.interval),
      80,
    );
    let originalCardPointCount = 0;
    let returnedCardPointCount = 0;
    data.cards = data.cards.map((card) => {
      originalCardPointCount += card.series.length;
      const series = sampleSeries(
        downsampleSeries(card.series, period.interval),
        80,
      );
      returnedCardPointCount += series.length;
      return { ...card, series };
    });
    data.period = {
      name: period.name,
      label: period.label,
      start_on: period.start_on,
      end_on: period.end_on,
    };

    const warnings = [];
    if (snapshotResult.error) {
      warnings.push(
        "Credit history couldn’t be refreshed. Current card balances and utilization are still shown.",
      );
    }
    if (data.summary.missing_limit_card_count > 0) {
      warnings.push(
        `${data.summary.missing_limit_card_count} USD credit card${
          data.summary.missing_limit_card_count === 1 ? " has" : "s have"
        } no usable credit limit and ${
          data.summary.missing_limit_card_count === 1 ? "is" : "are"
        } excluded from utilization.`,
      );
    }
    if (data.summary.missing_balance_card_count > 0) {
      warnings.push(
        `${data.summary.missing_balance_card_count} USD credit card${
          data.summary.missing_balance_card_count === 1 ? " has" : "s have"
        } an unknown balance.`,
      );
    }
    if (data.summary.excluded_from_usd_total_count > 0) {
      warnings.push(
        `${data.summary.excluded_from_usd_total_count} non-USD credit card${
          data.summary.excluded_from_usd_total_count === 1 ? " remains" : "s remain"
        } visible but ${
          data.summary.excluded_from_usd_total_count === 1 ? "is" : "are"
        } excluded from USD totals.`,
      );
    }
    const hasPriorHistory = data.cards.some((card) =>
      card.series.some((point) => point.timestamp < currentOn),
    );
    const historyPartial = data.series.some((point) => point.partial);
    if (data.cards.length > 0 && !hasPriorHistory) {
      warnings.push(
        "Credit history begins with the first local snapshot; earlier usage was not invented.",
      );
    } else if (historyPartial) {
      warnings.push(
        "Some historical credit limits are unavailable; current limits were not backfilled into older snapshots.",
      );
    }
    if (
      originalAggregateCount > data.series.length ||
      originalCardPointCount > returnedCardPointCount
    ) {
      warnings.push(
        "Credit history was sampled to keep each series bounded to 80 points.",
      );
    }

    const incomplete =
      Boolean(snapshotResult.error) ||
      data.summary.missing_limit_card_count > 0 ||
      data.summary.missing_balance_card_count > 0 ||
      (data.cards.length > 0 && !hasPriorHistory) ||
      historyPartial;
    const utilization =
      data.summary.utilization_basis_points == null
        ? "unavailable"
        : formatBasisPoints(
            data.summary.utilization_basis_points,
          );
    return this.#result({
      data,
      freshness: {
        ...freshness,
        partial: freshness.partial || incomplete,
      },
      warnings,
      title: "Credit",
      subtitle: period.label,
      path: `/credit?period=${period.name}`,
      summary:
        data.summary.card_count === 0
          ? `No connected credit cards were found. ${freshnessSentence(freshness)}`
          : `${formatMoney(data.summary.total_balance_owed)} is owed across ${data.summary.card_count} credit card${data.summary.card_count === 1 ? "" : "s"}, against ${formatMoney(data.summary.total_credit_limit)} in known limits. Utilization is ${utilization}. ${freshnessSentence(freshness)}`,
    });
  }

  async listTransactions(options = {}) {
    const startOn = options.startOn ?? options.start_date;
    const endOn = options.endOn ?? options.end_date;
    const accountId = options.accountId ?? options.account_id;
    const search = options.search ?? options.query;
    const minAmountMinor =
      options.minAmountMinor ?? options.min_amount_minor;
    const maxAmountMinor =
      options.maxAmountMinor ?? options.max_amount_minor;
    const sort = normalizeTransactionSort(options.sort);
    const repositoryOptions = {
      ...(search ? { search } : {}),
      ...(startOn ? { startOn } : {}),
      ...(endOn ? { endOn } : {}),
      ...(accountId ? { accountId } : {}),
      ...(options.category ? { category: options.category } : {}),
      status: options.status ?? "all",
      includePending:
        (options.status ?? "all") !== "posted" &&
        booleanOption(options.includePending, true),
      ...(minAmountMinor !== undefined ? { minAmountMinor } : {}),
      ...(maxAmountMinor !== undefined ? { maxAmountMinor } : {}),
      ...(options.sort != null ? { sort } : {}),
      limit: bounded(options.limit, 50, 100),
      ...(options.cursor ? { cursor: options.cursor } : {}),
    };
    const [page, freshness] = await Promise.all([
      this.#repository.listTransactions(
        this.#workspaceId,
        repositoryOptions,
      ),
      this.#repository.getDataFreshness(this.#workspaceId),
    ]);
    const transactions = page.transactions.map(transactionCard);
    const pending = transactions.filter(
      (transaction) => transaction.pending,
    ).length;
    return this.#result({
      data: {
        filters: {
          start_date: startOn ?? null,
          end_date: endOn ?? null,
          account_id: accountId ?? null,
          category: options.category ?? null,
          query: search ?? null,
          status: repositoryOptions.status,
          min_amount_minor: minAmountMinor ?? null,
          max_amount_minor: maxAmountMinor ?? null,
          sort,
        },
        transactions,
        page_info: page.pageInfo,
      },
      freshness,
      title: "Transactions",
      subtitle: `${transactions.length} shown`,
      path: "/transactions",
      summary: `${transactions.length} transaction${transactions.length === 1 ? "" : "s"} returned, including ${pending} pending. ${freshnessSentence(freshness)}`,
    });
  }

  async getSpendingSummary(options = {}) {
    const effectiveNow = this.#now();
    const periodName = options.period ?? "month";
    const current = resolvePeriod(
      periodName,
      options.startOn ?? options.start_date,
      options.endOn ?? options.end_date,
      effectiveNow,
    );
    const duration = daysBetween(current.start_on, current.end_on);
    const previous = {
      start_on:
        options.previousStartOn ??
        options.previous_start_date ??
        shiftDateOnly(current.start_on, -duration),
      end_on:
        options.previousEndOn ??
        options.previous_end_date ??
        current.start_on,
    };
    const accountId = options.accountId ?? options.account_id ?? null;
    const category = options.category ?? null;
    const groupBy = options.groupBy ?? options.group_by ?? "category";
    const segmentLimit = bounded(
      options.segmentLimit ?? options.segment_limit,
      12,
      30,
    );
    const splitAware =
      typeof this.#repository.listTransactionSplits === "function";
    const [transactions, splits, freshness, categoryDefinitions] =
      await Promise.all([
        this.#repository.getTransactionsForPeriod(this.#workspaceId, {
          startOn: previous.start_on,
          endOn: current.end_on,
          accountId,
          category: splitAware ? null : category,
        }),
        optionalRepositoryCall(
          this.#repository,
          "listTransactionSplits",
          [],
          this.#workspaceId,
          {
            startOn: previous.start_on,
            endOn: current.end_on,
          },
        ),
        this.#repository.getDataFreshness(this.#workspaceId),
        groupBy === "category"
          ? optionalRepositoryCall(
              this.#repository,
              "listSpendingCategories",
              [],
              this.#workspaceId,
            )
          : [],
      ]);
    const data = buildSpendingSummary({
      transactions: expandAndFilterTransactions(
        transactions,
        splits,
        splitAware ? category : null,
      ),
      currentPeriod: current,
      previousPeriod: previous,
      groupBy,
      currency: this.#currency,
    });
    data.segments = data.segments
      .slice(0, segmentLimit)
      .map((segment) => {
        if (groupBy !== "category") return segment;
        const category = categoryDefinitions.find(
          (candidate) => candidate.path === segment.label,
        );
        return {
          ...segment,
          category_id: category?.id ?? null,
        };
      });
    const spendingSeriesCount = data.series.length;
    data.series = sampleSeries(data.series, 80);
    data.filters = { account_id: accountId, category };
    const warnings =
      spendingSeriesCount > data.series.length
        ? ["Spending series was sampled to 80 points for card delivery."]
        : [];
    return this.#result({
      data,
      freshness,
      warnings,
      title: "Spending",
      subtitle: `${current.start_on}–${shiftDateOnly(current.end_on, -1)}`,
      path: `/transactions?start=${current.start_on}&end=${current.end_on}`,
      summary: `${formatMoney(data.total)} was spent, ${formatTrend(data.trend)} versus the preceding period; ${data.segments[0]?.label ?? "no category"} was largest. ${freshnessSentence(freshness)}`,
    });
  }

  async getCashFlow(options = {}) {
    const current = resolvePeriod(
      options.period ?? "month",
      options.startOn ?? options.start_date,
      options.endOn ?? options.end_date,
      this.#now(),
    );
    const interval = options.interval ?? "week";
    const accountId = options.accountId ?? options.account_id ?? null;
    const category = options.category ?? null;
    const search = options.search ?? options.query ?? null;
    const splitAware =
      typeof this.#repository.listTransactionSplits === "function";
    const [transactions, splits, freshness] = await Promise.all([
      this.#repository.getTransactionsForPeriod(this.#workspaceId, {
        startOn: current.start_on,
        endOn: current.end_on,
        accountId,
        category: splitAware ? null : category,
        search,
      }),
      optionalRepositoryCall(
        this.#repository,
        "listTransactionSplits",
        [],
        this.#workspaceId,
        {
          startOn: current.start_on,
          endOn: current.end_on,
        },
      ),
      this.#repository.getDataFreshness(this.#workspaceId),
    ]);
    const data = buildCashFlow({
      transactions: expandAndFilterTransactions(
        transactions,
        splits,
        splitAware ? category : null,
      ),
      period: current,
      interval,
      currency: this.#currency,
    });
    const cashFlowBucketCount = data.buckets.length;
    data.buckets = sampleSeries(data.buckets, 80);
    data.filters = { account_id: accountId, category, query: search };
    const warnings =
      cashFlowBucketCount > data.buckets.length
        ? ["Cash-flow buckets were sampled to 80 points for card delivery."]
        : [];
    return this.#result({
      data,
      freshness,
      warnings,
      title: "Cash flow",
      subtitle: `${current.start_on}–${shiftDateOnly(current.end_on, -1)}`,
      path: `/transactions?start=${current.start_on}&end=${current.end_on}`,
      summary: `${formatMoney(data.income)} came in, ${formatMoney(data.spending)} went out, and net cash flow was ${formatMoney(data.net)}. ${freshnessSentence(freshness)}`,
    });
  }

  async listRecurringPayments(options = {}) {
    const kind = options.kind ?? "all";
    const type =
      options.type ??
      (kind === "subscriptions"
        ? "subscription"
        : kind === "bills"
          ? "bill"
          : "all");
    const cadence = options.cadence ?? "all";
    const status = options.status ?? "active";
    const includeInactive =
      booleanOption(options.includeInactive, status !== "active");
    const includeFrequentSpending =
      options.includeFrequentSpending === true;
    const limit = bounded(options.limit, 50, 100);
    const offset = decodeOffsetCursor(options.cursor, "recurring");
    const [streams, freshness] = await Promise.all([
      this.#repository.listRecurringStreams(this.#workspaceId, {
        includeInactive,
      }),
      this.#repository.getDataFreshness(this.#workspaceId),
    ]);
    const filtered = streams.filter(
      (stream) =>
        (includeFrequentSpending ||
          stream.stream_type !== "frequent_spending") &&
        (type === "all" || stream.stream_type === type) &&
        (cadence === "all" || stream.cadence === cadence) &&
        recurringStatusMatches(stream.status, status),
    );
    const page = filtered.slice(offset, offset + limit);
    const paymentStreams = filtered.filter(
      (stream) => stream.stream_type !== "frequent_spending",
    );
    const totalMonthly = paymentStreams
      .filter((stream) =>
        stream.currency_code === this.#currency &&
        ["active", "resumed", "irregular"].includes(stream.status),
      )
      .reduce((sum, stream) => sum + stream.monthly_equivalent_minor, 0);
    const excludedCurrencyCount = paymentStreams.filter(
      (stream) => stream.currency_code !== this.#currency,
    ).length;
    const hasMore = offset + limit < filtered.length;
    const recurringPayments = page.map(recurringCard);
    const data = {
      kind,
      monthly_equivalent: money(totalMonthly, this.#currency),
      annual_equivalent: money(totalMonthly * 12, this.#currency),
      recurring_payments: recurringPayments,
      streams: recurringPayments,
      page_info: {
        has_more: hasMore,
        next_cursor: hasMore
          ? encodeOffsetCursor("recurring", offset + limit)
          : null,
      },
      excluded_from_usd_total_count: excludedCurrencyCount,
    };
    return this.#result({
      data,
      freshness,
      warnings:
        excludedCurrencyCount > 0
          ? [
              `${excludedCurrencyCount} non-USD recurring payment${
                excludedCurrencyCount === 1 ? " was" : "s were"
              } excluded from aggregate totals.`,
            ]
          : [],
      title: "Recurring payments",
      subtitle: `${filtered.length} detected`,
      path: "/recurring",
      summary: `${filtered.length} matching recurring payment${filtered.length === 1 ? "" : "s"} total about ${formatMoney(data.monthly_equivalent)} per month and ${formatMoney(data.annual_equivalent)} per year. ${freshnessSentence(freshness)}`,
    });
  }

  async getNetWorthHistory(options = {}) {
    const startOn =
      options.startOn ?? options.start_date ?? shiftDateOnly(this.#now(), -365);
    const endOn =
      options.endOn ?? options.end_date ?? shiftDateOnly(this.#now(), 1);
    const interval = options.interval ?? "week";
    const limit = bounded(options.limit, 52, 366);
    const includeComponents = options.includeComponents === true;
    const [
      snapshots,
      freshness,
      manualAssets,
      manualAssetValuations,
    ] = await Promise.all([
      this.#repository.getAccountSnapshots(this.#workspaceId, {
        startOn,
        endOn,
      }),
      this.#repository.getDataFreshness(this.#workspaceId),
      optionalRepositoryCall(
        this.#repository,
        "listManualAssets",
        [],
        this.#workspaceId,
        { includeInactive: true },
      ),
      optionalRepositoryCall(
        this.#repository,
        "getManualAssetValuations",
        [],
        this.#workspaceId,
        { endOn },
      ),
    ]);
    const data = buildNetWorthHistory({
      snapshots,
      manualAssets,
      manualAssetValuations,
      currency: this.#currency,
    });
    data.series = downsampleSeries(
      data.series.filter(
        (point) =>
          point.timestamp >= startOn && point.timestamp < endOn,
      ),
      interval,
    ).slice(-limit);
    if (!includeComponents) {
      data.series = data.series.map(
        ({
          cash_balance: _cashBalance,
          short_term_worth: _shortTermWorth,
          retirement_assets: _retirementAssets,
          ...point
        }) => point,
      );
      delete data.current_cash_balance;
      delete data.current_short_term_worth;
      delete data.current_retirement_assets;
    }
    data.period = { start_on: startOn, end_on: endOn };
    data.interval = interval;
    const change =
      data.series.length > 1
        ? data.series.at(-1).net_worth.amount_minor -
          data.series[0].net_worth.amount_minor
        : 0;
    return this.#result({
      data,
      freshness,
      title: "Net worth",
      subtitle: data.series.length
        ? `Since ${data.series[0].timestamp}`
        : "History starts after first sync",
      path: "/",
      summary: data.series.length
        ? `Current net worth is ${formatMoney(data.current_net_worth)}, a ${formatMoney(money(change, this.#currency))} change across the returned history. ${freshnessSentence(freshness)}`
        : `No net-worth snapshots exist yet. ${freshnessSentence(freshness)}`,
    });
  }

  async getPortfolioSummary(options = {}) {
    const period = options.period ?? "1m";
    const { retirementScope, pageScope } = portfolioScope(
      options.retirementScope ??
        options.retirement_scope ??
        options.scope ??
        "include",
    );
    const startOn =
      options.startOn ??
      options.start_date ??
      portfolioPeriodStart(period, this.#now());
    const endOn =
      options.endOn ?? options.end_date ?? shiftDateOnly(this.#now(), 1);
    const accountId = options.accountId ?? options.account_id ?? null;
    const holdingsLimit = bounded(
      options.holdingsLimit ?? options.holdings_limit,
      50,
      100,
    );
    const [
      allHoldings,
      allSnapshots,
      allTransactions,
      freshness,
      accounts,
    ] =
      await Promise.all([
        this.#repository.getHoldings(this.#workspaceId),
        this.#repository.getHoldingSnapshots(this.#workspaceId, {
          startOn,
          endOn,
        }),
        this.#repository.getInvestmentTransactions(this.#workspaceId, {
          startOn,
          endOn,
        }),
        this.#repository.getDataFreshness(this.#workspaceId),
        optionalRepositoryCall(
          this.#repository,
          "listAccounts",
          [],
          this.#workspaceId,
        ),
      ]);
    const accountGroups = new Map(
      accounts.map((account) => [account.id, inferBalanceGroup(account)]),
    );
    const investmentGroup = (entity) =>
      accountGroups.get(entity.account_id) ??
      entity.balance_group ??
      (entity.account_type || entity.account_subtype
        ? inferBalanceGroup({
            type: entity.account_type,
            subtype: entity.account_subtype,
            is_liability: entity.account_is_liability,
            balance_group_override:
              entity.balance_group_override,
          })
        : "taxable_investment");
    const scopedAccount = (entity) => {
      if (accountId && entity.account_id !== accountId) return false;
      const group = investmentGroup(entity);
      if (!["taxable_investment", "retirement"].includes(group)) {
        return false;
      }
      if (retirementScope === "only") return group === "retirement";
      if (retirementScope === "exclude") return group !== "retirement";
      return true;
    };
    const enrichedHoldings = allHoldings.map((holding) => ({
      ...holding,
      balance_group: investmentGroup(holding),
    }));
    const holdings = enrichedHoldings.filter(scopedAccount);
    const snapshots = allSnapshots.filter(scopedAccount);
    const investmentTransactions = allTransactions.filter(scopedAccount);
    const retirementValue = enrichedHoldings
      .filter(
        (holding) =>
          holding.currency_code === this.#currency &&
          holding.balance_group === "retirement",
      )
      .reduce(
        (sum, holding) =>
          sum + splitHoldingEquity(holding).current_value_minor,
        0,
      );
    const taxableValue = enrichedHoldings
      .filter(
        (holding) =>
          holding.currency_code === this.#currency &&
          holding.balance_group === "taxable_investment",
      )
      .reduce(
        (sum, holding) =>
          sum + splitHoldingEquity(holding).current_value_minor,
        0,
      );
    const data = buildPortfolioSummary({
      holdings,
      snapshots,
      investmentTransactions,
      currency: this.#currency,
      now: this.#now(),
      investmentHistoryComplete: !freshness.partial,
      retirementScope,
    });
    data.scope = pageScope;
    data.taxable_value = money(taxableValue, this.#currency);
    data.retirement_value = money(retirementValue, this.#currency);
    const portfolioSeriesCount = data.series.length;
    data.series = sampleSeries(data.series, 80);
    if (portfolioSeriesCount > data.series.length) {
      data.warnings.push(
        "Portfolio series was sampled to 80 points for card delivery.",
      );
    }
    data.holdings = data.holdings.slice(0, holdingsLimit);
    data.period = { name: period, start_on: startOn, end_on: endOn };
    data.filters = {
      account_id: accountId,
      retirement_scope: retirementScope,
    };
    return this.#result({
      data,
      freshness: {
        ...freshness,
        partial: freshness.partial || data.warnings.length > 0,
      },
      warnings: data.warnings,
      title: "Portfolio",
      subtitle:
        retirementScope === "include"
          ? `${holdings.length} holdings`
          : `${holdings.length} ${portfolioScopeLabel(retirementScope)} holdings`,
      path: `/portfolio?scope=${pageScope}`,
      summary: `${portfolioScopeLabel(retirementScope, true)} portfolio value is ${formatMoney(data.total_value)} across ${holdings.length} holdings.${data.estimated_return_basis_points == null ? " Estimated return is unavailable because snapshot or cash-flow history is incomplete." : ` Estimated return is ${formatBasisPoints(data.estimated_return_basis_points)}.`} ${freshnessSentence(freshness)}`,
    });
  }

  async getFinanceInsights(options = {}) {
    return this.#getFinanceInsights(options);
  }

  async #getFinanceInsights(
    options = {},
    { pageDelivery = false } = {},
  ) {
    const section = options.section ?? "all";
    if (
      !["weekly", "investments", "subscriptions", "all"].includes(section)
    ) {
      throw new TypeError(
        "section must be weekly, investments, subscriptions, or all",
      );
    }
    const includeNarratives = booleanOption(
      options.includeNarratives ?? options.include_narratives,
      true,
    );
    const limit = bounded(
      options.limitPerSection ?? options.limit_per_section,
      10,
      25,
    );
    const deliveryLimit = section === "all" ? 2 : 6;
    const effectiveLimit = pageDelivery
      ? limit
      : Math.min(limit, deliveryLimit);
    const insightView =
      pageDelivery && options.view === "archive" ? "archive" : "active";
    const requestedAsOf = options.asOf ?? options.as_of ?? null;
    const effectiveAsOf = parseAsOf(requestedAsOf, this.#now());
    const findingQuery = {
      family: section === "all" ? null : section,
      limit: 200,
      ...(pageDelivery ? { scope: insightView } : {}),
    };
    const [storedFindings, repositoryFreshness] = await Promise.all([
      this.#repository.listInsightFindings(
        this.#workspaceId,
        findingQuery,
      ),
      this.#repository.getDataFreshness(this.#workspaceId),
    ]);
    const cutoff = requestedAsOf ? effectiveAsOf.getTime() : null;
    const findings = cutoff
      ? storedFindings.filter(
          (finding) => new Date(finding.generated_at).getTime() <= cutoff,
        )
      : storedFindings;
    const freshness =
      cutoff &&
      repositoryFreshness.data_as_of &&
      new Date(repositoryFreshness.data_as_of).getTime() > cutoff
        ? {
            ...repositoryFreshness,
            data_as_of: new Date(cutoff).toISOString(),
          }
        : repositoryFreshness;
    const families =
      section === "all"
        ? ["weekly", "investments", "subscriptions"]
        : [section];
    const [portfolioSummary, recurringSummary] = await Promise.all([
      !requestedAsOf && families.includes("investments")
        ? this.getPortfolioSummary({ period: "1m", holdingsLimit: 30 })
        : null,
      !requestedAsOf && families.includes("subscriptions")
        ? this.listRecurringPayments({
            kind: "subscriptions",
            status: "active",
            limit: 100,
          })
        : null,
    ]);
    const sections = {};
    for (const family of families) {
      const allFamilyFindings = findings.filter(
        (finding) => finding.family === family,
      );
      const familyFindings = allFamilyFindings.slice(0, effectiveLimit);
      sections[family] = {
        ...(family === "weekly"
          ? {
              period: completedWeeklyPeriods(effectiveAsOf),
              summary: weeklyInsightSummary(allFamilyFindings),
            }
          : family === "investments"
            ? {
                summary: investmentInsightSummary(
                  portfolioSummary?.data,
                  allFamilyFindings,
                ),
              }
            : {
                summary: subscriptionInsightSummary(
                  recurringSummary?.data,
                  allFamilyFindings,
                ),
              }),
        findings: familyFindings,
        finding_count: allFamilyFindings.length,
        returned_finding_count: familyFindings.length,
        has_more: familyFindings.length < allFamilyFindings.length,
        ...(includeNarratives && !requestedAsOf
          ? {
              narrative:
                (await this.#repository.getLatestNarrative(
                  this.#workspaceId,
                  family,
                )) ?? null,
            }
          : {}),
      };
    }
    const selectedFindings = Object.values(sections).flatMap(
      (value) => value.findings,
    );
    const data = {
      section,
      ...(pageDelivery ? { view: insightView } : {}),
      ...sections,
      finding_count: Object.values(sections).reduce(
        (sum, value) => sum + value.finding_count,
        0,
      ),
      returned_finding_count: selectedFindings.length,
    };
    const top = selectedFindings
      .slice(0, 3)
      .map((finding) => findingSummaryFragment(finding))
      .join("; ");
    const warnings = [];
    if (!pageDelivery && limit > deliveryLimit) {
      warnings.push(
        `Card delivery is limited to ${deliveryLimit} finding${deliveryLimit === 1 ? "" : "s"} per section; returned counts and has_more identify truncation.`,
      );
    }
    if (
      Object.values(sections).some(
        (value) => value.returned_finding_count < value.finding_count,
      ) &&
      (pageDelivery || limit <= deliveryLimit)
    ) {
      warnings.push(
        "Additional findings exist beyond the requested per-section limit.",
      );
    }
    if (
      requestedAsOf &&
      families.some((family) =>
        ["investments", "subscriptions"].includes(family),
      )
    ) {
      warnings.push(
        "Historical insight summaries use stored findings only; live portfolio and subscription totals were not substituted.",
      );
    }
    return this.#result({
      data,
      freshness,
      warnings,
      title: section === "all" ? "Finance insights" : insightTitle(section),
      subtitle: `${selectedFindings.length} findings`,
      path: section === "all" ? "/insights" : `/insights#${section}`,
      summary: selectedFindings.length
        ? `${selectedFindings.length} ${section === "all" ? "finance" : section} finding${selectedFindings.length === 1 ? "" : "s"}: ${top}. ${freshnessSentence(freshness)}`
        : `No ${section === "all" ? "finance" : section} findings currently need attention. ${freshnessSentence(freshness)}`,
    });
  }

  async search(query, options = {}) {
    const normalizedQuery = String(query ?? "").trim().slice(0, 120);
    const entityTypes =
      options.entityTypes ?? options.entity_types ?? null;
    const limit = bounded(options.limit, 30, 50);
    if (normalizedQuery.length < 2) {
      return {
        query: normalizedQuery,
        entity_types: entityTypes ?? [],
        groups: [],
        returned_count: 0,
        group_count: 0,
      };
    }
    const results = await this.#repository.search(
      this.#workspaceId,
      normalizedQuery,
      { entityTypes, limit },
    );
    const groups = new Map();
    for (const result of results) {
      const label = {
        transaction: "Transactions",
        account: "Accounts",
        manual_asset: "Assets",
        recurring: "Recurring",
        insight: "Insights",
      }[result.entity_type] ?? "Other";
      const items = groups.get(label) ?? [];
      items.push({
        title: result.title,
        meta: result.subtitle ?? "",
        url: searchResultUrl(result),
        icon: entityIcon(result.entity_type),
      });
      groups.set(label, items);
    }
    const groupedResults = [...groups.entries()].map(
      ([label, items]) => ({
        label,
        items,
        returned_count: items.length,
      }),
    );
    return {
      query: normalizedQuery,
      entity_types: entityTypes ?? [],
      groups: groupedResults,
      returned_count: results.length,
      group_count: groupedResults.length,
    };
  }

  async findTransactionMatches(input = {}, _actor = null) {
    const rawTransactionId =
      input.transactionId ?? input.transaction_id ?? null;
    const transactionId =
      rawTransactionId == null || rawTransactionId === ""
        ? null
        : requiredId(rawTransactionId, "transaction_id");
    const rawQuery = input.q ?? input.query ?? null;
    const query =
      rawQuery == null || rawQuery === ""
        ? null
        : boundedText(rawQuery, "q", 120);
    if (!transactionId && !query) {
      throw new TypeError("transaction_id or q is required");
    }
    const result = await this.#repository.findTransactionMatches(
      this.#workspaceId,
      {
        transactionId,
        query,
        limit: bounded(input.limit, 50, 50),
      },
    );
    if (transactionId && !result.anchor) {
      throw notFound("Posted transaction not found");
    }
    return {
      query: result.query,
      anchor: result.anchor
        ? transactionCleanupRow(result.anchor, this.#currency)
        : null,
      matches: result.matches.map((transaction) =>
        transactionCleanupRow(transaction, this.#currency),
      ),
      available_tags: (result.availableTags ?? []).map((tag) =>
        typeof tag === "string" ? tag : tag.name,
      ),
    };
  }

  async batchEditTransactions(input = {}, actor = null) {
    const transactionIds = validateTransactionIds(
      input.transactionIds ?? input.transaction_ids,
    );
    const rawChanges = input.changes;
    if (
      !rawChanges ||
      typeof rawChanges !== "object" ||
      Array.isArray(rawChanges)
    ) {
      throw new TypeError("changes must be an object");
    }
    const allowedChanges = new Set([
      "display_name",
      "displayName",
      "category_primary",
      "categoryPrimary",
      "tags",
      "excluded_from_spending",
      "excludedFromSpending",
    ]);
    if (
      Object.keys(rawChanges).some(
        (key) => !allowedChanges.has(key),
      )
    ) {
      throw new TypeError("Unsupported transaction change");
    }
    const changes = {};
    const hasDisplayName =
      Object.hasOwn(rawChanges, "display_name") ||
      Object.hasOwn(rawChanges, "displayName");
    const hasCategoryPrimary =
      Object.hasOwn(rawChanges, "category_primary") ||
      Object.hasOwn(rawChanges, "categoryPrimary");
    if (hasDisplayName) {
      const value =
        rawChanges.display_name ?? rawChanges.displayName ?? null;
      changes.displayName =
        value == null || (typeof value === "string" && !value.trim())
          ? null
          : boundedText(value, "display_name", 160);
    }
    if (hasCategoryPrimary) {
      const value =
        rawChanges.category_primary ?? rawChanges.categoryPrimary;
      changes.categoryPrimary = canonicalTransactionCategory(
        boundedText(value, "category_primary", 100),
      );
    }
    if (Object.hasOwn(rawChanges, "tags")) {
      changes.tags = validateTransactionTags(rawChanges.tags);
    }
    for (const [snakeCase, camelCase] of [
      ["excluded_from_spending", "excludedFromSpending"],
    ]) {
      if (
        !Object.hasOwn(rawChanges, snakeCase) &&
        !Object.hasOwn(rawChanges, camelCase)
      ) {
        continue;
      }
      const value = Object.hasOwn(rawChanges, snakeCase)
        ? rawChanges[snakeCase]
        : rawChanges[camelCase];
      if (typeof value !== "boolean") {
        throw new TypeError(`${snakeCase} must be a boolean`);
      }
      changes[camelCase] = value;
    }
    if (!Object.keys(changes).length) {
      throw new TypeError("At least one transaction change is required");
    }

    const updated = await this.#repository.batchEditTransactions(
      this.#workspaceId,
      {
        transactionIds,
        changes,
        userId:
          actor?.id ??
          input.userId ??
          input.user_id ??
          null,
      },
    );
    if (!updated) {
      throw notFound(
        "One or more posted transactions could not be found",
      );
    }
    if (
      Object.hasOwn(changes, "categoryPrimary") ||
      Object.hasOwn(changes, "excludedFromSpending")
    ) {
      await this.#enqueueRecompute();
    }
    return {
      updated_count: updated.updatedCount,
      transaction_ids: updated.transactionIds,
    };
  }

  async updateTransactionNote(input = {}, actor = null) {
    const transactionId = requiredId(
      input.transactionId ?? input.transaction_id,
      "transaction_id",
    );
    const expectedVersion = Number(
      input.expectedVersion ?? input.expected_note_version,
    );
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw badRequest(
        "expected_note_version must be a non-negative integer",
      );
    }
    const rawNote = input.note;
    if (rawNote !== null && typeof rawNote !== "string") {
      throw badRequest("note must be a string or null");
    }
    const note =
      rawNote == null || !rawNote.trim()
        ? null
        : boundedText(rawNote, "note", 2000);
    const updated = await this.#repository.updateTransactionNote(
      this.#workspaceId,
      {
        transactionId,
        note,
        expectedVersion,
        userId: actor?.id ?? null,
      },
    );
    if (!updated) throw notFound("Transaction not found");
    if (updated.conflict) {
      throw categoryConflict(
        "This note changed after you opened it. Reload the current note before saving.",
      );
    }
    return updated;
  }

  async listTransactionCleanupRules(input = {}) {
    const result =
      await this.#repository.listTransactionCleanupRules(
        this.#workspaceId,
        {
          includeDisabled: booleanOption(
            input.includeDisabled ?? input.include_disabled,
            true,
          ),
        },
      );
    const rows = Array.isArray(result) ? result : result?.rules ?? [];
    return {
      rules: rows.map(transactionCleanupRuleResponse),
    };
  }

  async createTransactionCleanupRule(input = {}, actor = null) {
    const mutation = transactionCleanupRuleMutation(input);
    let created;
    try {
      created =
        await this.#repository.createTransactionCleanupRule(
          this.#workspaceId,
          {
            ...mutation,
            userId: actor?.id ?? input.userId ?? input.user_id ?? null,
          },
        );
    } catch (error) {
      if (isCleanupRuleConflict(error)) {
        throw cleanupRuleConflict();
      }
      throw error;
    }
    if (created?.conflict) throw cleanupRuleConflict();
    await this.#enqueueRecompute();
    return {
      created: true,
      rule: transactionCleanupRuleResponse(created),
    };
  }

  async updateTransactionCleanupRule(input = {}, actor = null) {
    const ruleId = requiredId(
      input.ruleId ?? input.rule_id,
      "rule_id",
    );
    const mutation = transactionCleanupRuleMutation(input);
    let updated;
    try {
      updated =
        await this.#repository.updateTransactionCleanupRule(
          this.#workspaceId,
          {
            ruleId,
            ...mutation,
            userId: actor?.id ?? input.userId ?? input.user_id ?? null,
          },
        );
    } catch (error) {
      if (isCleanupRuleConflict(error)) {
        throw cleanupRuleConflict();
      }
      throw error;
    }
    if (updated?.conflict) throw cleanupRuleConflict();
    if (!updated) throw notFound("Transaction cleanup rule not found");
    await this.#enqueueRecompute();
    return {
      updated: true,
      rule: transactionCleanupRuleResponse(updated),
    };
  }

  async deleteTransactionCleanupRule(input = {}, actor = null) {
    const ruleId = requiredId(
      input.ruleId ?? input.rule_id,
      "rule_id",
    );
    const deleted =
      await this.#repository.deleteTransactionCleanupRule(
        this.#workspaceId,
        {
          ruleId,
          userId: actor?.id ?? input.userId ?? input.user_id ?? null,
        },
      );
    if (!deleted) throw notFound("Transaction cleanup rule not found");
    await this.#enqueueRecompute();
    return {
      deleted: true,
      rule_id: ruleId,
    };
  }

  async rerunTransactionCleanupRules() {
    const result =
      await this.#repository.rerunTransactionCleanupRules(
        this.#workspaceId,
      );
    await this.#enqueueRecompute();
    return {
      rerun: true,
      transaction_count: Number(result?.transaction_count ?? 0),
      rule_count: Number(result?.rule_count ?? 0),
    };
  }

  async recordLogin({ email, displayName, isAdmin = false }) {
    return this.#repository.upsertUser({
      email,
      displayName,
      isAdmin,
      workspaceId: this.#workspaceId,
    });
  }

  async updateTransactionClassification(input) {
    const transactionId =
      input.transactionId ?? input.transaction_id;
    if (!transactionId) throw new TypeError("transaction_id is required");
    const categoryDetailed =
      input.categoryDetailed ?? input.category_detailed ?? null;
    const updated =
      await this.#repository.updateTransactionClassification(
        this.#workspaceId,
        {
          transactionId,
          categoryPrimary: canonicalTransactionCategory(
            input.categoryPrimary ?? input.category_primary ?? null,
            categoryDetailed,
          ),
          categoryDetailed,
          excludedFromSpending:
            input.excludedFromSpending ??
            input.excluded_from_spending ??
            null,
          userId: input.userId ?? input.user_id ?? null,
        },
      );
    if (!updated) {
      const error = new Error("Transaction not found");
      error.statusCode = 404;
      throw error;
    }
    await this.#enqueueRecompute();
    return { updated: true, transaction_id: transactionId };
  }

  async updateAccountBalanceGroup(input) {
    const accountId = requiredId(
      input.accountId ?? input.account_id,
      "account_id",
    );
    const requestedGroup =
      input.balanceGroup ?? input.balance_group ?? null;
    const balanceGroup =
      requestedGroup == null || requestedGroup === "auto"
        ? null
        : validatedBalanceGroup(requestedGroup);
    const account = await this.#repository.updateAccountBalanceGroup(
      this.#workspaceId,
      {
        accountId,
        balanceGroup,
        userId: input.userId ?? input.user_id ?? null,
      },
    );
    if (!account) throw notFound("Account not found");
    await this.#repository.rebuildSearchDocuments(this.#workspaceId);
    return {
      updated: true,
      account_id: accountId,
      balance_group: balanceGroup,
      account,
    };
  }

  async createManualAsset(input) {
    const asset = manualAssetMutation(input, { requireIdentity: true });
    const created = await this.#repository.createManualAsset(
      this.#workspaceId,
      asset,
    );
    await this.#repository.rebuildSearchDocuments(this.#workspaceId);
    return { created: true, asset: created };
  }

  async updateManualAsset(input) {
    const assetId = requiredId(
      input.assetId ?? input.asset_id,
      "asset_id",
    );
    const changes = manualAssetMutation(input, { partial: true });
    const updated = await this.#repository.updateManualAsset(
      this.#workspaceId,
      { assetId, ...changes },
    );
    if (!updated) throw notFound("Manual asset not found");
    await this.#repository.rebuildSearchDocuments(this.#workspaceId);
    return { updated: true, asset: updated };
  }

  async archiveManualAsset(input) {
    const assetId = requiredId(
      input.assetId ?? input.asset_id,
      "asset_id",
    );
    const archived = await this.#repository.archiveManualAsset(
      this.#workspaceId,
      {
        assetId,
        userId: input.userId ?? input.user_id ?? null,
      },
    );
    if (!archived) throw notFound("Manual asset not found");
    await this.#repository.rebuildSearchDocuments(this.#workspaceId);
    return { archived: true, asset_id: assetId, asset: archived };
  }

  async getCreditScoreSummary(options = {}) {
    const now = this.#now();
    const currentOn = dateOnly(now);
    const period = ["1w", "1m", "1y", "all"].includes(options.period)
      ? options.period
      : "1y";
    const [members, sources, observations] = await Promise.all([
      optionalRepositoryCall(
        this.#repository,
        "listWorkspaceMembers",
        [],
        this.#workspaceId,
      ),
      optionalRepositoryCall(
        this.#repository,
        "listCreditScoreSources",
        [],
        this.#workspaceId,
        { includeArchived: true },
      ),
      optionalRepositoryCall(
        this.#repository,
        "listCreditScoreObservations",
        [],
        this.#workspaceId,
      ),
    ]);
    const data = buildCreditScoreSummary({
      members,
      sources,
      observations,
      currentOn,
      period,
      currentUserId:
        options.currentUserId ?? options.current_user_id ?? null,
      forMcp: options.audience === "mcp",
    });
    const contributorCount = data.household.contributor_count;
    const score = data.household.average_score;
    return this.#result({
      data,
      freshness: {
        data_as_of: now.toISOString(),
        partial: false,
        warnings: [],
      },
      warnings: data.warnings.map((warning) => warning.message),
      title: "Tracked credit scores",
      subtitle: data.period.label,
      path: `/credit?period=${data.period.name}`,
      summary:
        score == null
          ? "No manually tracked credit scores have been entered. This tracking metric is not a lender or underwriting score."
          : `The manually tracked household average is ${score} across ${contributorCount} contributor${contributorCount === 1 ? "" : "s"}. It is not a lender or underwriting score.`,
    });
  }

  async createCreditScoreSource(input, actor = null) {
    const ownerUserId = creditScoreActorId(input, actor);
    const sourceInput = creditScoreSourceMutation(input, {
      requireLabel: true,
    });
    const source = await this.#repository.createCreditScoreSource(
      this.#workspaceId,
      {
        ...sourceInput,
        ownerUserId,
      },
    );
    if (!source) throw forbidden("You are not a member of this workspace");
    return { created: true, source };
  }

  async updateCreditScoreSource(input, actor = null) {
    const ownerUserId = creditScoreActorId(input, actor);
    const sourceId = requiredId(
      input.sourceId ?? input.source_id,
      "source_id",
    );
    const changes = creditScoreSourceMutation(input);
    const source = await this.#repository.updateCreditScoreSource(
      this.#workspaceId,
      {
        sourceId,
        ownerUserId,
        ...changes,
      },
    );
    if (!source) {
      await throwCreditScoreOwnershipError(
        this.#repository,
        this.#workspaceId,
        sourceId,
        ownerUserId,
      );
    }
    return { updated: true, source };
  }

  async archiveCreditScoreSource(input, actor = null) {
    const ownerUserId = creditScoreActorId(input, actor);
    const sourceId = requiredId(
      input.sourceId ?? input.source_id,
      "source_id",
    );
    const source = await this.#repository.archiveCreditScoreSource(
      this.#workspaceId,
      {
        sourceId,
        ownerUserId,
        archivedOn: dateOnly(this.#now()),
      },
    );
    if (!source) {
      await throwCreditScoreOwnershipError(
        this.#repository,
        this.#workspaceId,
        sourceId,
        ownerUserId,
      );
    }
    return { archived: true, source_id: sourceId, source };
  }

  async upsertCreditScoreObservation(input, actor = null) {
    const ownerUserId = creditScoreActorId(input, actor);
    const sourceId = requiredId(
      input.sourceId ?? input.source_id,
      "source_id",
    );
    const observedOn = validatedIsoDate(
      input.observedOn ?? input.observed_on,
      "observed_on",
    );
    if (observedOn > dateOnly(this.#now())) {
      throw badRequest("observed_on cannot be in the future");
    }
    const score = Number(input.score);
    if (!Number.isInteger(score) || score < 300 || score > 850) {
      throw badRequest("score must be an integer between 300 and 850");
    }
    const observation =
      await this.#repository.upsertCreditScoreObservation(
        this.#workspaceId,
        {
          sourceId,
          ownerUserId,
          observedOn,
          score,
        },
      );
    if (!observation) {
      await throwCreditScoreOwnershipError(
        this.#repository,
        this.#workspaceId,
        sourceId,
        ownerUserId,
      );
    }
    return {
      updated: true,
      observation,
    };
  }

  async actOnFinding(input, actor = null) {
    const findingId = input.findingId ?? input.finding_id;
    const action = input.action;
    const reasonCode = input.reasonCode ?? input.reason_code ?? null;
    const finding = await this.#repository.getInsightFinding?.(
      this.#workspaceId,
      findingId,
    );
    if (!finding) {
      const error = new Error("Insight finding not found");
      error.statusCode = 404;
      throw error;
    }
    if (["report_incorrect", "mark_bad"].includes(action)) {
      const streamIds = finding.evidence
        .filter((entry) =>
          ["recurring", "recurring_stream"].includes(entry.entity_type),
        )
        .map((entry) => entry.entity_id);
      if (finding.type === "possible_duplicate" && streamIds.length) {
        await this.#repository.updateRecurringDuplicateState(
          this.#workspaceId,
          streamIds,
          "not_duplicate",
        );
      }
      if (reasonCode === "not_subscription") {
        await Promise.all(
          streamIds.map((streamId) =>
            this.#repository.updateRecurringClassification(
              this.#workspaceId,
              streamId,
              {
                type: "frequent_spending",
                actorId: actor?.id ?? input.user_id ?? null,
                sourceFindingId: findingId,
              },
            ),
          ),
        );
      }
    } else if (action === "confirm") {
      if (finding.type === "possible_duplicate") {
        const streamIds = finding.evidence
          .filter((entry) =>
            ["recurring", "recurring_stream"].includes(entry.entity_type),
          )
          .map((entry) => entry.entity_id);
        if (streamIds.length) {
          await this.#repository.updateRecurringDuplicateState(
            this.#workspaceId,
            streamIds,
            "confirmed",
          );
        }
      }
    } else if (
      ![
        "review",
        "recategorize",
        "mark_expected",
        "archive",
        "mark_bad",
        "dismiss",
        "ignore",
        "report_incorrect",
        "restore",
        "delete",
      ].includes(action)
    ) {
      throw new TypeError("Unsupported insight action");
    }

    if (["review", "recategorize"].includes(action)) {
      return { updated: false, finding_id: findingId, action };
    }

    const updated =
      await this.#repository.transitionInsightFinding?.(
        this.#workspaceId,
        findingId,
        {
          action,
          actorId: actor?.id ?? input.user_id ?? null,
          ...(reasonCode ? { reasonCode } : {}),
        },
      );
    if (!updated) {
      const error = new Error("Insight finding not found");
      error.statusCode = 404;
      throw error;
    }
    if (action === "restore") {
      await this.#repository.clearRecurringClassificationFromFinding?.(
        this.#workspaceId,
        findingId,
      );
    }
    await this.#repository.rebuildSearchDocuments?.(this.#workspaceId);
    return {
      updated: true,
      deleted: action === "delete",
      finding_id: findingId,
      finding_key: finding.finding_key,
      state: action === "delete" ? "deleted" : updated.state,
      action,
    };
  }

  async batchActOnFindings(input = {}, actor = null) {
    const rawFindingIds =
      input.findingIds ?? input.finding_ids;
    if (
      !Array.isArray(rawFindingIds) ||
      rawFindingIds.length < 1 ||
      rawFindingIds.length > 100
    ) {
      throw badRequest(
        "finding_ids must contain between 1 and 100 insight IDs",
      );
    }
    const findingIds = rawFindingIds.map((findingId) =>
      requiredId(findingId, "finding_id"),
    );
    if (new Set(findingIds).size !== findingIds.length) {
      throw badRequest("finding_ids must be unique");
    }

    const requestedAction = input.action;
    const action =
      requestedAction === "dismiss"
        ? "ignore"
        : requestedAction === "mark_bad"
          ? "report_incorrect"
          : requestedAction;
    if (
      ![
        "archive",
        "ignore",
        "report_incorrect",
        "restore",
      ].includes(action)
    ) {
      throw badRequest("This bulk insight action is not supported");
    }

    let reasonCode =
      input.reasonCode ?? input.reason_code ?? null;
    if (
      requestedAction === "mark_bad" &&
      reasonCode == null
    ) {
      reasonCode = "other_false_positive";
    }
    if (
      action === "report_incorrect" &&
      !INSIGHT_INCORRECT_REASON_CODES.has(reasonCode)
    ) {
      throw badRequest(
        "Choose a supported incorrect-insight reason",
      );
    }
    if (action !== "report_incorrect" && reasonCode != null) {
      throw badRequest(
        "reason_code is only supported for incorrect insights",
      );
    }

    const result =
      await this.#repository.batchTransitionInsightFindings(
        this.#workspaceId,
        findingIds,
        {
          action,
          actorId: actor?.id ?? input.user_id ?? null,
          ...(reasonCode ? { reasonCode } : {}),
        },
      );
    if (!result) {
      throw notFound(
        "One or more insight findings could not be found",
      );
    }
    if (result.incompatibleFindingIds?.length) {
      throw badRequest(
        "Not a subscription only applies to subscription insights with recurring evidence",
      );
    }

    await this.#repository.rebuildSearchDocuments?.(
      this.#workspaceId,
    );
    return {
      updated: true,
      action,
      state:
        {
          archive: "archived",
          ignore: "dismissed",
          report_incorrect: "bad",
          restore: "active",
        }[action],
      updated_count: result.updatedFindings.length,
      finding_ids: findingIds,
      ...(reasonCode ? { reason_code: reasonCode } : {}),
    };
  }

  async updateRecurringClassification(input, actor = null) {
    const streamId = requiredId(
      input.streamId ?? input.stream_id,
      "stream_id",
    );
    const type = input.type;
    if (
      !["subscription", "bill", "frequent_spending"].includes(type)
    ) {
      throw new TypeError("Invalid recurring classification");
    }
    const updated =
      await this.#repository.updateRecurringClassification?.(
        this.#workspaceId,
        streamId,
        {
          type,
          actorId: actor?.id ?? input.user_id ?? null,
          sourceFindingId: null,
        },
      );
    if (!updated) throw notFound("Recurring stream not found");
    await this.#repository.rebuildSearchDocuments?.(this.#workspaceId);
    return {
      updated: true,
      stream_id: streamId,
      type: updated.stream_type,
    };
  }

  async updateInsightRule(input) {
    const ruleId = input.ruleId ?? input.rule_id;
    if (!ruleId) throw new TypeError("rule_id is required");
    const definition = insightRuleDefinition(ruleId);
    const settings =
      input.settings === undefined
        ? undefined
        : validateRuleSettings(ruleId, input.settings);
    let updated;
    if (ruleId === definition.storageId) {
      updated = await this.#repository.updateInsightRuleById(
        this.#workspaceId,
        {
          ruleId,
          enabled: input.enabled,
          settings,
        },
      );
    } else {
      const existing = await this.#repository.getInsightRules(
        this.#workspaceId,
      );
      updated = await this.#repository.updateInsightRule(
        this.#workspaceId,
        {
          family: definition.family,
          ruleKey: definition.ruleKey,
          enabled:
            input.enabled ??
            existing[definition.publicId]?.enabled ??
            true,
          settings,
        },
      );
    }
    if (!updated) {
      const error = new Error("Insight rule not found");
      error.statusCode = 404;
      throw error;
    }
    await this.#enqueueRecompute();
    return { updated: true, rule: updated };
  }

  async getInsightStatus() {
    const freshness = await this.#repository.getDataFreshness(
      this.#workspaceId,
    );
    return this.#buildInsightStatus(freshness);
  }

  async forceRunInsights(_input = {}, actor = null) {
    const status = await this.getInsightStatus();
    if (status.state === "paused") {
      const reason =
        status.pause_reasons[0]?.message ??
        "Connected finance data is not fresh enough.";
      throw insightRunConflict(`Insights are paused: ${reason}`);
    }
    if (["running", "queued"].includes(status.state)) {
      return {
        queued: false,
        already_in_progress: true,
        status,
      };
    }
    if (!this.#jobQueue) {
      const error = new Error("The insights worker is unavailable.");
      error.statusCode = 503;
      error.expose = true;
      throw error;
    }
    const job = await this.#jobQueue.enqueue(
      "finance.detect_recurring",
      {
        workspaceId: this.#workspaceId,
        source: "manual",
        requestedBy: actor?.id ?? null,
      },
      { dedupeKey: this.#workspaceId, runAt: this.#now() },
    );
    return {
      queued: true,
      job_id: job.id,
      status: "queued",
    };
  }

  async clearInsights() {
    if (
      typeof this.#repository.clearInsightOutput !== "function"
    ) {
      const error = new Error("Insight storage is unavailable.");
      error.statusCode = 503;
      error.expose = true;
      throw error;
    }
    const deleted = await this.#repository.clearInsightOutput(
      this.#workspaceId,
    );
    return {
      cleared: true,
      ...deleted,
      feedback_preserved: true,
      recurring_corrections_preserved: true,
    };
  }

  async #buildInsightStatus(freshness) {
    const [storage, jobs] = await Promise.all([
      optionalRepositoryCall(
        this.#repository,
        "getInsightStorageSummary",
        {
          active_count: 0,
          archived_count: 0,
          total_count: 0,
          last_findings_generated_at: null,
        },
        this.#workspaceId,
      ),
      typeof this.#jobQueue?.getInsightJobStatus === "function"
        ? this.#jobQueue.getInsightJobStatus(this.#workspaceId)
        : {
            current: null,
            latest: null,
            nextScheduledAt: null,
          },
    ]);
    const current = jobs.current ?? null;
    const latest = jobs.latest ?? null;
    let state = "never_run";
    if (freshness.partial) {
      state = "paused";
    } else if (current?.status === "running") {
      state = "running";
    } else if (current?.status === "queued") {
      state = "queued";
    } else if (latest?.status === "failed") {
      state = "failed";
    } else if (
      latest?.status === "succeeded" ||
      storage.last_findings_generated_at ||
      storage.total_count > 0
    ) {
      state = "ready";
    }
    return {
      state,
      can_run:
        !freshness.partial &&
        !["running", "queued"].includes(state),
      pause_reasons: freshness.warnings ?? [],
      freshness_data_as_of: freshness.data_as_of ?? null,
      current_job_type: current?.type ?? null,
      last_run_at: isoDateTime(latest?.updatedAt),
      last_run_status: latest?.status ?? null,
      last_error: latest?.lastError ?? null,
      next_scheduled_at: isoDateTime(jobs.nextScheduledAt),
      last_findings_generated_at:
        storage.last_findings_generated_at ?? null,
      active_count: Number(storage.active_count ?? 0),
      archived_count: Number(storage.archived_count ?? 0),
      total_count: Number(storage.total_count ?? 0),
    };
  }

  async listSpendingCategories(input = {}) {
    const categories = await this.#repository.listSpendingCategories(
      this.#workspaceId,
      {
        includeMerged: booleanOption(
          input.includeMerged ?? input.include_merged,
          false,
        ),
      },
    );
    return { categories };
  }

  async createSpendingCategory(input = {}, actor = null) {
    const name = boundedText(input.name, "name", 100);
    const classification = spendingClassification(
      input.classification ?? "flexible",
    );
    const parentCategoryId =
      input.parentCategoryId ?? input.parent_category_id ?? null;
    let category;
    try {
      category = await this.#repository.createSpendingCategory(
        this.#workspaceId,
        {
          name,
          classification,
          parentCategoryId:
            parentCategoryId == null
              ? null
              : requiredId(parentCategoryId, "parent_category_id"),
          userId: actor?.id ?? input.userId ?? input.user_id ?? null,
        },
      );
    } catch (error) {
      if (
        error?.code === "CATEGORY_NAME_CONFLICT" ||
        error?.code === "23505"
      ) {
        throw categoryConflict(
          "That category name or alias already exists. Merge it instead.",
        );
      }
      if (error?.code === "CATEGORY_PARENT_NOT_FOUND") {
        throw notFound("Parent category not found");
      }
      throw error;
    }
    await this.#enqueueRecompute();
    return { created: true, category };
  }

  async updateSpendingCategory(input = {}, actor = null) {
    const categoryId = requiredId(
      input.categoryId ?? input.category_id,
      "category_id",
    );
    const hasName = Object.hasOwn(input, "name");
    const hasClassification = Object.hasOwn(input, "classification");
    const hasParent =
      Object.hasOwn(input, "parentCategoryId") ||
      Object.hasOwn(input, "parent_category_id");
    if (!hasName && !hasClassification && !hasParent) {
      throw badRequest("At least one category field is required");
    }
    const expectedVersion = positiveVersion(
      input.expectedVersion ?? input.expected_version,
      "expected_version",
    );
    const updated = await this.#repository.updateSpendingCategory(
      this.#workspaceId,
      {
        categoryId,
        name: hasName ? boundedText(input.name, "name", 100) : undefined,
        classification: hasClassification
          ? spendingClassification(input.classification)
          : undefined,
        parentCategoryId: hasParent
          ? optionalCategoryId(
              input.parentCategoryId ?? input.parent_category_id,
              "parent_category_id",
            )
          : undefined,
        expectedVersion,
        userId: actor?.id ?? input.userId ?? input.user_id ?? null,
      },
    );
    if (!updated) throw notFound("Category not found");
    if (updated.stale) {
      throw categoryConflict(
        "The category changed before this edit. Refresh and try again.",
      );
    }
    if (updated.conflict) {
      throw categoryConflict(
        "That category name or alias already exists. Merge it instead.",
      );
    }
    if (updated.invalidParent) {
      throw badRequest(
        "A category cannot be nested under itself, a descendant, or a merged category.",
      );
    }
    if (updated.invalidBudgetHierarchy) {
      throw badRequest(
        "That category change would leave a child budget without a valid parent envelope or exceed its parent amount.",
      );
    }
    if (updated.protected) {
      throw badRequest(
        "Other is permanent and cannot be edited.",
      );
    }
    await this.#enqueueRecompute();
    return { updated: true, category: updated };
  }

  async mergeSpendingCategories(input = {}, actor = null) {
    const rawSourceIds =
      input.sourceCategoryIds ?? input.source_category_ids;
    if (
      !Array.isArray(rawSourceIds) ||
      rawSourceIds.length < 1 ||
      rawSourceIds.length > 100
    ) {
      throw badRequest(
        "source_category_ids must contain between 1 and 100 categories",
      );
    }
    const sourceCategoryIds = [
      ...new Set(
        rawSourceIds.map((id) => requiredId(id, "source_category_id")),
      ),
    ];
    if (sourceCategoryIds.length !== rawSourceIds.length) {
      throw badRequest("source_category_ids must be unique");
    }
    const rawDestination = input.destination;
    if (
      !rawDestination ||
      typeof rawDestination !== "object" ||
      Array.isArray(rawDestination)
    ) {
      throw badRequest("destination is required");
    }
    const destinationCategoryId =
      rawDestination.categoryId ??
      rawDestination.category_id ??
      null;
    const newDestination = destinationCategoryId
      ? null
      : {
          name: boundedText(rawDestination.name, "destination.name", 100),
          classification: spendingClassification(
            rawDestination.classification,
          ),
          parentCategoryId: optionalCategoryId(
            rawDestination.parentCategoryId ??
              rawDestination.parent_category_id ??
              null,
            "destination.parent_category_id",
          ),
        };
    const rawVersions =
      input.expectedVersions ?? input.expected_versions;
    if (
      !rawVersions ||
      typeof rawVersions !== "object" ||
      Array.isArray(rawVersions)
    ) {
      throw badRequest("expected_versions is required");
    }
    const requiredVersionIds = [
      ...sourceCategoryIds,
      ...(destinationCategoryId ? [destinationCategoryId] : []),
    ];
    const expectedVersions = Object.fromEntries(
      requiredVersionIds.map((id) => [
        id,
        positiveVersion(rawVersions[id], `expected_versions.${id}`),
      ]),
    );
    const merged = await this.#repository.mergeSpendingCategories(
      this.#workspaceId,
      {
        sourceCategoryIds,
        destinationCategoryId: destinationCategoryId
          ? requiredId(destinationCategoryId, "destination.category_id")
          : null,
        destination: newDestination,
        expectedVersions,
        userId: actor?.id ?? input.userId ?? input.user_id ?? null,
      },
    );
    if (!merged) throw notFound("One or more categories were not found");
    if (merged.stale) {
      throw categoryConflict(
        "A category changed before the merge. Refresh and try again.",
      );
    }
    if (merged.conflict) {
      throw categoryConflict(
        "The destination name or alias already belongs to another category.",
      );
    }
    if (merged.selfMerge) {
      throw badRequest("A category cannot be merged into itself");
    }
    if (merged.invalidParent) {
      throw badRequest("The destination parent category is invalid");
    }
    if (merged.invalidBudgetHierarchy) {
      throw badRequest(
        "That merge would leave a child budget without a valid parent envelope or exceed its parent amount.",
      );
    }
    if (merged.protected) {
      throw badRequest(
        "Other cannot be edited, merged, or used as a merge destination.",
      );
    }
    await this.#enqueueRecompute();
    return { merged: true, category: merged };
  }

  async deleteSpendingCategory(input = {}, actor = null) {
    const categoryId = requiredId(
      input.categoryId ?? input.category_id,
      "category_id",
    );
    const expectedVersion = positiveVersion(
      input.expectedVersion ?? input.expected_version,
      "expected_version",
    );
    const deleted = await this.#repository.deleteSpendingCategory(
      this.#workspaceId,
      {
        categoryId,
        expectedVersion,
        userId: actor?.id ?? input.userId ?? input.user_id ?? null,
      },
    );
    if (!deleted) throw notFound("Category not found");
    if (deleted.stale) {
      throw categoryConflict(
        "The category changed before deletion. Refresh and try again.",
      );
    }
    if (deleted.protected) {
      throw badRequest("Other is permanent and cannot be deleted.");
    }
    if (deleted.conflict) {
      throw categoryConflict(
        "A child category conflicts with its promoted top-level path.",
      );
    }
    if (deleted.invalidParent) {
      throw badRequest("The category tree could not be preserved.");
    }
    if (deleted.invalidBudgetHierarchy) {
      throw badRequest(
        "Remove or rebalance the affected budgets before deleting this category.",
      );
    }
    await this.#enqueueRecompute();
    return {
      deleted: true,
      category_id: categoryId,
      moved_to_category: deleted,
    };
  }

  async splitSpendingCategory(input = {}, actor = null) {
    const categoryId = requiredId(
      input.categoryId ?? input.category_id,
      "category_id",
    );
    const expectedVersion = positiveVersion(
      input.expectedVersion ?? input.expected_version,
      "expected_version",
    );
    const split = await this.#repository.splitSpendingCategory(
      this.#workspaceId,
      {
        categoryId,
        expectedVersion,
        userId: actor?.id ?? input.userId ?? input.user_id ?? null,
      },
    );
    if (!split) throw notFound("Category not found");
    if (split.notMerged) {
      throw badRequest("Only a merged category can be split out");
    }
    if (split.stale) {
      throw categoryConflict(
        "The category changed before this split. Refresh and try again.",
      );
    }
    if (split.conflict) {
      throw categoryConflict(
        "Rename the destination before splitting this category out.",
      );
    }
    await this.#enqueueRecompute();
    return { split: true, category: split };
  }

  async getPageData(view, request = {}) {
    const query = request.query ?? {};
    const freshness = await this.#repository.getDataFreshness(
      this.#workspaceId,
    );
    const base = {
      freshness: freshnessLabel(freshness),
    };
    if (view === "settings") {
      const [
        items,
        rules,
        observedCategories,
        spendingCategories,
        rawManualAssets,
        manualAssetValuations,
        accounts,
        transactionTagRows,
        cleanupRuleResult,
        insightStatus,
      ] = await Promise.all([
        typeof this.#repository.listFinanceConnections === "function"
          ? this.#repository.listFinanceConnections(this.#workspaceId)
          : this.#repository.listPlaidItems(this.#workspaceId),
        this.#repository.getInsightRules(this.#workspaceId),
        this.#repository.listTransactionCategories(this.#workspaceId),
        optionalRepositoryCall(
          this.#repository,
          "listSpendingCategories",
          [],
          this.#workspaceId,
          { includeMerged: true },
        ),
        optionalRepositoryCall(
          this.#repository,
          "listManualAssets",
          [],
          this.#workspaceId,
        ),
        optionalRepositoryCall(
          this.#repository,
          "getManualAssetValuations",
          [],
          this.#workspaceId,
        ),
        this.listAccounts({ includeClosed: true, limit: 100 }),
        optionalRepositoryCall(
          this.#repository,
          "listTransactionTags",
          [],
          this.#workspaceId,
        ),
        this.listTransactionCleanupRules(),
        this.#buildInsightStatus(freshness),
      ]);
      const manualAssets = manualAssetsAt(
        rawManualAssets,
        manualAssetValuations,
        this.#now(),
      );
      const transactionTags = transactionTagRows.map((tag) =>
        typeof tag === "string" ? tag : tag.name,
      );
      const transactionCleanup =
        query.transaction || query.cleanup_q
          ? await this.findTransactionMatches({
              transactionId: query.transaction,
              q: query.cleanup_q,
              limit: 50,
            })
          : null;
      return {
        ...base,
        connections: items,
        rules,
        fixedCategories:
          spendingCategories.length
            ? spendingCategories
                .filter(
                  (category) =>
                    category.status !== "merged" &&
                    category.classification === "fixed",
                )
                .map((category) => category.path)
            : rules["weekly.fixed_categories"]?.categories ?? [],
        observedCategories,
        spendingCategories:
          spendingCategories.length
            ? spendingCategories
            : transactionCategoryOptions(observedCategories).map(
                (category, index) => ({
                  id: `legacy-category-${index}`,
                  name: category.label,
                  path: category.label,
                  depth: 0,
                  classification: (
                    rules["weekly.fixed_categories"]?.categories ?? []
                  ).includes(category.value)
                    ? "fixed"
                    : "flexible",
                  parent_category_id: null,
                  version: 1,
                  transaction_count: 0,
                  budget_line_count: 0,
                  aliases: [],
                }),
              ),
        manualAssets: manualAssets.map(webManualAsset),
        accounts: flattenAccountGroups(
          accounts.data.groups,
        ).map(webAccount),
        transactionTags,
        transactionRules: cleanupRuleResult.rules,
        transactionCleanup,
        insightStatus,
      };
    }
    if (view === "transactions") {
      const splitAware =
        typeof this.#repository.listTransactionSplits === "function";
      const requestedCategory =
        query.category_id ?? query.category ?? null;
      const periodSelection = resolveTransactionPeriod(query, this.#now());
      const periods = periodSelection.period;
      const sort = normalizeTransactionSort(query.sort);
      const duration = daysBetween(
        periods.start_on,
        periods.end_on,
      );
      const previousPeriod = {
        start_on: shiftDateOnly(periods.start_on, -duration),
        end_on: periods.start_on,
      };
      const [
        page,
        analysisTransactions,
        analysisSplits,
        accounts,
        observedCategories,
        categoryDefinitions,
        selectedTransaction,
      ] =
        await Promise.all([
          this.listTransactions({
            startOn: periods.start_on,
            endOn: periods.end_on,
            search: query.q,
            category: requestedCategory,
            accountId: query.account,
            cursor: query.cursor,
            sort,
            limit: 100,
          }),
          this.#repository.getTransactionsForPeriod(
            this.#workspaceId,
            {
              startOn: previousPeriod.start_on,
              endOn: periods.end_on,
              accountId: query.account,
              category: splitAware ? null : requestedCategory,
              search: query.q,
              includePending: true,
            },
          ),
          optionalRepositoryCall(
            this.#repository,
            "listTransactionSplits",
            [],
            this.#workspaceId,
            {
              startOn: previousPeriod.start_on,
              endOn: periods.end_on,
            },
          ),
          this.listAccounts({ limit: 100 }),
          this.#repository.listTransactionCategories(this.#workspaceId),
          optionalRepositoryCall(
            this.#repository,
            "listSpendingCategories",
            [],
            this.#workspaceId,
          ),
          query.transaction
            ? this.#repository.getTransaction(
                this.#workspaceId,
                query.transaction,
              )
            : null,
        ]);
      const analysisCategory =
        categoryDefinitions.find(
          (category) => category.id === requestedCategory,
        )?.path ?? requestedCategory;
      const expandedAnalysisTransactions =
        expandAndFilterTransactions(
          analysisTransactions,
          analysisSplits,
          splitAware ? analysisCategory : null,
        );
      const cashFlow = buildCashFlow({
        transactions: expandedAnalysisTransactions,
        period: periods,
        interval: query.period === "90" ? "week" : "day",
        currency: this.#currency,
      });
      const spendingByGroup = Object.fromEntries(
        ["category", "merchant"].map((groupBy) => [
          groupBy,
          buildSpendingSummary({
            transactions: expandedAnalysisTransactions,
            currentPeriod: periods,
            previousPeriod,
            groupBy,
            segmentLimit: 8,
            includeSegmentDetails: true,
            currency: this.#currency,
          }),
        ]),
      );
      const analyticsGroup = normalizeAnalyticsGroup(
        query.analytics_group,
      );
      const selectedLedgerTransaction = query.transaction
        ? page.data.transactions.find(
            (transaction) => transaction.id === query.transaction,
          )
        : null;
      return {
        ...base,
        transactions: page.data.transactions.map(webTransaction),
        transactionPageInfo: page.data.page_info,
        overview: webOverviewFromCashFlow(cashFlow),
        spendingDetails: webSpendingDetails(
          spendingByGroup,
          categoryDefinitions,
          {
            activeGrouping: analyticsGroup,
            activeSegmentKey: query.analytics_segment,
          },
        ),
        accounts: flattenAccountGroups(accounts.data.groups).map(webAccount),
        categories: categoryDefinitions.length
          ? categoryDefinitions.map((category) => ({
              value: category.id,
              label: category.path,
            }))
          : transactionCategoryOptions(observedCategories),
        transactionPeriod: periodSelection.name,
        transactionSort: sort,
        selectedTransaction: selectedLedgerTransaction
          ? webTransaction(selectedLedgerTransaction)
          : selectedTransaction
            ? webTransaction(transactionCard(selectedTransaction))
            : null,
      };
    }
    if (view === "recurring") {
      const [overview, recurring] = await Promise.all([
        this.getFinanceOverview(),
        this.listRecurringPayments({
          limit: 100,
          includeFrequentSpending: true,
        }),
      ]);
      const streams = recurring.data.recurring_payments;
      const activeStreams = streams.filter((stream) =>
        ["active", "resumed", "irregular"].includes(stream.status),
      );
      const selectedRecurring = streams.find(
        (stream) =>
          stream.id === (query.item ?? query.stream),
      );
      const selectedTransactions = selectedRecurring
        ? await optionalRepositoryCall(
            this.#repository,
            "getTransactionsByIds",
            [],
            this.#workspaceId,
            selectedRecurring.transaction_ids ?? [],
          )
        : [];
      return {
        ...base,
        overview: webOverview(overview.data),
        subscriptions: activeStreams
          .filter((stream) => stream.type === "subscription")
          .map(webRecurring),
        bills: activeStreams
          .filter((stream) => stream.type === "bill")
          .map(webRecurring),
        frequentSpending: activeStreams
          .filter((stream) => stream.type === "frequent_spending")
          .map(webRecurring),
        selectedRecurring: selectedRecurring
          ? {
              ...webRecurring(selectedRecurring),
              detectedType: selectedRecurring.detected_type,
              typeOverride: selectedRecurring.type_override,
              classificationSignals:
                selectedRecurring.classification_signals ?? {},
              transactions: selectedTransactions
                .sort((left, right) =>
                  right.posted_on.localeCompare(left.posted_on),
                )
                .slice(0, 8)
                .map((transaction) =>
                  webTransaction(transactionCard(transaction)),
                ),
            }
          : null,
        selectedRecurringQueryKey:
          query.item != null
            ? "item"
            : query.stream != null
              ? "stream"
              : "item",
      };
    }
    if (view === "credit") {
      const requestedPeriod = query.period ?? query.score_period;
      const period = ["1w", "1m", "1y", "all"].includes(requestedPeriod)
        ? requestedPeriod
        : "1m";
      let creditScoresUnavailable = false;
      const [credit, creditScores] = await Promise.all([
        this.getCreditSummary({
          period,
          requestId: request.id ?? null,
        }),
        this.getCreditScoreSummary({
          period,
          currentUserId: request.user?.id ?? null,
        }).catch((error) => {
          creditScoresUnavailable = true;
          log("error", "Tracked credit score refresh failed", {
            requestId: request.id ?? null,
            error: {
              name: error?.name,
              message: error?.message,
            },
          });
          return {
            data: unavailableCreditScoreData({
              period,
              currentOn: dateOnly(this.#now()),
            }),
          };
        }),
      ]);
      return {
        ...base,
        creditData: credit.data,
        creditWarnings: credit.warnings,
        creditPartial: credit.partial || creditScoresUnavailable,
        creditScoreData: creditScores.data,
        creditScorePresets: CREDIT_SCORE_PRESETS,
      };
    }
    if (view === "portfolio") {
      const [overview, portfolio] = await Promise.all([
        this.getFinanceOverview(),
        this.getPortfolioSummary({
          period: query.period ?? "1m",
          scope: query.scope ?? "all",
        }),
      ]);
      const webHoldings = portfolio.data.holdings.map(webHolding);
      return {
        ...base,
        overview: webOverview(overview.data),
        holdings: webHoldings,
        allocation: webHoldings
          .filter((holding) => holding.value.amount_minor > 0)
          .map((holding) => ({
            label: holding.symbol,
            value: holding.allocation,
          })),
        portfolioSeries: portfolio.data.series.map(
          (point) => point.value.amount_minor,
        ),
        portfolioData: portfolio.data,
        selectedHolding: portfolio.data.holdings
          .filter(
            (holding) =>
              (holding.ticker_symbol ?? holding.name) === query.holding,
          )
          .map(webHolding)[0] ?? null,
      };
    }
    if (view === "accounts") {
      const [overview, accounts] = await Promise.all([
        this.getFinanceOverview(),
        this.listAccounts({ includeClosed: true, limit: 100 }),
      ]);
      return {
        ...base,
        overview: webOverview(overview.data),
        accounts: flattenAccountGroups(accounts.data.groups).map(webAccount),
        manualAssets: accounts.data.manual_assets.map(webManualAsset),
      };
    }
    if (view === "insights") {
      const insightView = query.view === "archive" ? "archive" : "active";
      const insights = await this.#getFinanceInsights(
        {
          section: "all",
          limitPerSection: 25,
          view: insightView,
        },
        { pageDelivery: true },
      );
      const mappedInsights = webInsights(insights.data);
      return {
        ...base,
        insights: mappedInsights,
        insightsStale: insights.partial,
        insightView,
        insightData: {
          ...insights.data,
          view: insights.data.view ?? insightView,
          partial: insights.partial,
          warnings: insights.warnings,
          dataAsOf: insights.data_as_of,
        },
        selectedInsight:
          Object.values(mappedInsights)
            .flat()
            .find((finding) => finding.id === query.finding) ?? null,
      };
    }
    const dashboardPeriod = dashboardHistoryPeriod(
      query.period,
      this.#now(),
    );
    const previousMonthToDate = priorMonthToDatePeriod(this.#now());
    const [
      overview,
      spending,
      insights,
      transactions,
      history,
      categoryDefinitions,
    ] =
      await Promise.all([
        this.getFinanceOverview(),
        this.getSpendingSummary({
          segmentLimit: 7,
          previousStartOn: previousMonthToDate.start_on,
          previousEndOn: previousMonthToDate.end_on,
        }),
        this.getFinanceInsights({ section: "all", limitPerSection: 10 }),
        this.listTransactions({ limit: 6 }),
        this.getNetWorthHistory({
          startOn: dashboardPeriod.start_on,
          endOn: dashboardPeriod.end_on,
          interval: dashboardPeriod.interval,
          limit: dashboardPeriod.limit,
          includeComponents: true,
        }),
        optionalRepositoryCall(
          this.#repository,
          "listSpendingCategories",
          [],
          this.#workspaceId,
        ),
      ]);
    const webOverviewData = webOverview(overview.data);
    const currentWealthPoint = {
      timestamp: dateOnly(this.#now()),
      cash_balance: overview.data.cash_balance,
      short_term_worth: overview.data.short_term_worth,
      retirement_assets: overview.data.retirement_assets,
      net_worth: overview.data.net_worth,
    };
    const dashboardWealthHistory = [...history.data.series];
    if (
      dashboardWealthHistory.at(-1)?.timestamp ===
      currentWealthPoint.timestamp
    ) {
      dashboardWealthHistory[dashboardWealthHistory.length - 1] =
        currentWealthPoint;
    } else {
      dashboardWealthHistory.push(currentWealthPoint);
    }
    const displayedWealthHistory = sampleSeries(
      dashboardWealthHistory,
      80,
    );
    const firstHistoryTimestamp =
      displayedWealthHistory.length > 1
        ? displayedWealthHistory[0].timestamp
        : null;
    const comparisonLabel =
      firstHistoryTimestamp &&
      (dashboardPeriod.name === "all" ||
        firstHistoryTimestamp > dashboardPeriod.start_on)
        ? `since ${formatShortDate(firstHistoryTimestamp, { year: true })}`
        : dashboardPeriod.comparison_label;
    if (displayedWealthHistory.length > 1) {
      webOverviewData.netWorthChange = money(
        displayedWealthHistory.at(-1).net_worth.amount_minor -
          displayedWealthHistory[0].net_worth.amount_minor,
        history.data.currency,
      );
    }
    return {
      ...base,
      hasAccounts:
        overview.data.account_count > 0 ||
        overview.data.manual_asset_count > 0,
      overview: webOverviewData,
      categories: spending.data.segments.map((segment, index) =>
        webCategory(segment, index, categoryDefinitions),
      ),
      insights: insights.partial
        ? { weekly: [], investments: [], subscriptions: [] }
        : webInsights(insights.data),
      insightsStale: insights.partial,
      transactions: transactions.data.transactions.map(webTransaction),
      netWorthSeries: displayedWealthHistory.map(
        (point) => point.net_worth.amount_minor,
      ),
      netWorthLabels: displayedWealthHistory.map(
        (point) => point.timestamp,
      ),
      wealthSeries: {
        cash: displayedWealthHistory.map(
          (point) => point.cash_balance.amount_minor,
        ),
        short_term: displayedWealthHistory.map(
          (point) => point.short_term_worth.amount_minor,
        ),
        retirement: displayedWealthHistory.map(
          (point) => point.retirement_assets.amount_minor,
        ),
        net_worth: displayedWealthHistory.map(
          (point) => point.net_worth.amount_minor,
        ),
      },
      wealthLabels: displayedWealthHistory.map(
        (point) => point.timestamp,
      ),
      dashboardPeriod: {
        name: dashboardPeriod.name,
        label: dashboardPeriod.label,
        comparison_label: comparisonLabel,
        start_on: dashboardPeriod.start_on,
        end_on: dashboardPeriod.end_on,
      },
      spendingTrendLabel: spendingTrendLabel(spending.data.trend),
      spendingMoMLabel: spendingMonthOverMonthLabel(
        spending.data.trend,
      ),
      spendingTrendDirection: spending.data.trend.direction,
      currentPeriodLabel: formatMonth(this.#now()),
    };
  }

  async #enqueueRecompute() {
    if (!this.#jobQueue) return;
    await this.#jobQueue.enqueue(
      "finance.detect_recurring",
      { workspaceId: this.#workspaceId },
      { dedupeKey: this.#workspaceId },
    );
  }

  #result({
    data,
    freshness,
    title,
    subtitle,
    path,
    summary,
    warnings = [],
  }) {
    return {
      data,
      data_as_of: freshness.data_as_of,
      partial: freshness.partial,
      warnings: [...(freshness.warnings ?? []), ...warnings],
      display: {
        title,
        subtitle,
        web_url: `${this.#baseUrl}${path}`,
      },
      summary,
    };
  }
}

function accountCard(account) {
  const balanceGroup = inferBalanceGroup(account);
  const credit =
    balanceGroup === "credit_card"
      ? creditAccountCardFields(account)
      : {};
  return {
    id: account.id,
    institution_id: account.institution_id,
    institution_name: account.institution_name,
    name: account.name,
    mask: account.mask,
    type: account.type,
    subtype: account.subtype,
    balance_group: balanceGroup,
    balance_group_override: account.balance_group_override ?? null,
    balance_group_source:
      account.balance_group_override == null ? "inferred" : "override",
    current_balance:
      account.current_balance_minor == null
        ? null
        : money(account.current_balance_minor, account.currency_code),
    available_balance:
      account.available_balance_minor == null
        ? null
        : money(account.available_balance_minor, account.currency_code),
    is_liability: account.is_liability,
    active: account.active,
    provider: account.provider,
    ingestion_method: account.ingestion_method,
    ...credit,
    freshness: {
      synced_at: account.last_synced_at,
      posted_through_on: account.imported_through_on ?? null,
      status: account.last_synced_at ? "fresh" : "stale",
    },
  };
}

function creditAccountCardFields(account) {
  const balance = account.current_balance_minor;
  const limit = account.credit_limit_minor;
  const balanceOwed =
    balance == null ? null : Math.max(balance, 0);
  const covered =
    balanceOwed != null && limit != null && limit > 0;
  return {
    balance_owed:
      balanceOwed == null
        ? null
        : money(balanceOwed, account.currency_code),
    credit_limit:
      limit == null ? null : money(limit, account.currency_code),
    available_credit:
      covered
        ? money(limit - balanceOwed, account.currency_code)
        : null,
    utilization_basis_points:
      covered
        ? Math.round((balanceOwed / limit) * 10_000)
        : null,
    over_limit: covered && balanceOwed > limit,
  };
}

function transactionCard(transaction) {
  const displayName =
    transaction.display_name ??
    transaction.merchant_name ??
    transaction.name;
  return {
    id: transaction.id,
    provider_transaction_id:
      transaction.provider_transaction_id ?? null,
    date: transaction.posted_on,
    authorized_at: transaction.authorized_at,
    authorized_on: transaction.authorized_on,
    posted_at: transaction.posted_at,
    display_name: displayName,
    merchant: displayName,
    raw_merchant: transaction.merchant_name ?? null,
    raw_name: transaction.name,
    description: transaction.name,
    note: transaction.note ?? null,
    note_version: Number(transaction.note_version ?? 0),
    note_updated_by: transaction.note_updated_by ?? null,
    note_updated_at: transaction.note_updated_at ?? null,
    tags: Array.isArray(transaction.tags) ? transaction.tags : [],
    category_id: transaction.category_id ?? null,
    category: transaction.category_primary,
    detailed_category: transaction.category_detailed,
    original_category:
      transaction.original_category_primary ??
      transaction.category_primary ??
      null,
    original_detailed_category:
      transaction.original_category_detailed ??
      transaction.category_detailed ??
      null,
    account: {
      id: transaction.account_id,
      name: transaction.account_name,
      mask: transaction.account_mask,
      institution: transaction.institution_name,
    },
    amount: money(transaction.amount_minor, transaction.currency_code),
    provider_amount: money(
      transaction.provider_amount_minor ?? transaction.amount_minor,
      transaction.currency_code,
    ),
    is_split_category_projection: Boolean(
      transaction.is_split_category_projection,
    ),
    split_category_line_count: Number(
      transaction.split_category_line_count ?? 0,
    ),
    pending: transaction.pending,
    cardholder_name: transaction.cardholder_name ?? null,
    source_transaction_type:
      transaction.source_transaction_type ?? null,
    payment_channel: transaction.payment_channel ?? null,
    original_transaction_id:
      transaction.original_transaction_id ?? null,
    excluded_from_spending: Boolean(transaction.excluded_from_spending),
    is_fixed: Boolean(transaction.is_fixed),
    split_version: Number(transaction.split_version ?? 0),
  };
}

function recurringCard(stream) {
  return {
    id: stream.id,
    service: stream.display_name,
    service_family: stream.service_family,
    type: stream.stream_type,
    detected_type: stream.detected_stream_type ?? stream.stream_type,
    type_override: stream.stream_type_override ?? null,
    classification_signals: stream.classification_signals ?? {},
    override_source_finding_id:
      stream.override_source_finding_id ?? null,
    cadence: stream.cadence,
    expected_amount: money(
      stream.expected_amount_minor,
      stream.currency_code,
    ),
    expected_range: {
      minimum: money(stream.min_amount_minor, stream.currency_code),
      maximum: money(stream.max_amount_minor, stream.currency_code),
    },
    monthly_equivalent: money(
      stream.monthly_equivalent_minor,
      stream.currency_code,
    ),
    annual_equivalent: money(
      stream.monthly_equivalent_minor * 12,
      stream.currency_code,
    ),
    next_estimated_date: stream.next_expected_on,
    confidence_basis_points: stream.confidence_basis_points,
    status: stream.status,
    duplicate_state: stream.duplicate_state,
    category: stream.category_primary ?? null,
    account: stream.account_id
      ? { id: stream.account_id, name: stream.account_name }
      : null,
    transaction_ids: [...(stream.transaction_ids ?? [])],
  };
}

function manualAssetCard(asset) {
  return {
    id: asset.id,
    name: asset.name,
    asset_type: asset.asset_type,
    description: asset.description ?? null,
    current_value:
      asset.value_minor == null
        ? null
        : money(asset.value_minor, asset.currency_code),
    valued_on: asset.valued_on ?? null,
    active: asset.active !== false,
  };
}

function manualAssetsAt(
  assets,
  valuations,
  asOf,
  { historical = false } = {},
) {
  const cutoff = dateOnly(asOf);
  const latestByAsset = new Map();
  for (const valuation of valuations ?? []) {
    const assetId =
      valuation.manual_asset_id ?? valuation.asset_id ?? valuation.id;
    const valuedOn = dateOnly(
      valuation.valued_on ??
        valuation.valuation_on ??
        valuation.as_of ??
        cutoff,
    );
    if (!assetId || valuedOn > cutoff) continue;
    const existing = latestByAsset.get(assetId);
    if (!existing || existing.valued_on < valuedOn) {
      latestByAsset.set(assetId, {
        value_minor:
          valuation.value_minor ??
          valuation.current_value_minor ??
          null,
        currency_code: valuation.currency_code,
        valued_on: valuedOn,
      });
    }
  }

  return (assets ?? [])
    .filter((asset) => {
      if (!historical) {
        return asset.active !== false && !asset.archived_at;
      }
      const createdOn = asset.created_at
        ? dateOnly(asset.created_at)
        : null;
      const archivedOn = asset.archived_at
        ? dateOnly(asset.archived_at)
        : null;
      return (
        (!createdOn || createdOn <= cutoff) &&
        (!archivedOn || archivedOn > cutoff)
      );
    })
    .map((asset) => {
      const valuation = latestByAsset.get(asset.id);
      const fallbackDate = asset.valued_on
        ? dateOnly(asset.valued_on)
        : null;
      const useFallback =
        fallbackDate == null
          ? !historical
          : fallbackDate <= cutoff;
      return {
        id: asset.id,
        name: asset.name,
        asset_type: asset.asset_type ?? asset.type ?? "other",
        description: asset.description ?? null,
        currency_code:
          valuation?.currency_code ??
          asset.currency_code ??
          "USD",
        value_minor:
          valuation?.value_minor ??
          (useFallback
            ? asset.current_value_minor ?? asset.value_minor ?? null
            : null),
        valued_on:
          valuation?.valued_on ??
          (useFallback ? fallbackDate : null),
        active: true,
      };
    });
}

function accountsAtSnapshots(accounts, snapshots) {
  const latest = new Map();
  for (const snapshot of snapshots ?? []) {
    const existing = latest.get(snapshot.account_id);
    if (
      !existing ||
      String(existing.snapshot_on) < String(snapshot.snapshot_on)
    ) {
      latest.set(snapshot.account_id, snapshot);
    }
  }
  return accounts
    .filter((account) => latest.has(account.id))
    .map((account) => {
      const snapshot = latest.get(account.id);
      return {
        ...account,
        current_balance_minor: snapshot.current_balance_minor,
        available_balance_minor: snapshot.available_balance_minor,
        credit_limit_minor: snapshot.credit_limit_minor,
        currency_code: snapshot.currency_code ?? account.currency_code,
        type: snapshot.type ?? account.type,
        subtype: snapshot.subtype ?? account.subtype,
        is_liability:
          snapshot.is_liability ?? account.is_liability,
      };
    });
}

function historicalFreshness(freshness, requestedAsOf, partial = false) {
  if (!requestedAsOf) return freshness;
  const cutoff = parseAsOf(requestedAsOf, new Date()).toISOString();
  const dataAsOf =
    freshness.data_as_of &&
    new Date(freshness.data_as_of).getTime() <
      new Date(cutoff).getTime()
      ? freshness.data_as_of
      : cutoff;
  return {
    ...freshness,
    data_as_of: dataAsOf,
    partial: Boolean(freshness.partial || partial),
  };
}

async function optionalRepositoryCall(
  repository,
  method,
  fallback,
  ...args
) {
  if (typeof repository[method] !== "function") return fallback;
  return (await repository[method](...args)) ?? fallback;
}

function unavailableCreditScoreData({ period, currentOn }) {
  const data = buildCreditScoreSummary({
    members: [],
    sources: [],
    observations: [],
    currentOn,
    period,
    currentUserId: null,
    forMcp: false,
  });
  data.warnings.unshift({
    code: "credit_score_refresh_failed",
    message:
      "Tracked credit scores couldn’t be refreshed. Card balances and utilization are still shown.",
  });
  return data;
}

function expandAndFilterTransactions(
  transactions,
  splits,
  category = null,
) {
  const expanded = expandTransactionsWithSplits(
    transactions,
    splits,
  );
  if (!category) return expanded;
  const filtered = expanded.filter(
    (transaction) => transaction.category_primary === category,
  );
  const collapsed = new Map();
  for (const transaction of filtered) {
    if (!transaction.split_parent_id) {
      collapsed.set(`transaction:${transaction.id}`, transaction);
      continue;
    }
    const key = `split:${transaction.split_parent_id}`;
    const existing = collapsed.get(key);
    if (existing) {
      existing.amount_minor += transaction.amount_minor;
      continue;
    }
    collapsed.set(key, {
      ...transaction,
      id: transaction.split_parent_id,
    });
  }
  return [...collapsed.values()];
}

function parseAsOf(value, fallback) {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError("Invalid as_of");
  return parsed;
}

function resolvePeriod(name, startOn, endOn, now) {
  if (name === "custom") {
    if (!startOn || !endOn) {
      throw new TypeError("custom period requires start and end dates");
    }
    return { start_on: dateOnly(startOn), end_on: dateOnly(endOn) };
  }
  if (startOn || endOn) {
    return {
      start_on: dateOnly(startOn ?? shiftDateOnly(endOn, -30)),
      end_on: dateOnly(endOn ?? shiftDateOnly(startOn, 30)),
    };
  }
  if (name === "week") {
    return {
      start_on: shiftDateOnly(now, -6),
      end_on: shiftDateOnly(now, 1),
    };
  }
  if (name === "quarter") {
    return {
      start_on: shiftDateOnly(now, -89),
      end_on: shiftDateOnly(now, 1),
    };
  }
  if (name === "year") {
    return {
      start_on: shiftDateOnly(now, -364),
      end_on: shiftDateOnly(now, 1),
    };
  }
  const month = periodForMonth(now).current;
  month.end_on = earlierDate(month.end_on, shiftDateOnly(now, 1));
  return month;
}

export function normalizeTransactionSort(value) {
  const normalized = String(value ?? "date").trim().toLowerCase();
  return TRANSACTION_SORTS.has(normalized) ? normalized : "date";
}

function normalizeAnalyticsGroup(value) {
  return value === "merchant" ? "merchant" : "category";
}

export function resolveTransactionPeriod(query, now) {
  if (query.start && query.end) {
    return {
      name: "custom",
      period: resolvePeriod(
        "custom",
        query.start,
        query.end,
        now,
      ),
    };
  }

  const name = new Set([
    "month",
    "30",
    "90",
    "365",
    "this-year",
    "last-year",
  ]).has(query.period)
    ? query.period
    : "month";
  const endOn = shiftDateOnly(now, 1);
  if (name === "30" || name === "90" || name === "365") {
    return {
      name,
      period: {
        start_on: shiftDateOnly(now, -(Number(name) - 1)),
        end_on: endOn,
      },
    };
  }
  const currentYear = Number(dateOnly(now).slice(0, 4));
  if (name === "this-year") {
    return {
      name,
      period: {
        start_on: `${currentYear}-01-01`,
        end_on: endOn,
      },
    };
  }
  if (name === "last-year") {
    return {
      name,
      period: {
        start_on: `${currentYear - 1}-01-01`,
        end_on: `${currentYear}-01-01`,
      },
    };
  }
  return {
    name,
    period: resolvePeriod("month", null, null, now),
  };
}

function dashboardHistoryPeriod(value, now) {
  const name = ["1w", "1m", "1y", "all"].includes(value)
    ? value
    : "1m";
  const endOn = shiftDateOnly(now, 1);
  const periods = {
    "1w": {
      label: "Last week",
      comparison_label: "over the last week",
      start_on: shiftDateOnly(now, -7),
      end_on: endOn,
      interval: "day",
      limit: 8,
    },
    "1m": {
      label: "Last month",
      comparison_label: "over the last month",
      start_on: shiftDateOnly(now, -30),
      end_on: endOn,
      interval: "day",
      limit: 31,
    },
    "1y": {
      label: "Last year",
      comparison_label: "over the last year",
      start_on: shiftDateOnly(now, -365),
      end_on: endOn,
      interval: "day",
      limit: 366,
    },
    all: {
      label: "All history",
      comparison_label: "since tracking began",
      start_on: "1970-01-01",
      end_on: endOn,
      interval: "month",
      limit: 366,
    },
  };
  return { name, ...periods[name] };
}

function priorMonthToDatePeriod(now) {
  const current = resolvePeriod("month", null, null, now);
  const elapsedDays = daysBetween(
    current.start_on,
    current.end_on,
  );
  const previousMonth = periodForMonth(
    new Date(`${shiftDateOnly(current.start_on, -1)}T00:00:00.000Z`),
  ).current;
  return {
    start_on: previousMonth.start_on,
    end_on: earlierDate(
      previousMonth.end_on,
      shiftDateOnly(previousMonth.start_on, elapsedDays),
    ),
  };
}

function portfolioPeriodStart(period, now) {
  const days = {
    "1w": 7,
    "1m": 30,
    "3m": 90,
    "6m": 183,
    "1y": 365,
    all: 3650,
  }[period];
  return shiftDateOnly(now, -(days ?? 30));
}

function portfolioScope(value) {
  const normalized = String(value).trim().toLowerCase();
  const scopes = {
    include: { retirementScope: "include", pageScope: "all" },
    all: { retirementScope: "include", pageScope: "all" },
    exclude: { retirementScope: "exclude", pageScope: "trading" },
    trading: { retirementScope: "exclude", pageScope: "trading" },
    taxable: { retirementScope: "exclude", pageScope: "trading" },
    only: { retirementScope: "only", pageScope: "retirement" },
    retirement: { retirementScope: "only", pageScope: "retirement" },
  };
  const result = scopes[normalized];
  if (!result) {
    throw new TypeError(
      "retirement_scope must be include, exclude, or only",
    );
  }
  return result;
}

function portfolioScopeLabel(scope, sentenceCase = false) {
  const label = {
    include: "all",
    exclude: "trading",
    only: "retirement",
  }[scope];
  if (!sentenceCase) return label;
  return label === "all"
    ? "Total"
    : label[0].toUpperCase() + label.slice(1);
}

function recurringStatusMatches(streamStatus, requested) {
  if (requested === "all") return true;
  if (requested === "active") {
    return ["active", "resumed", "irregular"].includes(streamStatus);
  }
  if (requested === "paused") return streamStatus === "dismissed";
  return streamStatus === requested;
}

function downsampleSeries(series, interval) {
  if (interval === "day") return series;
  const points = new Map();
  for (const point of series) {
    const date = new Date(`${point.timestamp}T00:00:00.000Z`);
    const key =
      interval === "month"
        ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
        : weekKey(date);
    points.set(key, point);
  }
  return [...points.values()];
}

function sampleSeries(series, maximum) {
  if (series.length <= maximum) return series;
  const lastIndex = series.length - 1;
  const indexes = new Set([0, lastIndex]);
  for (let index = 1; index < maximum - 1; index += 1) {
    indexes.add(Math.round((index * lastIndex) / (maximum - 1)));
  }
  return [...indexes]
    .sort((left, right) => left - right)
    .map((index) => series[index]);
}

function weekKey(date) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() - ((copy.getUTCDay() + 6) % 7));
  return dateOnly(copy);
}

function encodeOffsetCursor(kind, offset) {
  return Buffer.from(JSON.stringify({ kind, offset })).toString("base64url");
}

function decodeOffsetCursor(cursor, kind) {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      parsed.kind !== kind ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0
    ) {
      throw new Error();
    }
    return parsed.offset;
  } catch {
    throw new TypeError(`Invalid ${kind} cursor`);
  }
}

function bounded(value, fallback, maximum) {
  const number = Number(value ?? fallback);
  return Number.isSafeInteger(number)
    ? Math.max(1, Math.min(maximum, number))
    : fallback;
}

function validateTransactionIds(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 100
  ) {
    throw new TypeError(
      "transaction_ids must contain between 1 and 100 IDs",
    );
  }
  const ids = value.map((id) => requiredId(id, "transaction_id"));
  if (new Set(ids).size !== ids.length) {
    throw new TypeError("transaction_ids must be unique");
  }
  return ids;
}

function validateTransactionTags(value) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new TypeError("tags must be an array with at most 20 names");
  }
  const tags = value.map((tag) => boundedText(tag, "tag", 64));
  const normalized = tags.map((tag) =>
    tag
      .normalize("NFKD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim(),
  );
  if (
    normalized.some((tag) => !tag || tag.length > 64) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new TypeError("tags must be unique names");
  }
  return tags;
}

function transactionCleanupRuleMutation(input) {
  const matcher = input.matcher;
  const changes = input.changes;
  if (!matcher || typeof matcher !== "object" || Array.isArray(matcher)) {
    throw new TypeError("matcher must be an object");
  }
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new TypeError("changes must be an object");
  }
  if (
    Object.keys(matcher).some(
      (key) => !["field", "mode", "value"].includes(key),
    )
  ) {
    throw new TypeError("Unsupported cleanup matcher field");
  }
  if (
    Object.keys(changes).some(
      (key) =>
        ![
          "display_name",
          "displayName",
          "category_primary",
          "categoryPrimary",
          "tags",
        ].includes(key),
    )
  ) {
    throw new TypeError("Unsupported cleanup rule change");
  }

  const matchField = matcher.field;
  if (
    !["normalized_merchant", "normalized_name"].includes(matchField)
  ) {
    throw new TypeError("matcher.field is not supported");
  }
  const matchMode = matcher.mode ?? "exact";
  if (!["exact", "contains"].includes(matchMode)) {
    throw new TypeError("matcher.mode is not supported");
  }
  const rawMatchValue = boundedText(
    matcher.value,
    "matcher.value",
    160,
  );
  const matchValue =
    matchField === "normalized_merchant"
      ? normalizeMerchant(rawMatchValue)
      : normalizeTransactionName(rawMatchValue);
  if (!matchValue || matchValue.length > 160) {
    throw new TypeError(
      "matcher.value must produce between 1 and 160 normalized characters",
    );
  }
  if (matchMode === "contains" && matchValue.length < 3) {
    throw new TypeError(
      "contains matchers require at least 3 normalized characters",
    );
  }

  const result = {
    matchField,
    matchMode,
    matchValue: rawMatchValue,
    normalizedMatchValue: matchValue,
  };
  const hasDisplayName =
    Object.hasOwn(changes, "display_name") ||
    Object.hasOwn(changes, "displayName");
  const hasCategoryPrimary =
    Object.hasOwn(changes, "category_primary") ||
    Object.hasOwn(changes, "categoryPrimary");
  if (hasDisplayName) {
    result.displayName = boundedText(
      changes.display_name ?? changes.displayName,
      "display_name",
      160,
    );
  }
  if (hasCategoryPrimary) {
    const category = boundedText(
      changes.category_primary ?? changes.categoryPrimary,
      "category_primary",
      100,
    );
    result.categoryPrimary = canonicalTransactionCategory(category);
  }
  if (Object.hasOwn(changes, "tags")) {
    result.tags = validateTransactionTags(changes.tags);
  }
  if (
    !hasDisplayName &&
    !hasCategoryPrimary &&
    !Object.hasOwn(changes, "tags")
  ) {
    throw new TypeError(
      "At least one cleanup rule change is required",
    );
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") {
      throw new TypeError("enabled must be a boolean");
    }
    result.enabled = input.enabled;
  }
  return result;
}

function transactionCleanupRuleResponse(rule) {
  const matcher = rule?.matcher ?? {};
  const storedChanges = rule?.changes ?? {};
  const matchField =
    matcher.field ??
    rule?.match_field ??
    rule?.matcher_field ??
    rule?.matchField ??
    null;
  const matchValue =
    matcher.value ??
    rule?.match_value ??
    rule?.matcher_value ??
    rule?.matchValue ??
    null;
  const matchMode =
    matcher.mode ??
    rule?.match_mode ??
    rule?.matcher_mode ??
    rule?.matchMode ??
    "exact";
  const normalizedMatchValue =
    matcher.normalized_value ??
    matcher.normalizedValue ??
    rule?.normalized_match_value ??
    rule?.normalizedMatchValue ??
    null;
  const changes = {};
  const displayName =
    storedChanges.display_name ??
    storedChanges.displayName ??
    rule?.display_name ??
    rule?.displayName ??
    null;
  const categoryPrimary =
    storedChanges.category_primary ??
    storedChanges.categoryPrimary ??
    rule?.category_primary ??
    rule?.categoryPrimary ??
    null;
  const tags = Object.hasOwn(storedChanges, "tags")
    ? storedChanges.tags
    : Object.hasOwn(rule ?? {}, "tags")
      ? rule.tags
      : null;
  if (displayName != null) changes.display_name = displayName;
  if (categoryPrimary != null) {
    changes.category_primary = categoryPrimary;
  }
  if (tags != null) changes.tags = tags;

  return {
    id: rule?.id,
    matcher: {
      field: matchField,
      mode: matchMode,
      value: matchValue,
      normalized_value: normalizedMatchValue,
    },
    changes,
    enabled: rule?.enabled !== false,
    matched_transaction_count: Number(
      rule?.matched_transaction_count ??
        rule?.match_count ??
        rule?.matchedCount ??
        0,
    ),
    created_at: rule?.created_at ?? rule?.createdAt ?? null,
    updated_at: rule?.updated_at ?? rule?.updatedAt ?? null,
  };
}

function isCleanupRuleConflict(error) {
  return (
    error?.statusCode === 409 ||
    error?.code === "23505" ||
    error?.constraint ===
      "transaction_cleanup_rules_workspace_match_unique"
  );
}

function cleanupRuleConflict() {
  const error = new Error(
    "A cleanup rule already uses this matcher",
  );
  error.statusCode = 409;
  return error;
}

function categoryConflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  error.expose = true;
  return error;
}

function spendingClassification(value) {
  if (!["fixed", "flexible"].includes(value)) {
    throw badRequest("classification must be fixed or flexible");
  }
  return value;
}

function positiveVersion(value, field) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw badRequest(`${field} must be a positive integer`);
  }
  return version;
}

function optionalCategoryId(value, field) {
  if (value == null || value === "") return null;
  return requiredId(value, field);
}

function booleanOption(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes"].includes(String(value).toLowerCase());
}

function formatMoney(value) {
  return formatMinorMoney(value) ?? "—";
}

function formatBasisPoints(value) {
  return `${(value / 100).toFixed(1)}%`;
}

function formatTrend(trend) {
  if (trend.percent_basis_points == null) return "up from no prior spending";
  if (trend.direction === "flat") return "unchanged";
  return `${trend.direction} ${formatBasisPoints(Math.abs(trend.percent_basis_points))}`;
}

function formatMonth(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function freshnessSentence(freshness) {
  return freshness.data_as_of
    ? `Data as of ${new Date(freshness.data_as_of).toISOString()}.`
    : "No successful account sync has completed yet.";
}

function freshnessLabel(freshness) {
  return freshness.data_as_of
    ? `Updated ${new Date(freshness.data_as_of).toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" })}`
    : "Waiting for first sync";
}

function insightTitle(section) {
  return {
    weekly: "Weekly changes",
    investments: "Investment insights",
    subscriptions: "Subscription insights",
  }[section];
}

function weeklyInsightSummary(findings) {
  return {
    spend_less_count: countFindings(findings, "spend_less"),
    better_habits_count: countFindings(findings, "better_habits"),
    needs_review_count: countFindings(findings, "needs_review"),
  };
}

function investmentInsightSummary(portfolio = {}, findings = []) {
  const performance = findings.find(
    (finding) => finding.type === "performance",
  )?.metrics ?? {};
  return {
    current_value:
      portfolio?.total_value ?? performance.current_value ?? null,
    allocation: (portfolio?.allocation ?? []).slice(0, 20),
    one_week_change: performance.week_value_change ?? null,
    one_month_change: performance.month_value_change ?? null,
    since_first_snapshot_change:
      performance.since_first_snapshot_change ?? null,
    contributions:
      portfolio?.contributions ?? performance.contributions ?? null,
    withdrawals:
      portfolio?.withdrawals ?? performance.withdrawals ?? null,
    estimated_gain:
      portfolio && "estimated_gain" in portfolio
        ? portfolio.estimated_gain
        : performance.estimated_gain ?? null,
    estimated_return_basis_points:
      portfolio && "estimated_return_basis_points" in portfolio
        ? portfolio.estimated_return_basis_points
        : performance.estimated_return_basis_points ?? null,
    concentration_count: countFindings(findings, "concentration"),
  };
}

function subscriptionInsightSummary(recurring = {}, findings = []) {
  return {
    active_count: recurring?.recurring_payments?.length ?? 0,
    monthly_equivalent: recurring?.monthly_equivalent ?? null,
    annual_equivalent: recurring?.annual_equivalent ?? null,
    duplicate_count: countFindings(findings, "possible_duplicate"),
    expensive_count: countFindings(findings, "expensive"),
    price_increase_count: countFindings(findings, "price_increase"),
  };
}

function countFindings(findings, type) {
  return findings.filter((finding) => finding.type === type).length;
}

function findingSummaryFragment(finding) {
  return presentInsightForWeb(finding, {
    family: finding.family,
  }).actionTitle;
}

function daysBetween(start, end) {
  return Math.max(
    1,
    Math.round(
      (new Date(`${dateOnly(end)}T00:00:00Z`) -
        new Date(`${dateOnly(start)}T00:00:00Z`)) /
        86_400_000,
    ),
  );
}

function flattenAccountGroups(groups) {
  return groups.flatMap((group) =>
    group.accounts.map((account) => ({
      ...account,
      institution_name: group.institution_name,
    })),
  );
}

function webOverview(data) {
  return {
    netWorth: data.net_worth,
    netWorthChange: null,
    cashBalance: data.cash_balance,
    shortTermWorth: data.short_term_worth,
    taxableInvestments: data.taxable_investments,
    retirementInvestments: data.retirement_assets,
    manualAssetValue: data.manual_asset_value,
    creditCardLiabilities: data.credit_card_liabilities,
    loanLiabilities: data.loan_liabilities,
    assets: data.assets,
    liabilities: data.liabilities,
    cash: data.cash,
    portfolio: data.portfolio,
    spending: data.spending,
    income: data.income,
    cashFlow: data.cash_flow,
    subscriptions: data.subscriptions_monthly,
  };
}

function spendingTrendLabel(trend) {
  if (!trend) return null;
  if (trend.percent_basis_points == null) {
    return `${formatMoney(trend.amount)} from no prior spending`;
  }
  if (trend.direction === "flat") return "No change from the prior period";
  return `${(Math.abs(trend.percent_basis_points) / 100).toFixed(1)}% ${
    trend.direction === "up" ? "more" : "less"
  } than the prior period`;
}

function spendingMonthOverMonthLabel(trend) {
  if (!trend || trend.percent_basis_points == null) {
    return "New this month";
  }
  const basisPoints = trend.percent_basis_points;
  const sign = basisPoints > 0 ? "+" : basisPoints < 0 ? "-" : "";
  return `${sign}${(Math.abs(basisPoints) / 100).toFixed(1)}% MoM`;
}

function webOverviewFromCashFlow(data) {
  return {
    income: data.income,
    spending: data.spending,
    cashFlow: data.net,
  };
}

export function webSpendingDetails(
  spendingByGroup,
  categoryDefinitions = [],
  {
    activeGrouping = "category",
    activeSegmentKey = null,
  } = {},
) {
  const categoryData = spendingByGroup.category;
  const groupings = Object.fromEntries(
    Object.entries(spendingByGroup).map(([grouping, data]) => [
      grouping,
      {
        key: grouping,
        label: grouping === "merchant" ? "Merchant" : "Category",
        seriesInterval: data.series_interval,
        seriesLabels: data.series.map((point) =>
          formatShortDate(point.timestamp),
        ),
        seriesValues: data.series.map(
          (point) => point.value.amount_minor,
        ),
        segments: data.segments.map((segment, index) =>
          webSpendingSegment(
            segment,
            index,
            grouping,
            categoryDefinitions,
          ),
        ),
      },
    ]),
  );
  const activeData =
    spendingByGroup[activeGrouping] ?? categoryData;
  const activeSegments =
    groupings[activeGrouping]?.segments ??
    groupings.category.segments;
  const selectedSegment =
    activeSegments.find(
      (segment) => segment.key === activeSegmentKey,
    ) ?? null;
  const series = selectedSegment
    ? selectedSegment.series
    : activeData.series;
  const transactionCount = categoryData.transaction_count;
  const intervalLabel = {
    day: "Daily",
    week: "Weekly",
    month: "Monthly",
  }[activeData.series_interval];
  const emptyReason =
    categoryData.eligibility.matched_transaction_count === 0
      ? "no_matches"
      : !categoryData.has_eligible_spending
        ? "no_eligible_spending"
        : categoryData.total.amount_minor === 0
          ? "zero_net_spending"
          : null;
  return {
    total: categoryData.total,
    previousTotal: categoryData.previous_total,
    change: categoryData.trend.amount,
    trendDirection: categoryData.trend.direction,
    trendLabel: spendingTrendLabel(categoryData.trend),
    transactionCount,
    averageTransaction: money(
      transactionCount
        ? Math.round(
            categoryData.total.amount_minor / transactionCount,
          )
        : 0,
      categoryData.currency,
    ),
    periodLabel: formatPeriodRange(categoryData.period),
    previousPeriodLabel: formatPeriodRange(
      categoryData.previous_period,
    ),
    categories: groupings.category.segments,
    groupings,
    activeGrouping,
    activeSegmentKey: selectedSegment?.key ?? null,
    selectedSegment,
    seriesInterval: activeData.series_interval,
    seriesLabel: `${intervalLabel} spending`,
    seriesTitle: selectedSegment
      ? `${intervalLabel} ${selectedSegment.label} spending`
      : `${intervalLabel} spending`,
    hasEligibleSpending: categoryData.has_eligible_spending,
    hasMatchingTransactions:
      categoryData.eligibility.matched_transaction_count > 0,
    emptyReason,
    eligibility: {
      matchedTransactionCount:
        categoryData.eligibility.matched_transaction_count,
      eligibleTransactionCount:
        categoryData.eligibility.eligible_transaction_count,
      excludedTransactionCount:
        categoryData.eligibility.excluded_transaction_count,
      reasons: {
        pending: categoryData.eligibility.reasons.pending,
        income: categoryData.eligibility.reasons.income,
        excludedFromSpending:
          categoryData.eligibility.reasons.excluded_from_spending,
        otherCurrency:
          categoryData.eligibility.reasons.other_currency,
        zeroAmount:
          categoryData.eligibility.reasons.zero_amount,
      },
    },
    seriesLabels: series.map((point) =>
      formatShortDate(point.timestamp),
    ),
    seriesValues: series.map(
      (point) => point.value.amount_minor,
    ),
  };
}

function webSpendingSegment(
  segment,
  index,
  grouping,
  categoryDefinitions = [],
) {
  const category =
    grouping === "category"
      ? webCategory(segment, index, categoryDefinitions)
      : {
          value: segment.label,
          label: segment.label,
          amount: segment.amount,
          previousAmount: segment.previous_amount,
          momAmount: segment.trend?.amount ?? null,
          momBasisPoints:
            segment.trend?.percent_basis_points ?? null,
          momDirection: segment.trend?.direction ?? null,
          momLabel: spendingMonthOverMonthLabel(segment.trend),
          percent: segment.share_basis_points / 100,
          color: CATEGORY_COLORS[index % CATEGORY_COLORS.length],
          icon: "ph-receipt",
        };
  return {
    ...category,
    key: segment.key,
    grouping,
    count: segment.count,
    series: segment.series,
    seriesLabels: segment.series.map((point) =>
      formatShortDate(point.timestamp),
    ),
    seriesValues: segment.series.map(
      (point) => point.value.amount_minor,
    ),
  };
}

function webCategory(segment, index, categoryDefinitions = []) {
  const category = categoryDefinitions.find(
    (candidate) => candidate.path === segment.label,
  );
  return {
    value: segment.category_id ?? category?.id ?? segment.label,
    label: transactionCategoryLabel(segment.label),
    amount: segment.amount,
    previousAmount: segment.previous_amount,
    momAmount: segment.trend?.amount ?? null,
    momBasisPoints: segment.trend?.percent_basis_points ?? null,
    momDirection: segment.trend?.direction ?? null,
    momLabel: spendingMonthOverMonthLabel(segment.trend),
    percent: segment.share_basis_points / 100,
    color: CATEGORY_COLORS[index % CATEGORY_COLORS.length],
    icon: categoryIcon(segment.label),
  };
}

function formatPeriodRange(period) {
  const start = formatShortDate(period.start_on, { year: true });
  const inclusiveEnd = formatShortDate(
    shiftDateOnly(period.end_on, -1),
    { year: true },
  );
  return `${start}–${inclusiveEnd}`;
}

function formatShortDate(value, { year = false } = {}) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(year ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(new Date(`${dateOnly(value)}T00:00:00Z`));
}

function trustworthyTransactionTimestamp(value) {
  if (!value) return null;
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return null;
  if (
    timestamp.getUTCHours() === 0 &&
    timestamp.getUTCMinutes() === 0 &&
    timestamp.getUTCSeconds() === 0 &&
    timestamp.getUTCMilliseconds() === 0
  ) {
    return null;
  }
  return timestamp.toISOString();
}

function transactionDateOnly(transaction, timestamp) {
  const candidates = [
    timestamp,
    transaction.authorized_on,
    transaction.authorized_at,
    transaction.date,
  ];
  for (const candidate of candidates) {
    if (candidate instanceof Date && Number.isFinite(candidate.getTime())) {
      return dateOnly(candidate);
    }
    if (
      typeof candidate === "string" &&
      /^\d{4}-\d{2}-\d{2}/.test(candidate)
    ) {
      return candidate.slice(0, 10);
    }
  }
  return dateOnly(transaction.date);
}

function webTransaction(transaction) {
  const categoryValue = transaction.category ?? "Uncategorized";
  const category = transaction.category_id
    ? categoryValue
    : transactionCategoryLabel(
        categoryValue,
        transaction.detailed_category,
      );
  const dateTime =
    trustworthyTransactionTimestamp(transaction.authorized_at) ??
    trustworthyTransactionTimestamp(transaction.posted_at);
  const dateIso = transactionDateOnly(transaction, dateTime);
  return {
    id: transaction.id,
    providerTransactionId:
      transaction.provider_transaction_id ?? null,
    merchant: transaction.merchant ?? transaction.description,
    displayName:
      transaction.display_name ??
      transaction.merchant ??
      transaction.description,
    rawMerchant: transaction.raw_merchant ?? null,
    rawName: transaction.raw_name ?? transaction.description,
    note: transaction.note ?? null,
    noteVersion: Number(transaction.note_version ?? 0),
    noteUpdatedBy: transaction.note_updated_by ?? null,
    noteUpdatedAt: transaction.note_updated_at ?? null,
    tags: Array.isArray(transaction.tags) ? transaction.tags : [],
    category,
    categoryValue,
    categoryId: transaction.category_id ?? null,
    detailedCategoryValue:
      transaction.detailed_category ?? null,
    originalCategoryValue:
      transaction.original_category ?? null,
    originalDetailedCategoryValue:
      transaction.original_detailed_category ?? null,
    account: transaction.account.name,
    accountId: transaction.account.id,
    accountMask: transaction.account.mask ?? null,
    institution: transaction.account.institution ?? null,
    amount: transaction.amount,
    providerAmount:
      transaction.provider_amount ?? transaction.amount,
    isSplitCategoryProjection: Boolean(
      transaction.is_split_category_projection,
    ),
    splitCategoryLineCount: Number(
      transaction.split_category_line_count ?? 0,
    ),
    date: formatShortDate(dateIso, { year: true }),
    dateIso,
    dateTime,
    authorizedAt: transaction.authorized_at ?? null,
    authorizedOn: transaction.authorized_on ?? null,
    postedAt: transaction.posted_at ?? null,
    postedOn: transaction.date ?? dateIso,
    status: transaction.pending ? "pending" : "posted",
    cardholderName: transaction.cardholder_name ?? null,
    sourceTransactionType:
      transaction.source_transaction_type ?? null,
    paymentChannel: transaction.payment_channel ?? null,
    originalTransactionId:
      transaction.original_transaction_id ?? null,
    excludedFromSpending: transaction.excluded_from_spending,
    isFixed: transaction.is_fixed,
    splitVersion: Number(transaction.split_version ?? 0),
    icon: categoryIcon(category),
  };
}

function transactionCleanupRow(transaction, fallbackCurrency) {
  return {
    id: transaction.id,
    display_name:
      transaction.display_name ??
      transaction.merchant_name ??
      transaction.name,
    raw_merchant: transaction.merchant_name ?? null,
    raw_name: transaction.name,
    category_primary: transaction.category_primary ?? null,
    tags: Array.isArray(transaction.tags) ? transaction.tags : [],
    posted_on: transaction.posted_on,
    account_id: transaction.account_id,
    account_name: transaction.account_name,
    amount: money(
      transaction.amount_minor,
      transaction.currency_code ?? fallbackCurrency,
    ),
    similarity_basis_points:
      transaction.similarity_basis_points ?? 0,
    match_reason: transaction.match_reason ?? "similar",
    preselected: Boolean(transaction.preselected),
  };
}

function webAccount(account) {
  return {
    id: account.id,
    institution: account.institution_name ?? "Other",
    name: account.name,
    type: account.subtype ?? account.type,
    balanceGroup: account.balance_group,
    balanceGroupOverride:
      account.balance_group_override ?? null,
    mask: account.mask ?? "—",
    balance: account.current_balance,
    available: account.available_balance,
    icon: accountIcon(account.type),
    tone: account.type === "depository" ? "green" : account.type === "credit" ? "blue" : "black",
    syncedAt:
      account.ingestion_method === "csv"
        ? null
        : account.freshness.synced_at ?? null,
    freshness:
      account.ingestion_method === "csv"
        ? account.freshness.posted_through_on
          ? `Posted through ${account.freshness.posted_through_on}`
          : "No posted transactions imported"
        : account.freshness.synced_at
          ? `Synced ${new Date(account.freshness.synced_at).toLocaleString()}`
          : "Not synced",
  };
}

function webManualAsset(asset) {
  const value =
    asset.current_value ??
    (asset.value_minor == null
      ? null
      : money(asset.value_minor, asset.currency_code));
  return {
    id: asset.id,
    name: asset.name,
    type: asset.asset_type,
    description: asset.description,
    value,
    valuedOn: asset.valued_on,
    active: asset.active,
    icon:
      asset.asset_type === "vehicle"
        ? "ph-car"
        : asset.asset_type === "real_estate"
          ? "ph-house-line"
          : "ph-diamond",
  };
}

function webRecurring(stream) {
  return {
    id: stream.id,
    name: stream.service,
    cadence: humanize(stream.cadence),
    account: stream.account?.name ?? "Unknown account",
    accountId: stream.account?.id ?? null,
    amount: stream.monthly_equivalent,
    annual: stream.annual_equivalent,
    icon: "ph-repeat",
    state: stream.status,
    next: stream.next_estimated_date ?? "unknown",
    type: stream.type,
    category: stream.category ?? null,
  };
}

function webHolding(holding) {
  const isCash = isCashSecurity(holding);
  const cashCurrency =
    cashCurrencyCode(holding) ?? holding.value?.currency ?? "USD";
  const selectionKey = holding.ticker_symbol ?? holding.name;
  return {
    id: holding.id,
    securityId: holding.security_id,
    accountId: holding.account_id ?? null,
    account: holding.account_name ?? null,
    selectionKey,
    symbol: isCash ? "Cash" : selectionKey,
    badge: isCash
      ? cashCurrency === "USD"
        ? "$"
        : cashCurrency
      : selectionKey.slice(0, 4),
    name: isCash ? `${cashCurrency} balance` : holding.name,
    isCash,
    securityType: holding.security_type ?? null,
    balanceGroup: holding.balance_group ?? null,
    value: holding.value,
    costBasis: holding.cost_basis ?? null,
    price: holding.price ?? null,
    priceAsOf: holding.price_as_of ?? null,
    allocation: holding.allocation_basis_points / 100,
    change: 0,
    shares: isCash ? null : String(holding.quantity ?? "—"),
  };
}

function webInsights(data) {
  return Object.fromEntries(
    ["weekly", "investments", "subscriptions"].map((family) => [
      family,
      (data[family]?.findings ?? []).map((finding) =>
        presentInsightForWeb(
          {
            ...finding,
            family,
            metric: findingMetric(finding.metrics),
            icon: insightIcon(finding.type),
            severity:
              finding.severity === "important"
                ? "attention"
                : finding.severity === "info"
                  ? "neutral"
                  : finding.severity,
          },
          {
            family,
            timeframe: insightTimeframe(family, data[family], finding),
          },
        ),
      ),
    ]),
  );
}

function insightTimeframe(family, section = {}, finding = {}) {
  if (family === "weekly") {
    if (finding.period_start && finding.period_end) {
      const current = {
        start_on: dateOnly(finding.period_start),
        end_on: dateOnly(finding.period_end),
      };
      const duration = Math.max(
        1,
        Math.round(
          (new Date(`${current.end_on}T00:00:00.000Z`) -
            new Date(`${current.start_on}T00:00:00.000Z`)) /
            86_400_000,
        ),
      );
      const previous = {
        start_on: shiftDateOnly(current.start_on, -duration),
        end_on: current.start_on,
      };
      return `${compactPeriodRange(current)} vs ${compactPeriodRange(previous)}`;
    }
    const current = section.period?.current;
    const previous = section.period?.previous;
    if (current && previous) {
      return `${compactPeriodRange(current)} vs ${compactPeriodRange(previous)}`;
    }
    return "Latest completed week";
  }
  if (family === "investments") return "Last 1 month";
  return "Current active subscriptions";
}

function compactPeriodRange(period) {
  const start = new Date(`${dateOnly(period.start_on)}T00:00:00.000Z`);
  const end = new Date(
    `${shiftDateOnly(period.end_on, -1)}T00:00:00.000Z`,
  );
  const startText = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(start);
  const endText =
    start.getUTCFullYear() === end.getUTCFullYear() &&
    start.getUTCMonth() === end.getUTCMonth()
      ? new Intl.DateTimeFormat("en-US", {
          day: "numeric",
          timeZone: "UTC",
        }).format(end)
      : new Intl.DateTimeFormat("en-US", {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }).format(end);
  return `${startText}–${endText}`;
}

function findingMetric(metrics = {}) {
  const value = Object.values(metrics).find(
    (candidate) => candidate?.amount_minor != null,
  );
  return value ? formatMoney(value) : "";
}

function categoryIcon(category = "") {
  const value = String(category).toLowerCase();
  if (value.includes("fee") || value.includes("interest")) return "ph-coins";
  if (value.includes("food") || value.includes("dining")) return "ph-fork-knife";
  if (value.includes("grocer")) return "ph-basket";
  if (value.includes("travel")) return "ph-airplane-tilt";
  if (
    value.includes("car") ||
    value.includes("auto") ||
    value.includes("parking") ||
    value.includes("gas")
  ) {
    return "ph-car";
  }
  if (value.includes("transport")) return "ph-train";
  if (value.includes("util")) return "ph-lightning";
  if (value.includes("income")) return "ph-buildings";
  return "ph-receipt";
}

function accountIcon(type) {
  return {
    depository: "ph-bank",
    credit: "ph-credit-card",
    loan: "ph-hand-coins",
    investment: "ph-chart-line-up",
  }[type] ?? "ph-wallet";
}

function insightIcon(type) {
  return {
    spend_less: "ph-trend-up",
    better_habits: "ph-repeat",
    needs_review: "ph-magnifying-glass",
    performance: "ph-chart-line-up",
    concentration: "ph-chart-donut",
    possible_duplicate: "ph-copy",
    expensive: "ph-receipt",
    price_increase: "ph-trend-up",
  }[type] ?? "ph-sparkle";
}

function searchResultUrl(result) {
  const encoded = encodeURIComponent(result.entity_id);
  return {
    transaction: `/transactions?transaction=${encoded}`,
    account: `/accounts#account-${encoded}`,
    manual_asset: `/accounts#asset-${encoded}`,
    recurring: `/recurring?item=${encoded}`,
    insight: `/insights?finding=${encoded}`,
  }[result.entity_type] ?? "/";
}

function entityIcon(type) {
  return {
    transaction: "ph-receipt",
    account: "ph-bank",
    manual_asset: "ph-house-line",
    recurring: "ph-repeat",
    insight: "ph-sparkle",
  }[type] ?? "ph-magnifying-glass";
}

function humanize(value) {
  return String(value)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function validatedBalanceGroup(value) {
  const groups = new Set([
    "cash",
    "taxable_investment",
    "retirement",
    "credit_card",
    "loan",
    "other_asset",
    "other_liability",
    "excluded",
  ]);
  if (typeof value !== "string" || !groups.has(value)) {
    throw new TypeError("Invalid balance_group");
  }
  return value;
}

function manualAssetMutation(
  input,
  { requireIdentity = false, partial = false } = {},
) {
  const result = {};
  const has = (...keys) =>
    keys.some((key) => Object.hasOwn(input, key));
  const read = (...keys) => {
    const key = keys.find((candidate) =>
      Object.hasOwn(input, candidate),
    );
    return key == null ? undefined : input[key];
  };

  if (requireIdentity || has("name")) {
    result.name = boundedText(read("name"), "name", 120);
  }
  if (requireIdentity || has("assetType", "asset_type")) {
    const assetType = read("assetType", "asset_type");
    if (
      ![
        "vehicle",
        "real_estate",
        "business",
        "collectible",
        "other",
      ].includes(assetType)
    ) {
      throw new TypeError("Invalid asset_type");
    }
    result.assetType = assetType;
  }
  if (has("description")) {
    const description = read("description");
    result.description =
      description == null || description === ""
        ? null
        : boundedText(description, "description", 500);
  } else if (requireIdentity) {
    result.description = null;
  }
  if (requireIdentity || has("currencyCode", "currency_code")) {
    const currency = read("currencyCode", "currency_code");
    if (
      typeof currency !== "string" ||
      !/^[A-Z]{3}$/.test(currency)
    ) {
      throw new TypeError("currency_code must be an ISO-4217 code");
    }
    result.currencyCode = currency;
  }
  if (requireIdentity || has("valueMinor", "value_minor")) {
    const value = read("valueMinor", "value_minor");
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(
        "value_minor must be a non-negative safe integer",
      );
    }
    result.valueMinor = value;
  }
  if (requireIdentity || has("valuedOn", "valued_on")) {
    result.valuedOn = validatedIsoDate(
      read("valuedOn", "valued_on"),
      "valued_on",
    );
  }
  if (
    has("valueMinor", "value_minor") &&
    !has("valuedOn", "valued_on")
  ) {
    throw new TypeError(
      "valued_on is required when value_minor changes",
    );
  }
  if (
    has("valuedOn", "valued_on") &&
    !has("valueMinor", "value_minor")
  ) {
    throw new TypeError(
      "value_minor is required when valued_on changes",
    );
  }
  result.userId = read("userId", "user_id") ?? null;
  if (
    partial &&
    Object.keys(result).every((key) => key === "userId")
  ) {
    throw new TypeError("At least one manual asset field is required");
  }
  return result;
}

function boundedText(value, field, maximum) {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  const clean = value.trim();
  if (!clean || clean.length > maximum) {
    throw new TypeError(
      `${field} must be between 1 and ${maximum} characters`,
    );
  }
  return clean;
}

function validatedIsoDate(value, field) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    throw new TypeError(`${field} must be an ISO date`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new TypeError(`${field} must be an ISO date`);
  }
  return value;
}

function creditScoreActorId(_input, actor) {
  return requiredId(actor?.id, "signed-in user");
}

function optionalCreditScoreText(value, field, maximum) {
  if (value == null || String(value).trim() === "") return null;
  return creditScoreText(value, field, maximum);
}

function creditScoreText(value, field, maximum) {
  if (typeof value !== "string") {
    throw badRequest(`${field} must be a string`);
  }
  const clean = value.trim();
  if (!clean || clean.length > maximum) {
    throw badRequest(
      `${field} must be between 1 and ${maximum} characters`,
    );
  }
  return clean;
}

function creditScoreSourceMutation(input, { requireLabel = false } = {}) {
  const hasLabel = Object.hasOwn(input, "label");
  const hasBureau = Object.hasOwn(input, "bureau");
  const hasModel =
    Object.hasOwn(input, "model") ||
    Object.hasOwn(input, "scoring_model");
  if (requireLabel && !hasLabel) {
    throw badRequest("label is required");
  }
  if (!hasLabel && !hasBureau && !hasModel) {
    throw badRequest("At least one source field is required");
  }
  return {
    ...(hasLabel
      ? { label: creditScoreText(input.label, "label", 120) }
      : {}),
    ...(hasBureau
      ? {
          bureau: optionalCreditScoreText(
            input.bureau,
            "bureau",
            80,
          ),
        }
      : {}),
    ...(hasModel
      ? {
          model: optionalCreditScoreText(
            input.model ?? input.scoring_model,
            "model",
            80,
          ),
        }
      : {}),
  };
}

async function throwCreditScoreOwnershipError(
  repository,
  workspaceId,
  sourceId,
  ownerUserId,
) {
  const source = await optionalRepositoryCall(
    repository,
    "getCreditScoreSource",
    null,
    workspaceId,
    sourceId,
  );
  if (source && source.user_id !== ownerUserId) {
    throw forbidden("You can only change your own credit score sources");
  }
  throw notFound("Credit score source not found");
}

function requiredId(value, field) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  ) {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

function isoDateTime(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function insightRunConflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  error.expose = true;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

function badRequest(message) {
  const error = new TypeError(message);
  error.statusCode = 400;
  error.expose = true;
  return error;
}

function forbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  error.expose = true;
  return error;
}

function validateRuleSettings(ruleId, settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new TypeError("settings must be an object");
  }
  const allowed = insightRuleDefinition(ruleId).settings;
  if (Object.keys(settings).some((key) => !allowed.includes(key))) {
    throw new TypeError("Unsupported insight rule setting");
  }
  const result = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key === "categories") {
      if (
        !Array.isArray(value) ||
        value.length > 100 ||
        value.some(
          (category) =>
            typeof category !== "string" ||
            category.length < 1 ||
            category.length > 100,
        )
      ) {
        throw new TypeError("categories must be a bounded string array");
      }
      result.categories = [...new Set(value.map((category) => category.trim()))];
      continue;
    }
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      (key.endsWith("_basis_points") && value > 10_000)
    ) {
      throw new TypeError(`${key} is invalid`);
    }
    result[key] = value;
  }
  return result;
}

function insightRuleDefinition(ruleId) {
  const definitions = [
    {
      publicId: "weekly.spend_less",
      storageId: "shared-weekly-spend-less",
      family: "weekly",
      ruleKey: "spend_less",
      settings: [
        "minimum_change_minor",
        "minimum_change_basis_points",
      ],
    },
    {
      publicId: "weekly.fixed_categories",
      storageId: "shared-weekly-fixed-categories",
      family: "weekly",
      ruleKey: "fixed_categories",
      settings: ["categories"],
    },
    {
      publicId: "investments.concentration",
      storageId: "shared-investment-concentration",
      family: "investments",
      ruleKey: "concentration",
      settings: ["threshold_basis_points"],
    },
    {
      publicId: "subscriptions.expensive",
      storageId: "shared-subscription-expensive",
      family: "subscriptions",
      ruleKey: "expensive",
      settings: ["monthly_threshold_minor"],
    },
  ];
  const definition = definitions.find(
    (candidate) =>
      candidate.publicId === ruleId || candidate.storageId === ruleId,
  );
  if (!definition) throw new TypeError("Unknown insight rule");
  return definition;
}

function earlierDate(left, right) {
  return left < right ? left : right;
}

export function createFinanceService(options) {
  return new FinanceService(options);
}
