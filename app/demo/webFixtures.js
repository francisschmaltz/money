import { presentInsightForWeb } from "../services/insightPresentation.js";
import {
  buildCreditScoreSummary,
  CREDIT_SCORE_PRESETS,
} from "../services/creditScoreTracking.js";
import { DEMO_IDS } from "./fixtureIds.js";
import {
  buildDefaultAccounts,
  buildDefaultPortfolioHoldings,
  buildDefaultRecurringPayments,
  buildDefaultTransactions,
} from "./defaultScenario.js";
import {
  buildUxStressTransactions,
  uxStressAccount,
} from "./uxStressScenario.js";

const usd = (amountMinor) => ({
  amount_minor: amountMinor,
  currency: "USD",
});

function spendingCategory({
  label,
  amountMinor,
  previousMinor,
  percent,
  count,
  color,
  icon,
}) {
  const changeMinor = amountMinor - previousMinor;
  const momBasisPoints =
    previousMinor === 0
      ? null
      : Math.round((changeMinor / previousMinor) * 10_000);
  const momDirection =
    changeMinor > 0 ? "up" : changeMinor < 0 ? "down" : "flat";
  const sign =
    momBasisPoints > 0 ? "+" : momBasisPoints < 0 ? "-" : "";

  return {
    label,
    amount: usd(amountMinor),
    previousAmount: usd(previousMinor),
    momAmount: usd(changeMinor),
    momBasisPoints,
    momDirection,
    momLabel:
      momBasisPoints == null
        ? "New this month"
        : `${sign}${(Math.abs(momBasisPoints) / 100).toFixed(1)}% MoM`,
    percent,
    count,
    color,
    icon,
  };
}

function presentInsights(sections) {
  return Object.fromEntries(
    ["weekly", "investments", "subscriptions"].map((family) => [
      family,
      (sections[family] ?? []).map((finding) =>
        presentInsightForWeb(finding, {
          family,
          timeframe: finding.timeframe,
        }),
      ),
    ]),
  );
}

export function demoInsightSectionsForWeb(
  insightData,
  fallbackSections = [],
) {
  const fallbackById = new Map(
    fallbackSections.flatMap((sections) =>
      Object.values(sections ?? {})
        .flat()
        .map((finding) => [finding.id, finding]),
    ),
  );
  return Object.fromEntries(
    ["weekly", "investments", "subscriptions"].map((family) => [
      family,
      (insightData?.[family]?.findings ?? []).map((finding) => {
        const fallback = fallbackById.get(finding.id);
        const state = finding.state ?? fallback?.state ?? "active";
        return presentInsightForWeb(
          {
            ...finding,
            ...(fallback ?? {}),
            id: finding.id,
            family,
            state,
            isCurrent: state === "active",
          },
          { family, timeframe: fallback?.timeframe },
        );
      }),
    ]),
  );
}

export function demoTransactionForWeb(transaction) {
  const dateIso = transaction.posted_on ?? transaction.date;
  const date =
    {
      [DEMO_IDS.transactions.wholeFoods]: "Jul 25, 2026",
      [DEMO_IDS.transactions.appleServices]: "Jul 24, 2026",
    }[transaction.id] ?? dateIso;
  return {
    id: transaction.id,
    date,
    dateIso,
    dateTime: transaction.posted_at ?? null,
    merchant: transaction.display_name ?? transaction.merchant,
    rawMerchant: transaction.raw_merchant,
    rawName: transaction.raw_name,
    note: transaction.note,
    noteVersion: transaction.note_version,
    noteUpdatedBy: transaction.note_updated_by,
    noteUpdatedAt: transaction.note_updated_at,
    category: transaction.category_primary ?? transaction.category,
    tags: [...(transaction.tags ?? [])],
    accountId: transaction.account.id,
    account:
      transaction.account.id === "account_sapphire"
        ? "Sapphire card"
        : transaction.account.name,
    amount: { ...transaction.amount },
    icon: transaction.icon ?? "ph-receipt",
    status: transaction.pending ? "pending" : "posted",
    excludedFromSpending: Boolean(
      transaction.excluded_from_spending,
    ),
    postedAt: transaction.posted_at ?? null,
    postedOn: transaction.posted_on ?? transaction.date,
  };
}

