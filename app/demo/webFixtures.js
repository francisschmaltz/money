import { presentInsightForWeb } from "../services/insightPresentation.js";
import {
  buildCreditScoreSummary,
  CREDIT_SCORE_PRESETS,
} from "../services/creditScoreTracking.js";
import { DEMO_IDS } from "./fixtureIds.js";

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

const transactions = [
  {
    id: DEMO_IDS.transactions.wholeFoods,
    date: "Jul 25, 2026",
    dateIso: "2026-07-25",
    dateTime: "2026-07-25T20:34:00.000Z",
    merchant: "Whole Foods Market",
    rawMerchant: "WHOLE FOODS MKT #1024",
    rawName: "WHOLE FOODS MKT #1024",
    note: "Dinner supplies for the family visit",
    noteVersion: 1,
    noteUpdatedBy: "demo-user",
    noteUpdatedAt: "2026-07-25T21:10:00.000Z",
    category: "Groceries",
    tags: ["Household"],
    account: "Everyday checking",
    amount: usd(-13_842),
    icon: "ph-shopping-cart",
    status: "posted",
  },
  {
    id: DEMO_IDS.transactions.conEdison,
    date: "2026-07-25",
    merchant: "Con Edison",
    category: "Utilities",
    account: "Everyday checking",
    amount: usd(-18_419),
    icon: "ph-lightning",
    status: "pending",
  },
  {
    id: DEMO_IDS.transactions.appleServices,
    date: "Jul 24, 2026",
    dateIso: "2026-07-24",
    dateTime: null,
    merchant: "Apple Services",
    category: "Subscriptions",
    account: "Sapphire card",
    amount: usd(-2_803),
    icon: "ph-device-mobile",
    status: "posted",
  },
  {
    id: "txn_004",
    date: "2026-07-24",
    merchant: "Blue Bottle Coffee",
    category: "Dining",
    account: "Sapphire card",
    amount: usd(-1_275),
    icon: "ph-coffee",
    status: "posted",
  },
  {
    id: DEMO_IDS.transactions.payroll,
    date: "2026-07-23",
    merchant: "Acme Payroll",
    category: "Income",
    account: "Everyday checking",
    amount: usd(465_000),
    icon: "ph-buildings",
    status: "posted",
  },
  {
    id: "txn_006",
    date: "2026-07-22",
    merchant: "MTA OMNY",
    category: "Transportation",
    account: "Sapphire card",
    amount: usd(-3_400),
    icon: "ph-train",
    status: "posted",
  },
  {
    id: "txn_007",
    date: "2026-07-21",
    merchant: "Fidelis Care",
    category: "Bills",
    account: "Everyday checking",
    amount: usd(-40_804),
    icon: "ph-heartbeat",
    status: "posted",
  },
  {
    id: DEMO_IDS.transactions.delta,
    date: "2026-07-20",
    merchant: "Delta Air Lines",
    category: "Travel",
    account: "Sapphire card",
    amount: usd(-48_620),
    icon: "ph-airplane-tilt",
    status: "posted",
  },
  {
    id: "txn_009",
    date: "2026-07-19",
    merchant: "Target",
    category: "Shopping",
    account: "Sapphire card",
    amount: usd(-8_639),
    icon: "ph-shopping-bag",
    status: "posted",
  },
  {
    id: DEMO_IDS.transactions.googleWorkspace,
    date: "2026-07-18",
    merchant: "Google Workspace",
    category: "Subscriptions",
    account: "Everyday checking",
    amount: usd(-8_564),
    icon: "ph-browser",
    status: "posted",
  },
  {
    id: "txn_011",
    date: "2026-07-18",
    merchant: "Seacomm Transfer",
    category: "Transfer",
    account: "High-yield savings",
    amount: usd(60_000),
    icon: "ph-arrows-left-right",
    status: "posted",
  },
  {
    id: "txn_012",
    date: "2026-07-17",
    merchant: "Trader Joe's",
    category: "Groceries",
    account: "Everyday checking",
    amount: usd(-7_694),
    icon: "ph-basket",
    status: "posted",
  },
  {
    id: "txn_013",
    date: "2026-07-16",
    merchant: "Seacomm Overdraft Fee",
    category: "Fees & Interest",
    account: "Everyday checking",
    amount: usd(-3_500),
    icon: "ph-coins",
    status: "posted",
  },
  {
    id: "txn_014",
    date: "2026-07-15",
    merchant: "Personal Loan Interest",
    category: "Fees & Interest",
    account: "Everyday checking",
    amount: usd(-8_100),
    icon: "ph-coins",
    status: "posted",
  },
  {
    id: "txn_015",
    date: "2026-07-14",
    merchant: "Whole Foods Mkt 117",
    rawMerchant: "WHOLEFDS MKT 117",
    rawName: "WHOLEFDS MKT 117 BROOKLYN",
    category: "Groceries",
    tags: [],
    account: "Sapphire card",
    amount: usd(-6_249),
    icon: "ph-shopping-cart",
    status: "posted",
  },
  {
    id: "txn_016",
    date: "2026-07-09",
    merchant: "Whole Foods Market",
    rawMerchant: "WHOLE FOODS MARKET",
    rawName: "WHOLE FOODS MARKET 1024",
    category: "Groceries",
    tags: ["Food"],
    account: "Everyday checking",
    amount: usd(-9_184),
    icon: "ph-shopping-cart",
    status: "posted",
  },
];

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