const accountPresentation = Object.freeze({
  account_checking: {
    type: "Checking",
    icon: "ph-bank",
    tone: "green",
    freshness: "Synced 12 min ago",
  },
  account_savings: {
    type: "Savings",
    icon: "ph-piggy-bank",
    tone: "green",
    freshness: "Synced 12 min ago",
  },
  account_sapphire: {
    type: "Credit card",
    icon: "ph-credit-card",
    tone: "blue",
    freshness: "Synced 18 min ago",
  },
  account_brokerage: {
    type: "Investment",
    icon: "ph-chart-line-up",
    tone: "black",
    freshness: "Synced 2 hr ago",
  },
  account_roth: {
    type: "Investment",
    icon: "ph-chart-line-up",
    tone: "black",
    freshness: "Synced 2 hr ago",
  },
  account_401k: {
    type: "Investment",
    icon: "ph-briefcase",
    tone: "blue",
    freshness: "Synced yesterday",
  },
  account_personal_loan: {
    type: "Personal loan",
    icon: "ph-receipt",
    tone: "neutral",
    freshness: "Synced 12 min ago",
  },
  account_amex: {
    type: "Credit card",
    icon: "ph-credit-card",
    tone: "blue",
    freshness: "Synced 24 min ago",
  },
});

export function demoAccountForWeb(account) {
  const presentation = accountPresentation[account.id] ?? {
    type:
      account.subtype === "credit_card"
        ? "Credit card"
        : account.type === "depository"
          ? "Bank account"
          : account.type === "investment"
            ? "Investment"
            : account.type ?? "Account",
    icon:
      account.subtype === "credit_card"
        ? "ph-credit-card"
        : "ph-bank",
    tone: "neutral",
    freshness: "Synced recently",
  };
  const balance = account.current_balance
    ? {
        ...account.current_balance,
        amount_minor: account.is_liability
          ? -Math.abs(account.current_balance.amount_minor)
          : account.current_balance.amount_minor,
      }
    : null;
  return {
    id: account.id,
    institution: account.institution_name,
    name: account.name,
    type: presentation.type,
    mask: account.mask,
    balance,
    available: account.available_balance
      ? { ...account.available_balance }
      : account.available_credit
        ? { ...account.available_credit }
        : null,
    creditLimit: account.credit_limit
      ? { ...account.credit_limit }
      : null,
    balanceGroup: account.balance_group,
    balanceGroupOverride:
      account.balance_group_override ?? null,
    icon: presentation.icon,
    tone: presentation.tone,
    freshness: presentation.freshness,
    syncedAt: account.freshness?.synced_at ?? null,
  };
}

const transactions = buildDefaultTransactions().map(
  demoTransactionForWeb,
);

const transactionRules = [
  {
    id: "cleanup_rule_demo_whole_foods",
    matcher: {
      field: "normalized_merchant",
      value: "Whole Foods Market",
      normalized_value: "whole foods market",
    },
    changes: {
      display_name: "Whole Foods Market",
      category_primary: "Groceries",
      tags: ["Business"],
    },
    enabled: true,
    matched_transaction_count: 1,
    updated_at: "2026-07-27T10:00:00.000Z",
  },
];