const subscriptions = [
  {
    id: DEMO_IDS.recurring.googleWorkspace,
    name: "Google Workspace",
    cadence: "Monthly",
    account: "Everyday checking",
    amount: usd(8_564),
    annual: usd(102_768),
    icon: "ph-browser",
    state: "active",
    next: "Aug 18",
    type: "subscription",
    category: "Software & services",
    detectedType: "subscription",
    classificationSignals: {
      subscription_signal: true,
      occurrence_count: 7,
      interval_fit_basis_points: 10_000,
      amount_variation_basis_points: 0,
      classification_confidence_basis_points: 9_900,
    },
    transactions: [
      {
        id: DEMO_IDS.transactions.googleWorkspace,
        merchant: "Google Workspace",
        date: "Jul 18, 2026",
        amount: usd(-8_564),
      },
    ],
  },
  {
    id: DEMO_IDS.recurring.adobe,
    name: "Adobe Creative Cloud",
    cadence: "Monthly",
    account: "Sapphire card",
    amount: usd(6_999),
    annual: usd(83_988),
    icon: "ph-bezier-curve",
    state: "active",
    next: "Aug 3",
    category: "Software & services",
  },
  {
    id: DEMO_IDS.recurring.appleServices,
    name: "Apple Services",
    cadence: "Monthly",
    account: "Sapphire card",
    amount: usd(2_803),
    annual: usd(33_636),
    icon: "ph-device-mobile",
    state: "active",
    next: "Aug 24",
    category: "Software & services",
  },
  {
    id: DEMO_IDS.recurring.squarespace,
    name: "Squarespace Website",
    cadence: "Monthly",
    account: "Everyday checking",
    amount: usd(2_500),
    annual: usd(30_000),
    icon: "ph-squares-four",
    state: "active",
    next: "Aug 8",
    category: "Software & services",
  },
  {
    id: DEMO_IDS.recurring.disneyPlus,
    name: "Disney+",
    cadence: "Monthly",
    account: "Sapphire card",
    amount: usd(1_999),
    annual: usd(23_988),
    icon: "ph-television",
    state: "active",
    next: "Aug 11",
    category: "Entertainment",
  },
  {
    id: DEMO_IDS.recurring.iCloud,
    name: "iCloud+",
    cadence: "Monthly",
    account: "Sapphire card",
    amount: usd(999),
    annual: usd(11_988),
    icon: "ph-cloud",
    state: "active",
    next: "Aug 14",
    category: "Software & services",
  },
];

const bills = [
  {
    id: DEMO_IDS.recurring.fidelis,
    name: "Fidelis Care",
    cadence: "Monthly",
    account: "Everyday checking",
    amount: usd(40_804),
    icon: "ph-heartbeat",
    next: "Aug 21",
    category: "Health",
  },
  {
    id: DEMO_IDS.recurring.conEdison,
    name: "Con Edison",
    cadence: "Monthly",
    account: "Everyday checking",
    amount: usd(18_419),
    icon: "ph-lightning",
    next: "Aug 25",
    category: "Utilities",
  },
  {
    id: DEMO_IDS.recurring.verizonFios,
    name: "Verizon Fios",
    cadence: "Monthly",
    account: "Sapphire card",
    amount: usd(8_999),
    icon: "ph-wifi-high",
    next: "Aug 9",
    category: "Utilities",
  },
  {
    id: DEMO_IDS.recurring.geico,
    name: "GEICO",
    cadence: "Monthly",
    account: "Everyday checking",
    amount: usd(14_622),
    icon: "ph-car",
    next: "Aug 15",
    category: "Insurance",
  },
];

const frequentSpending = [
  {
    id: DEMO_IDS.recurring.shell,
    name: "Shell Oil",
    cadence: "Monthly",
    account: "Sapphire card",
    amount: usd(4_820),
    annual: usd(57_840),
    icon: "ph-gas-pump",
    state: "active",
    next: "Unknown",
    type: "frequent_spending",
    category: "Transportation",
    detectedType: "frequent_spending",
    classificationSignals: {
      hard_negative: true,
      occurrence_count: 4,
      interval_fit_basis_points: 8_000,
      amount_variation_basis_points: 900,
      classification_confidence_basis_points: 9_000,
    },
    transactions: [],
  },
];

const accounts = [
  { id: "acc_001", institution: "Seacomm Federal Credit Union", name: "Everyday checking", type: "Checking", mask: "4821", balance: usd(845_329), available: usd(815_329), balanceGroup: "cash", balanceGroupOverride: null, icon: "ph-bank", tone: "green", freshness: "Synced 12 min ago" },
  { id: "acc_002", institution: "Seacomm Federal Credit Union", name: "High-yield savings", type: "Savings", mask: "1038", balance: usd(3_642_451), available: usd(3_642_451), balanceGroup: "cash", balanceGroupOverride: null, icon: "ph-piggy-bank", tone: "green", freshness: "Synced 12 min ago" },
  { id: "acc_003", institution: "Chase", name: "Sapphire Preferred", type: "Credit card", mask: "9204", balance: usd(-193_240), available: usd(506_760), creditLimit: usd(700_000), balanceGroup: "credit_card", balanceGroupOverride: null, icon: "ph-credit-card", tone: "blue", freshness: "Synced 18 min ago" },
  { id: "acc_004", institution: "Vanguard", name: "Brokerage", type: "Investment", mask: "7714", balance: usd(6_342_941), balanceGroup: "taxable_investment", balanceGroupOverride: null, icon: "ph-chart-line-up", tone: "black", freshness: "Synced 2 hr ago" },
  { id: "acc_005", institution: "Vanguard", name: "Roth IRA", type: "Investment", mask: "3009", balance: usd(2_694_508), balanceGroup: "retirement", balanceGroupOverride: null, icon: "ph-chart-line-up", tone: "black", freshness: "Synced 2 hr ago" },
  { id: "acc_006", institution: "Fidelity", name: "401(k)", type: "Investment", mask: "2881", balance: usd(3_330_100), balanceGroup: "retirement", balanceGroupOverride: null, icon: "ph-briefcase", tone: "blue", freshness: "Synced yesterday" },
  { id: "acc_007", institution: "Seacomm Federal Credit Union", name: "Personal loan", type: "Personal loan", mask: "6418", balance: usd(-1_618_327), balanceGroup: "loan", balanceGroupOverride: null, icon: "ph-receipt", tone: "neutral", freshness: "Synced 12 min ago" },
  { id: "acc_008", institution: "American Express", name: "Blue Cash Preferred", type: "Credit card", mask: "1184", balance: usd(-88_223), available: usd(411_777), creditLimit: usd(500_000), balanceGroup: "credit_card", balanceGroupOverride: null, icon: "ph-credit-card", tone: "blue", freshness: "Synced 24 min ago" },
];

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