function compactDemoDate(value) {
  if (!value) return "Unknown";
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function demoRecurringForWeb(stream) {
  return {
    id: stream.id,
    name: stream.service,
    cadence:
      stream.cadence === "monthly" ? "Monthly" : stream.cadence,
    accountId: stream.account?.id ?? null,
    account:
      stream.account?.id === "account_sapphire"
        ? "Sapphire card"
        : stream.account?.name ?? "Unknown account",
    amount: {
      ...(stream.expected_amount ?? stream.monthly_equivalent),
    },
    annual: { ...stream.annual_equivalent },
    icon: stream.icon ?? "ph-repeat",
    state: stream.status ?? "active",
    next: compactDemoDate(stream.next_estimated_date),
    type: stream.type,
    category: stream.category ?? null,
    detectedType: stream.detected_type ?? stream.type,
    classificationSignals: {
      ...(stream.classification_signals ?? {}),
    },
    transactions: (stream.transactions ?? []).map((transaction) => ({
      ...transaction,
      date: compactDemoDate(transaction.date),
      amount: { ...transaction.amount },
    })),
  };
}

export function demoRecurringSections(streams) {
  const presented = streams.map(demoRecurringForWeb);
  return {
    subscriptions: presented.filter(
      (stream) => stream.type === "subscription",
    ),
    bills: presented.filter((stream) => stream.type === "bill"),
    frequentSpending: presented.filter(
      (stream) => stream.type === "frequent_spending",
    ),
  };
}

const {
  subscriptions,
  bills,
  frequentSpending,
} = demoRecurringSections(buildDefaultRecurringPayments());

const accounts = buildDefaultAccounts().map(demoAccountForWeb);

const manualAssets = [
  {
    id: "asset_001",
    name: "2024 vehicle",
    assetType: "vehicle",
    description: "Current private-party estimate",
    value: usd(3_471_461),
    currencyCode: "USD",
    valuedOn: "2026-07-26",
    active: true,
  },
];

const rawInsights = {
  weekly: [
    {
      id: DEMO_IDS.insights.weeklyDining,
      family: "weekly",
      typeKey: "spend_less",
      type: "Spend less",
      severity: "attention",
      icon: "ph-trend-up",
      title: "Spending rose in Dining",
      copy: "You spent $126 more across 9 purchases. Delivery made up most of the increase.",
      metric: "+$126",
      timeframe: "Jul 19–25 vs Jul 12–18",
      state: "active",
      actions: [{ type: "review", label: "Review dining", web_url: "/transactions?category=Dining" }],
    },
    {
      id: DEMO_IDS.insights.weeklyCoffee,
      family: "weekly",
      typeKey: "better_habits",
      type: "Better habits",
      severity: "neutral",
      icon: "ph-repeat",
      title: "More frequent spending at coffee shops",
      copy: "Five small stops landed at $46—twice last week. Fewer convenience stops would erase the pattern.",
      metric: "5 stops",
      timeframe: "Jul 19–25 vs Jul 12–18",
      state: "active",
      actions: [{ type: "review", label: "See purchases", web_url: "/transactions?category=Dining" }],
    },
    {
      id: DEMO_IDS.insights.weeklyTravel,
      family: "weekly",
      typeKey: "needs_review",
      type: "Needs review",
      severity: "attention",
      icon: "ph-magnifying-glass",
      title: "Delta Air Lines charge needs a look",
      copy: "A $486 Delta purchase drove 92% of the travel increase. Mark it expected if it belongs.",
      metric: "$486",
      timeframe: "Jul 19–25 vs Jul 12–18",
      state: "active",
      actions: [
        {
          type: "review",
          label: "Review charge",
          web_url: `/transactions?transaction=${DEMO_IDS.transactions.delta}`,
        },
      ],
    },
  ],
  investments: [
    {
      id: "ins_inv_001",
      family: "investments",
      typeKey: "performance",
      type: "Performance",
      severity: "good",
      icon: "ph-chart-line-up",
      title: "Portfolio gained 1.8% this month",
      copy: "Estimated performance excludes $1,200 in contributions. VTI drove most of the gain.",
      metric: "+$2,191",
      timeframe: "Last 1 month",
      state: "active",
      actions: [{ type: "review", label: "View performance", web_url: "/portfolio?period=1m" }],
    },
    {
      id: "ins_inv_002",
      family: "investments",
      typeKey: "concentration",
      type: "Concentration",
      severity: "attention",
      icon: "ph-chart-donut",
      title: "VTI is a concentrated position",
      copy: "VTI is 31% of the portfolio, above your 25% marker. This is descriptive, not a trade recommendation.",
      metric: "31%",
      timeframe: "Last 1 month",
      state: "active",
      actions: [{ type: "review", label: "View allocation", web_url: "/portfolio?holding=VTI" }],
    },
  ],
  subscriptions: [
    {
      id: DEMO_IDS.insights.subscriptionDuplicate,
      family: "subscriptions",
      typeKey: "possible_duplicate",
      type: "Possible duplicate",
      severity: "attention",
      icon: "ph-copy",
      title: "Possible duplicate Apple subscriptions",
      copy: "Apple Services and iCloud+ bill the same card on separate dates. Together they cost $38 per month.",
      metric: "$38/mo",
      timeframe: "Current active subscriptions",
      state: "active",
      metrics: { service: "Apple" },
      evidence: [
        {
          entity_type: "recurring",
          entity_id: DEMO_IDS.recurring.appleServices,
          label: "Apple Services",
          web_url: `/recurring?item=${DEMO_IDS.recurring.appleServices}`,
        },
        {
          entity_type: "recurring",
          entity_id: DEMO_IDS.recurring.iCloud,
          label: "iCloud+",
          web_url: `/recurring?item=${DEMO_IDS.recurring.iCloud}`,
        },
      ],
      actions: [
        {
          type: "confirm",
          label: "Compare charges",
          web_url: `/insights?finding=${DEMO_IDS.insights.subscriptionDuplicate}`,
        },
      ],
    },
    {
      id: DEMO_IDS.insights.subscriptionExpensive,
      family: "subscriptions",
      typeKey: "expensive",
      type: "Expensive",
      severity: "neutral",
      icon: "ph-receipt",
      title: "Google Workspace is an expensive subscription",
      copy: "At $85.64 a month, it represents 36% of recurring subscription spend.",
      metric: "$1,028/yr",
      timeframe: "Current active subscriptions",
      state: "active",
      metrics: { service: "Google Workspace" },
      evidence: [
        {
          entity_type: "recurring",
          entity_id: DEMO_IDS.recurring.googleWorkspace,
          label: "Google Workspace",
          web_url: `/recurring?item=${DEMO_IDS.recurring.googleWorkspace}`,
        },
      ],
      actions: [
        {
          type: "review",
          label: "Review subscription",
          web_url: `/recurring?item=${DEMO_IDS.recurring.googleWorkspace}`,
        },
      ],
    },
  ],
};

const insights = presentInsights(rawInsights);
const archivedInsights = presentInsights({
  weekly: [
    {
      ...rawInsights.weekly[0],
      id: "ins_week_archive_001",
      state: "archived",
      timeframe: "Jul 12–18 vs Jul 5–11",
      copy: "Dining was $84 higher than the prior week. You archived this after reviewing the purchases.",
    },
  ],
  investments: [],
  subscriptions: [
    {
      ...rawInsights.subscriptions[0],
      id: "ins_sub_archive_001",
      state: "bad",
      timeframe: "Reviewed Jul 18",
      copy: "You marked this duplicate-subscription check as a bad insight.",
    },
  ],
});

const categories = [
  spendingCategory({ label: "Housing", amountMinor: 145_000, previousMinor: 155_000, percent: 35, count: 2, color: "#2fa94f", icon: "ph-house" }),
  spendingCategory({ label: "Groceries", amountMinor: 68_430, previousMinor: 63_000, percent: 17, count: 8, color: "#5cc576", icon: "ph-basket" }),
  spendingCategory({ label: "Dining", amountMinor: 52_146, previousMinor: 37_800, percent: 13, count: 9, color: "#91d8a5", icon: "ph-fork-knife" }),
  spendingCategory({ label: "Shopping", amountMinor: 47_890, previousMinor: 53_000, percent: 12, count: 6, color: "#8abde9", icon: "ph-shopping-bag" }),
  spendingCategory({ label: "Travel", amountMinor: 41_205, previousMinor: 80_000, percent: 10, count: 2, color: "#438bd7", icon: "ph-airplane-tilt" }),
  spendingCategory({ label: "Utilities", amountMinor: 33_913, previousMinor: 34_000, percent: 8, count: 4, color: "#2764ae", icon: "ph-lightning" }),
  spendingCategory({ label: "Fees & Interest", amountMinor: 11_600, previousMinor: 12_200, percent: 3, count: 2, color: "#a7a7a7", icon: "ph-coins" }),
  spendingCategory({ label: "Other", amountMinor: 12_500, previousMinor: 25_500, percent: 2, count: 5, color: "#666666", icon: "ph-dots-three" }),
];

export function demoHoldingForWeb(holding) {
  const value =
    holding.value ??
    (Number.isSafeInteger(holding.value_minor)
      ? usd(holding.value_minor)
      : null);
  const costBasis =
    holding.cost_basis ??
    (Number.isSafeInteger(holding.cost_basis_minor)
      ? usd(holding.cost_basis_minor)
      : null);
  const price =
    holding.price ??
    (Number.isSafeInteger(holding.price_minor)
      ? usd(holding.price_minor)
      : null);
  const allocation =
    Number.isSafeInteger(holding.allocation_basis_points)
      ? holding.allocation_basis_points / 100
      : Number(holding.allocation ?? 0);
  return {
    id: holding.id,
    securityId: holding.security_id,
    symbol:
      holding.display_symbol ??
      holding.symbol ??
      holding.ticker_symbol,
    name: holding.display_name ?? holding.name,
    account: holding.account_name ?? holding.account ?? null,
    securityType: holding.security_type,
    value,
    costBasis,
    price,
    priceAsOf: holding.price_as_of ?? "2026-07-26",
    allocation,
    change: Number(holding.change_percent ?? 0),
    shares:
      holding.shares_label ??
      (Number.isFinite(holding.quantity)
        ? String(holding.quantity)
        : "—"),
    scope:
      holding.scope ??
      (holding.balance_group === "retirement"
        ? "retirement"
        : "trading"),
  };
}

const accountNamesById = new Map(
  buildDefaultAccounts().map((account) => [account.id, account.name]),
);
const canonicalHoldings = buildDefaultPortfolioHoldings().map((holding) =>
  demoHoldingForWeb({
    ...holding,
    account_name: accountNamesById.get(holding.account_id) ?? null,
    balance_group:
      holding.account_id === "account_brokerage"
        ? "taxable_investment"
        : "retirement",
  }),
);
const canonicalPortfolioMinor = canonicalHoldings.reduce(
  (sum, holding) => sum + holding.value.amount_minor,
  0,
);
const holdings = canonicalHoldings.map((holding) => ({
  ...holding,
  allocation:
    canonicalPortfolioMinor === 0
      ? 0
      : Math.round(
          (holding.value.amount_minor / canonicalPortfolioMinor) *
            10_000,
        ) / 100,
}));

function buildDemoWebFixtures() {
  return {
    transactions,
    transactionRules,
    subscriptions,
    bills,
    frequentSpending,
    accounts,
    manualAssets,
    categories,
    holdings,
    insights,
    archivedInsights,
  };
}

export function buildDemoModel({ scenario = "default" } = {}) {
  const stressTransactions =
    scenario === "ux-stress"
      ? buildUxStressTransactions().map(demoTransactionForWeb)
      : [];
  const modelTransactions = [...transactions, ...stressTransactions];
  const modelAccounts =
    scenario === "ux-stress"
      ? [...accounts, demoAccountForWeb(uxStressAccount())]
      : accounts;
  const accountTotal = (balanceGroup) =>
    modelAccounts
      .filter((account) => account.balanceGroup === balanceGroup)
      .reduce(
        (sum, account) =>
          sum + Math.abs(account.balance?.amount_minor ?? 0),
        0,
      );
  const cashMinor = accountTotal("cash");
  const taxableMinor = accountTotal("taxable_investment");
  const retirementMinor = accountTotal("retirement");
  const creditCardMinor = accountTotal("credit_card");
  const loanMinor = accountTotal("loan");
  const manualAssetMinor = manualAssets.reduce(
    (sum, asset) => sum + (asset.value?.amount_minor ?? 0),
    0,
  );
  const assetsMinor =
    cashMinor + taxableMinor + retirementMinor + manualAssetMinor;
  const liabilitiesMinor = creditCardMinor + loanMinor;
  const cashBalanceMinor = cashMinor + taxableMinor;
  const shortTermWorthMinor = cashBalanceMinor - creditCardMinor;
  const netWorthMinor = assetsMinor - liabilitiesMinor;
  const spendingDetails = {
    total: usd(412684),
    previousTotal: usd(460500),
    change: usd(-47816),
    trendDirection: "down",
    trendLabel: "10.4% less than the prior period",
    transactionCount: 38,
    averageTransaction: usd(10860),
    periodLabel: "Jul 1, 2026–Jul 26, 2026",
    previousPeriodLabel: "Jun 1, 2026–Jun 26, 2026",
    categories,
    seriesLabels: [
      "Jul 1",
      "Jul 4",
      "Jul 7",
      "Jul 10",
      "Jul 13",
      "Jul 16",
      "Jul 19",
      "Jul 22",
      "Jul 24",
      "Jul 26",
    ],
    seriesValues: [
      25600,
      43320,
      15650,
      87300,
      32250,
      48200,
      67940,
      23150,
      40100,
      29174,
    ],
  };
  const currentWealth = {
    cash: cashBalanceMinor,
    short_term: shortTermWorthMinor,
    retirement: retirementMinor,
    net_worth: netWorthMinor,
  };
  const buildHistory = (labels, ratios, period) => ({
    labels,
    period,
    series: Object.fromEntries(
      Object.entries(currentWealth).map(([name, current]) => [
        name,
        ratios.map((ratio, index) =>
          index === ratios.length - 1
            ? current
            : Math.round(current * ratio),
        ),
      ]),
    ),
  });
  const dashboardHistories = {
    "1w": buildHistory(
      ["Jul 19", "Jul 20", "Jul 21", "Jul 22", "Jul 23", "Jul 24", "Jul 25", "Jul 26"],
      [0.994, 0.996, 0.995, 0.997, 0.998, 0.999, 0.998, 1],
      {
        name: "1w",
        label: "Last week",
        comparison_label: "over the last week",
        start_on: "2026-07-19",
        end_on: "2026-07-27",
      },
    ),
    "1m": buildHistory(
      ["Jun 26", "Jul 1", "Jul 6", "Jul 11", "Jul 16", "Jul 21", "Jul 26"],
      [0.975, 0.981, 0.979, 0.988, 0.992, 0.997, 1],
      {
        name: "1m",
        label: "Last month",
        comparison_label: "over the last month",
        start_on: "2026-06-26",
        end_on: "2026-07-27",
      },
    ),
    "1y": buildHistory(
      ["Jul 2025", "Sep 2025", "Nov 2025", "Jan 2026", "Mar 2026", "May 2026", "Jul 2026"],
      [0.88, 0.9, 0.915, 0.937, 0.954, 0.982, 1],
      {
        name: "1y",
        label: "Last year",
        comparison_label: "over the last year",
        start_on: "2025-07-26",
        end_on: "2026-07-27",
      },
    ),
    all: buildHistory(
      ["Jan 2025", "Apr 2025", "Jul 2025", "Oct 2025", "Jan 2026", "Apr 2026", "Jul 2026"],
      [0.81, 0.835, 0.88, 0.91, 0.937, 0.967, 1],
      {
        name: "all",
        label: "All history",
        comparison_label: "since Jan 1, 2025",
        start_on: "2025-01-01",
        end_on: "2026-07-27",
      },
    ),
  };
  const creditAccounts = accounts.filter(
    (account) => account.balanceGroup === "credit_card",
  );
  const buildCreditHistory = (
    timestamps,
    balancesByCard,
    period,
  ) => {
    const cards = creditAccounts.map((account, cardIndex) => {
      const balanceValues = balancesByCard[cardIndex];
      const limitMinor = account.creditLimit.amount_minor;
      const currentBalanceMinor = balanceValues.at(-1);
      return {
        id: account.id,
        institution: account.institution,
        name: account.name,
        mask: account.mask,
        current_balance: usd(currentBalanceMinor),
        balance_owed: usd(currentBalanceMinor),
        credit_limit: account.creditLimit,
        available_credit: usd(limitMinor - currentBalanceMinor),
        utilization_basis_points: Math.round(
          (currentBalanceMinor / limitMinor) * 10_000,
        ),
        over_limit: currentBalanceMinor > limitMinor,
        series: timestamps.map((timestamp, index) => ({
          timestamp,
          balance_owed: usd(balanceValues[index]),
          credit_limit: account.creditLimit,
          utilization_basis_points: Math.round(
            (balanceValues[index] / limitMinor) * 10_000,
          ),
          partial: false,
        })),
      };
    });
    const totalLimitMinor = cards.reduce(
      (sum, card) => sum + card.credit_limit.amount_minor,
      0,
    );
    const series = timestamps.map((timestamp, index) => {
      const balanceMinor = balancesByCard.reduce(
        (sum, values) => sum + values[index],
        0,
      );
      return {
        timestamp,
        balance_owed: usd(balanceMinor),
        total_credit_limit: usd(totalLimitMinor),
        utilization_basis_points: Math.round(
          (balanceMinor / totalLimitMinor) * 10_000,
        ),
        partial: false,
      };
    });
    const currentBalanceMinor = series.at(-1).balance_owed.amount_minor;
    return {
      period,
      summary: {
        card_count: cards.length,
        total_balance_owed: usd(currentBalanceMinor),
        total_credit_limit: usd(totalLimitMinor),
        available_credit: usd(totalLimitMinor - currentBalanceMinor),
        utilization_basis_points:
          series.at(-1).utilization_basis_points,
        utilization_covered_card_count: cards.length,
        missing_limit_card_count: 0,
        missing_balance_card_count: 0,
        excluded_from_usd_total_count: 0,
      },
      cards,
      series,
      partial: false,
      warnings: [],
    };
  };
  const creditHistories = {
    "1w": buildCreditHistory(
      [
        "2026-07-19",
        "2026-07-20",
        "2026-07-21",
        "2026-07-22",
        "2026-07-23",
        "2026-07-24",
        "2026-07-25",
        "2026-07-26",
      ],
      [
        [155000, 162000, 170000, 181000, 176000, 185000, 190000, 193240],
        [62000, 65000, 69000, 72000, 76000, 80000, 85000, 88223],
      ],
      {
        name: "1w",
        label: "Last week",
        start_on: "2026-07-19",
        end_on: "2026-07-27",
      },
    ),
    "1m": buildCreditHistory(
      [
        "2026-06-26",
        "2026-07-01",
        "2026-07-06",
        "2026-07-11",
        "2026-07-16",
        "2026-07-21",
        "2026-07-26",
      ],
      [
        [248000, 220000, 198000, 176000, 165000, 182000, 193240],
        [103000, 92000, 81000, 72000, 75000, 82000, 88223],
      ],
      {
        name: "1m",
        label: "Last month",
        start_on: "2026-06-26",
        end_on: "2026-07-27",
      },
    ),
    "1y": buildCreditHistory(
      [
        "2025-07-26",
        "2025-09-26",
        "2025-11-26",
        "2026-01-26",
        "2026-03-26",
        "2026-05-26",
        "2026-07-26",
      ],
      [
        [98000, 132000, 176000, 220000, 145000, 168000, 193240],
        [45000, 58000, 94000, 112000, 68000, 74000, 88223],
      ],
      {
        name: "1y",
        label: "Last year",
        start_on: "2025-07-26",
        end_on: "2026-07-27",
      },
    ),
    all: buildCreditHistory(
      [
        "2025-01-01",
        "2025-04-01",
        "2025-07-01",
        "2025-10-01",
        "2026-01-01",
        "2026-04-01",
        "2026-07-26",
      ],
      [
        [120000, 85000, 98000, 176000, 145000, 168000, 193240],
        [60000, 42000, 45000, 94000, 68000, 74000, 88223],
      ],
      {
        name: "all",
        label: "All history",
        start_on: "2025-01-01",
        end_on: "2026-07-27",
      },
    ),
  };
  const defaultDashboardHistory = dashboardHistories["1m"];
  const defaultCreditHistory = creditHistories["1m"];
  const defaultCreditScoreData = buildCreditScoreSummary({
    members: [
      { id: "demo-user", display_name: "Francis" },
      { id: "demo-partner", display_name: "Household member" },
    ],
    sources: [
      {
        id: "score_source_amex",
        user_id: "demo-user",
        label: "American Express",
        bureau: "Experian",
        model: "FICO Score 8",
      },
      {
        id: "score_source_credit_karma",
        user_id: "demo-user",
        label: "Credit Karma–TransUnion",
        bureau: "TransUnion",
        model: "VantageScore 3.0",
      },
      {
        id: "score_source_partner",
        user_id: "demo-partner",
        label: "Experian",
        bureau: "Experian",
        model: "FICO Score 8",
      },
    ],
    observations: [
      {
        id: "score_observation_1",
        source_id: "score_source_amex",
        observed_on: "2026-07-20",
        score: 746,
      },
      {
        id: "score_observation_2",
        source_id: "score_source_credit_karma",
        observed_on: "2026-07-18",
        score: 738,
      },
      {
        id: "score_observation_3",
        source_id: "score_source_partner",
        observed_on: "2026-07-10",
        score: 765,
      },
    ],
    currentOn: "2026-07-26",
    period: "1y",
    currentUserId: "demo-user",
  });
  const wealthSeries = defaultDashboardHistory.series;
  const wealthLabels = defaultDashboardHistory.labels;
  return {
    viewer: { id: "demo-user", name: "Francis", email: "francis@example.com", initials: "FS", is_admin: true },
    freshness: "Updated 12 minutes ago",
    overview: {
      netWorth: usd(netWorthMinor),
      netWorthChange: usd(219100),
      netWorthChangePercent: 1.2,
      assets: usd(assetsMinor),
      liabilities: usd(liabilitiesMinor),
      cash: usd(cashMinor),
      cashBalance: usd(cashBalanceMinor),
      shortTermWorth: usd(shortTermWorthMinor),
      taxableInvestments: usd(taxableMinor),
      retirementInvestments: usd(retirementMinor),
      manualAssetValue: usd(manualAssetMinor),
      creditCardLiabilities: usd(creditCardMinor),
      loanLiabilities: usd(loanMinor),
      portfolio: usd(taxableMinor + retirementMinor),
      spending: usd(412684),
      income: usd(930000),
      cashFlow: usd(517316),
      subscriptions: usd(23864),
    },
    categories,
    spendingDetails,
    transactions: modelTransactions,
    transactionRules,
    subscriptions,
    bills,
    frequentSpending,
    accounts: modelAccounts,
    manualAssets,
    holdings,
    insights,
    archivedInsights,
    dashboardHistories,
    creditHistories,
    creditData: defaultCreditHistory,
    creditScoreData: defaultCreditScoreData,
    creditScorePresets: CREDIT_SCORE_PRESETS,
    dashboardPeriod: defaultDashboardHistory.period,
    netWorthSeries: wealthSeries.net_worth,
    netWorthLabels: wealthLabels,
    wealthSeries,
    wealthLabels,
    currentPeriodLabel: "July 2026",
    spendingMoMLabel: "-10.4% MoM",
    spendingTrendDirection: "down",
    cashFlowSeries: {
      labels: ["Feb", "Mar", "Apr", "May", "Jun", "Jul"],
      income: [850000, 930000, 850000, 1010000, 930000, 930000],
      spending: [498200, 441900, 523400, 479100, 460500, 412684],
    },
    allocation: holdings.map((holding) => ({ label: holding.symbol, value: holding.allocation })),
    searchSeed: [
      ...modelTransactions.map((item) => ({ entityType: "transaction", group: "Transactions", title: item.merchant, meta: `${item.category} · ${item.account}`, url: `/transactions?transaction=${item.id}`, icon: item.icon })),
      ...modelAccounts.map((item) => ({ entityType: "account", group: "Accounts", title: item.name, meta: `${item.institution} · ${item.type}`, url: `/accounts#account-${encodeURIComponent(item.id)}`, icon: item.icon })),
      ...subscriptions.map((item) => ({ entityType: "recurring", group: "Recurring", title: item.name, meta: `${item.cadence} · ${item.account}`, url: `/recurring?item=${item.id}`, icon: item.icon })),
      ...manualAssets.map((item) => ({ entityType: "manual_asset", group: "Assets", title: item.name, meta: `Manual ${item.assetType} · valued ${item.valuedOn}`, url: `/accounts#asset-${encodeURIComponent(item.id)}`, icon: "ph-car" })),
      ...Object.values(insights).flat().map((item) => ({ entityType: "insight", group: "Insights", title: item.title, meta: item.type, searchText: `${item.title} ${item.copy} ${item.type} ${item.family}`, url: `/insights?finding=${encodeURIComponent(item.id)}`, icon: item.icon })),
    ],
  };
}