const holdings = [
  { id: DEMO_IDS.holdings.vti, securityId: "security_vti", symbol: "VTI", name: "Vanguard Total Stock Market ETF", account: "Brokerage", securityType: "equity", value: usd(3_827_442), costBasis: usd(3_050_400), price: usd(258_262), priceAsOf: "2026-07-26", allocation: 31, change: 2.4, shares: "14.82", scope: "trading" },
  { id: "holding_vxus", securityId: "security_vxus", symbol: "VXUS", name: "Vanguard Total International Stock ETF", account: "Brokerage", securityType: "equity", value: usd(2_455_810), costBasis: usd(1_943_400), price: usd(63_937), priceAsOf: "2026-07-26", allocation: 20, change: 1.1, shares: "38.41", scope: "trading" },
  { id: "holding_vmfxx", securityId: "security_vmfxx", symbol: "VMFXX", name: "Vanguard Federal Money Market", account: "Brokerage", securityType: "cash", value: usd(59_689), costBasis: usd(59_689), price: usd(100), priceAsOf: "2026-07-26", allocation: 0.5, change: 0.1, shares: "596.89", scope: "trading" },
  { id: "holding_bnd", securityId: "security_bnd", symbol: "BND", name: "Vanguard Total Bond Market ETF", account: "Roth IRA", securityType: "fixed_income", value: usd(2_061_884), costBasis: usd(1_640_000), price: usd(73_770), priceAsOf: "2026-07-26", allocation: 17, change: -0.3, shares: "27.95", scope: "retirement" },
  { id: "holding_aapl", securityId: "security_aapl", symbol: "AAPL", name: "Apple Inc.", account: "Roth IRA", securityType: "equity", value: usd(1_790_441), costBasis: usd(1_435_000), price: usd(211_636), priceAsOf: "2026-07-26", allocation: 14, change: 3.8, shares: "8.46", scope: "retirement" },
  { id: "holding_target", securityId: "security_target", symbol: "Other", name: "Retirement target-date funds", account: "401(k)", securityType: "mixed", value: usd(2_172_283), costBasis: usd(1_745_400), price: null, priceAsOf: "2026-07-26", allocation: 17.5, change: 0.7, shares: "—", scope: "retirement" },
];

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

export function buildDemoModel() {
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
    cash: 10830721,
    short_term: 10549258,
    retirement: 6024608,
    net_worth: 18427000,
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
      netWorth: usd(18427000),
      netWorthChange: usd(219100),
      netWorthChangePercent: 1.2,
      assets: usd(20326790),
      liabilities: usd(1899790),
      cash: usd(4487780),
      cashBalance: usd(10830721),
      shortTermWorth: usd(10549258),
      taxableInvestments: usd(6342941),
      retirementInvestments: usd(6024608),
      manualAssetValue: usd(3471461),
      creditCardLiabilities: usd(281463),
      loanLiabilities: usd(1618327),
      portfolio: usd(12367549),
      spending: usd(412684),
      income: usd(930000),
      cashFlow: usd(517316),
      subscriptions: usd(23864),
    },
    categories,
    spendingDetails,
    transactions,
    transactionRules,
    subscriptions,
    bills,
    frequentSpending,
    accounts,
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
      ...transactions.map((item) => ({ entityType: "transaction", group: "Transactions", title: item.merchant, meta: `${item.category} · ${item.account}`, url: `/transactions?transaction=${item.id}`, icon: item.icon })),
      ...accounts.map((item) => ({ entityType: "account", group: "Accounts", title: item.name, meta: `${item.institution} · ${item.type}`, url: `/accounts#account-${encodeURIComponent(item.id)}`, icon: item.icon })),
      ...subscriptions.map((item) => ({ entityType: "recurring", group: "Recurring", title: item.name, meta: `${item.cadence} · ${item.account}`, url: `/recurring?item=${item.id}`, icon: item.icon })),
      ...manualAssets.map((item) => ({ entityType: "manual_asset", group: "Assets", title: item.name, meta: `Manual ${item.assetType} · valued ${item.valuedOn}`, url: `/accounts#asset-${encodeURIComponent(item.id)}`, icon: "ph-car" })),
      ...Object.values(insights).flat().map((item) => ({ entityType: "insight", group: "Insights", title: item.title, meta: item.type, searchText: `${item.title} ${item.copy} ${item.type} ${item.family}`, url: `/insights?finding=${encodeURIComponent(item.id)}`, icon: item.icon })),
    ],
  };
}
