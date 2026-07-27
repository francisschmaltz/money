import express from "express";
import { formatMinorMoney } from "../currency.js";
import { presentInsightForWeb } from "../services/insightPresentation.js";
import {
  buildCreditScoreSummary,
  CREDIT_SCORE_PRESETS,
} from "../services/creditScoreTracking.js";

const usd = (amountMinor) => ({ amount_minor: amountMinor, currency: "USD" });

function demoSpendingCategory({
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

const SEARCH_ENTITY_TYPES = new Set([
  "transaction",
  "account",
  "recurring",
  "insight",
  "manual_asset",
]);

const SEARCH_ENTITY_OPTIONS = Object.freeze([
  { value: "", label: "Everything" },
  { value: "transaction", label: "Transactions" },
  { value: "account", label: "Accounts" },
  { value: "recurring", label: "Recurring" },
  { value: "manual_asset", label: "Assets" },
  { value: "insight", label: "Insights" },
]);

const transactions = [
  { id: "txn_whole_foods", date: "2026-07-25", merchant: "Whole Foods Market", rawMerchant: "WHOLE FOODS MKT #1024", rawName: "WHOLE FOODS MKT #1024", category: "Groceries", tags: ["Household"], account: "Everyday checking", amount: usd(-13842), icon: "ph-shopping-cart", status: "posted" },
  { id: "txn_con_edison", date: "2026-07-25", merchant: "Con Edison", category: "Utilities", account: "Everyday checking", amount: usd(-18419), icon: "ph-lightning", status: "pending" },
  { id: "txn_apple_services", date: "2026-07-24", merchant: "Apple Services", category: "Subscriptions", account: "Sapphire card", amount: usd(-2803), icon: "ph-device-mobile", status: "posted" },
  { id: "txn_004", date: "2026-07-24", merchant: "Blue Bottle Coffee", category: "Dining", account: "Sapphire card", amount: usd(-1275), icon: "ph-coffee", status: "posted" },
  { id: "txn_payroll", date: "2026-07-23", merchant: "Acme Payroll", category: "Income", account: "Everyday checking", amount: usd(465000), icon: "ph-buildings", status: "posted" },
  { id: "txn_006", date: "2026-07-22", merchant: "MTA OMNY", category: "Transportation", account: "Sapphire card", amount: usd(-3400), icon: "ph-train", status: "posted" },
  { id: "txn_007", date: "2026-07-21", merchant: "Fidelis Care", category: "Bills", account: "Everyday checking", amount: usd(-40804), icon: "ph-heartbeat", status: "posted" },
  { id: "txn_008", date: "2026-07-20", merchant: "Delta Air Lines", category: "Travel", account: "Sapphire card", amount: usd(-48620), icon: "ph-airplane-tilt", status: "posted" },
  { id: "txn_009", date: "2026-07-19", merchant: "Target", category: "Shopping", account: "Sapphire card", amount: usd(-8639), icon: "ph-shopping-bag", status: "posted" },
  { id: "txn_010", date: "2026-07-18", merchant: "Google Workspace", category: "Subscriptions", account: "Everyday checking", amount: usd(-8564), icon: "ph-browser", status: "posted" },
  { id: "txn_011", date: "2026-07-18", merchant: "Seacomm Transfer", category: "Transfer", account: "High-yield savings", amount: usd(60000), icon: "ph-arrows-left-right", status: "posted" },
  { id: "txn_012", date: "2026-07-17", merchant: "Trader Joe's", category: "Groceries", account: "Everyday checking", amount: usd(-7694), icon: "ph-basket", status: "posted" },
  { id: "txn_013", date: "2026-07-16", merchant: "Seacomm Overdraft Fee", category: "Fees & Interest", account: "Everyday checking", amount: usd(-3500), icon: "ph-coins", status: "posted" },
  { id: "txn_014", date: "2026-07-15", merchant: "Personal Loan Interest", category: "Fees & Interest", account: "Everyday checking", amount: usd(-8100), icon: "ph-coins", status: "posted" },
  { id: "txn_015", date: "2026-07-14", merchant: "Whole Foods Mkt 117", rawMerchant: "WHOLEFDS MKT 117", rawName: "WHOLEFDS MKT 117 BROOKLYN", category: "Groceries", tags: [], account: "Sapphire card", amount: usd(-6249), icon: "ph-shopping-cart", status: "posted" },
  { id: "txn_016", date: "2026-07-09", merchant: "Whole Foods Market", rawMerchant: "WHOLE FOODS MARKET", rawName: "WHOLE FOODS MARKET 1024", category: "Groceries", tags: ["Food"], account: "Everyday checking", amount: usd(-9184), icon: "ph-shopping-cart", status: "posted" },
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
  { id: "rec_001", name: "Google Workspace", cadence: "Monthly", account: "Everyday checking", amount: usd(8564), annual: usd(102768), icon: "ph-browser", state: "active", next: "Aug 18" },
  { id: "rec_002", name: "Adobe Creative Cloud", cadence: "Monthly", account: "Sapphire card", amount: usd(6999), annual: usd(83988), icon: "ph-bezier-curve", state: "active", next: "Aug 3" },
  { id: "rec_003", name: "Apple Services", cadence: "Monthly", account: "Sapphire card", amount: usd(2803), annual: usd(33636), icon: "ph-device-mobile", state: "active", next: "Aug 24" },
  { id: "rec_004", name: "Squarespace Website", cadence: "Monthly", account: "Everyday checking", amount: usd(2500), annual: usd(30000), icon: "ph-squares-four", state: "active", next: "Aug 8" },
  { id: "rec_005", name: "Disney+", cadence: "Monthly", account: "Sapphire card", amount: usd(1999), annual: usd(23988), icon: "ph-television", state: "active", next: "Aug 11" },
  { id: "rec_006", name: "iCloud+", cadence: "Monthly", account: "Sapphire card", amount: usd(999), annual: usd(11988), icon: "ph-cloud", state: "active", next: "Aug 14" },
];

const bills = [
  { id: "bill_001", name: "Fidelis Care", cadence: "Monthly", account: "Everyday checking", amount: usd(40804), icon: "ph-heartbeat", next: "Aug 21" },
  { id: "bill_002", name: "Con Edison", cadence: "Monthly", account: "Everyday checking", amount: usd(18419), icon: "ph-lightning", next: "Aug 25" },
  { id: "bill_003", name: "Verizon Fios", cadence: "Monthly", account: "Sapphire card", amount: usd(8999), icon: "ph-wifi-high", next: "Aug 9" },
  { id: "bill_004", name: "GEICO", cadence: "Monthly", account: "Everyday checking", amount: usd(14622), icon: "ph-car", next: "Aug 15" },
];

const accounts = [
  { id: "acc_001", institution: "Seacomm Federal Credit Union", name: "Everyday checking", type: "Checking", mask: "4821", balance: usd(845329), available: usd(815329), balanceGroup: "cash", balanceGroupOverride: null, icon: "ph-bank", tone: "green", freshness: "Synced 12 min ago" },
  { id: "acc_002", institution: "Seacomm Federal Credit Union", name: "High-yield savings", type: "Savings", mask: "1038", balance: usd(3642451), available: usd(3642451), balanceGroup: "cash", balanceGroupOverride: null, icon: "ph-piggy-bank", tone: "green", freshness: "Synced 12 min ago" },
  { id: "acc_003", institution: "Chase", name: "Sapphire Preferred", type: "Credit card", mask: "9204", balance: usd(-193240), available: usd(506760), creditLimit: usd(700000), balanceGroup: "credit_card", balanceGroupOverride: null, icon: "ph-credit-card", tone: "blue", freshness: "Synced 18 min ago" },
  { id: "acc_004", institution: "Vanguard", name: "Brokerage", type: "Investment", mask: "7714", balance: usd(6342941), balanceGroup: "taxable_investment", balanceGroupOverride: null, icon: "ph-chart-line-up", tone: "black", freshness: "Synced 2 hr ago" },
  { id: "acc_005", institution: "Vanguard", name: "Roth IRA", type: "Investment", mask: "3009", balance: usd(2694508), balanceGroup: "retirement", balanceGroupOverride: null, icon: "ph-chart-line-up", tone: "black", freshness: "Synced 2 hr ago" },
  { id: "acc_006", institution: "Fidelity", name: "401(k)", type: "Investment", mask: "2881", balance: usd(3330100), balanceGroup: "retirement", balanceGroupOverride: null, icon: "ph-briefcase", tone: "blue", freshness: "Synced yesterday" },
  { id: "acc_007", institution: "Seacomm Federal Credit Union", name: "Personal loan", type: "Personal loan", mask: "6418", balance: usd(-1618327), balanceGroup: "loan", balanceGroupOverride: null, icon: "ph-receipt", tone: "neutral", freshness: "Synced 12 min ago" },
  { id: "acc_008", institution: "American Express", name: "Blue Cash Preferred", type: "Credit card", mask: "1184", balance: usd(-88223), available: usd(411777), creditLimit: usd(500000), balanceGroup: "credit_card", balanceGroupOverride: null, icon: "ph-credit-card", tone: "blue", freshness: "Synced 24 min ago" },
];

const manualAssets = [
  {
    id: "asset_001",
    name: "2024 vehicle",
    assetType: "vehicle",
    description: "Current private-party estimate",
    value: usd(3471461),
    currencyCode: "USD",
    valuedOn: "2026-07-26",
    active: true,
  },
];

const rawInsights = {
  weekly: [
    { id: "ins_week_001", family: "weekly", typeKey: "spend_less", type: "Spend less", severity: "attention", icon: "ph-trend-up", title: "Spending rose in Dining", copy: "You spent $126 more across 9 purchases. Delivery made up most of the increase.", metric: "+$126", timeframe: "Jul 19–25 vs Jul 12–18", state: "active", actions: [{ type: "review", label: "Review dining", web_url: "/transactions?category=Dining" }] },
    { id: "ins_week_002", family: "weekly", typeKey: "better_habits", type: "Better habits", severity: "neutral", icon: "ph-repeat", title: "More frequent spending at coffee shops", copy: "Five small stops landed at $46—twice last week. Fewer convenience stops would erase the pattern.", metric: "5 stops", timeframe: "Jul 19–25 vs Jul 12–18", state: "active", actions: [{ type: "review", label: "See purchases", web_url: "/transactions?category=Dining" }] },
    { id: "ins_week_003", family: "weekly", typeKey: "needs_review", type: "Needs review", severity: "attention", icon: "ph-magnifying-glass", title: "Delta Air Lines charge needs a look", copy: "A $486 Delta purchase drove 92% of the travel increase. Mark it expected if it belongs.", metric: "$486", timeframe: "Jul 19–25 vs Jul 12–18", state: "active", actions: [{ type: "review", label: "Review charge", web_url: "/transactions?transaction=txn_008" }] },
  ],
  investments: [
    { id: "ins_inv_001", family: "investments", typeKey: "performance", type: "Performance", severity: "good", icon: "ph-chart-line-up", title: "Portfolio gained 1.8% this month", copy: "Estimated performance excludes $1,200 in contributions. VTI drove most of the gain.", metric: "+$2,191", timeframe: "Last 1 month", state: "active", actions: [{ type: "review", label: "View performance", web_url: "/portfolio?period=1m" }] },
    { id: "ins_inv_002", family: "investments", typeKey: "concentration", type: "Concentration", severity: "attention", icon: "ph-chart-donut", title: "VTI is a concentrated position", copy: "VTI is 31% of the portfolio, above your 25% marker. This is descriptive, not a trade recommendation.", metric: "31%", timeframe: "Last 1 month", state: "active", actions: [{ type: "review", label: "View allocation", web_url: "/portfolio?holding=VTI" }] },
  ],
  subscriptions: [
    { id: "ins_sub_001", family: "subscriptions", typeKey: "possible_duplicate", type: "Possible duplicate", severity: "attention", icon: "ph-copy", title: "Possible duplicate Apple subscriptions", copy: "Apple Services and iCloud+ bill the same card on separate dates. Together they cost $38 per month.", metric: "$38/mo", timeframe: "Current active subscriptions", state: "active", metrics: { service: "Apple" }, actions: [{ type: "confirm", label: "Compare charges", web_url: "/recurring?service=apple" }] },
    { id: "ins_sub_002", family: "subscriptions", typeKey: "expensive", type: "Expensive", severity: "neutral", icon: "ph-receipt", title: "Google Workspace is an expensive subscription", copy: "At $85.64 a month, it represents 36% of recurring subscription spend.", metric: "$1,028/yr", timeframe: "Current active subscriptions", state: "active", metrics: { service: "Google Workspace" }, actions: [{ type: "review", label: "Review subscription", web_url: "/recurring?stream=rec_001" }] },
  ],
};

const insights = presentDemoInsights(rawInsights);

const archivedInsights = presentDemoInsights({
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
  demoSpendingCategory({ label: "Housing", amountMinor: 145000, previousMinor: 155000, percent: 35, count: 2, color: "#2fa94f", icon: "ph-house" }),
  demoSpendingCategory({ label: "Groceries", amountMinor: 68430, previousMinor: 63000, percent: 17, count: 8, color: "#5cc576", icon: "ph-basket" }),
  demoSpendingCategory({ label: "Dining", amountMinor: 52146, previousMinor: 37800, percent: 13, count: 9, color: "#91d8a5", icon: "ph-fork-knife" }),
  demoSpendingCategory({ label: "Shopping", amountMinor: 47890, previousMinor: 53000, percent: 12, count: 6, color: "#8abde9", icon: "ph-shopping-bag" }),
  demoSpendingCategory({ label: "Travel", amountMinor: 41205, previousMinor: 80000, percent: 10, count: 2, color: "#438bd7", icon: "ph-airplane-tilt" }),
  demoSpendingCategory({ label: "Utilities", amountMinor: 33913, previousMinor: 34000, percent: 8, count: 4, color: "#2764ae", icon: "ph-lightning" }),
  demoSpendingCategory({ label: "Fees & Interest", amountMinor: 11600, previousMinor: 12200, percent: 3, count: 2, color: "#a7a7a7", icon: "ph-coins" }),
  demoSpendingCategory({ label: "Other", amountMinor: 12500, previousMinor: 25500, percent: 2, count: 5, color: "#666666", icon: "ph-dots-three" }),
];

const holdings = [
  { symbol: "VTI", name: "Vanguard Total Stock Market ETF", value: usd(3827442), allocation: 31, change: 2.4, shares: "14.82", scope: "trading" },
  { symbol: "VXUS", name: "Vanguard Total International Stock ETF", value: usd(2455810), allocation: 20, change: 1.1, shares: "38.41", scope: "trading" },
  { symbol: "VMFXX", name: "Vanguard Federal Money Market", value: usd(59689), allocation: 0.5, change: 0.1, shares: "596.89", scope: "trading" },
  { symbol: "BND", name: "Vanguard Total Bond Market ETF", value: usd(2061884), allocation: 17, change: -0.3, shares: "27.95", scope: "retirement" },
  { symbol: "AAPL", name: "Apple Inc.", value: usd(1790441), allocation: 14, change: 3.8, shares: "8.46", scope: "retirement" },
  { symbol: "Other", name: "Retirement target-date funds", value: usd(2172283), allocation: 17.5, change: 0.7, shares: "—", scope: "retirement" },
];

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

export function formatMoney(value, { sign = false } = {}) {
  return (
    formatMinorMoney(value, {
      signDisplay: sign ? "exceptZero" : "auto",
    }) ?? "—"
  );
}

function pageMeta(pathname) {
  const pages = {
    "/": ["Dashboard", "A clear view of what changed and what deserves attention."],
    "/insights": ["Insights", "What to change next—and the evidence behind it."],
    "/transactions": ["Transactions", "Every account, charge, deposit, and adjustment in one ledger."],
    "/recurring": ["Recurring", "Subscriptions, bills, and the charges quietly becoming habits."],
    "/portfolio": ["Portfolio", "Performance, contributions, and allocation without the investment-bro fog."],
    "/credit": ["Credit", "Manual score tracking, limits, balances, and utilization across the household."],
    "/accounts": ["Accounts", "Balances and connection health across every institution."],
    "/search": ["Search", "Find transactions, accounts, recurring charges, assets, and insights."],
    "/settings": ["Settings", "Connections, transaction cleanup, classifications, and access."],
  };
  return pages[pathname] || ["Money", ""];
}

function viewerFromRequest(request, fallback) {
  const identity = request.user;
  if (!identity) return fallback;
  const name = identity.name || identity.email?.split("@")[0] || "Finance user";
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "FU";
  return {
    id: identity.id,
    name,
    email: identity.email || "",
    initials,
    is_admin: Boolean(identity.isAdmin ?? identity.is_admin),
    isAdmin: Boolean(identity.isAdmin ?? identity.is_admin),
  };
}

export function createWebRouter({
  requireAuth = (_req, _res, next) => next(),
  requireAdmin = (_req, _res, next) => next(),
  financeService = null,
  demoMode = false,
} = {}) {
  const router = express.Router();
  const demo = buildDemoModel();

  async function executeSearch(
    query,
    { entityTypes = [], limit } = {},
  ) {
    const effectiveLimit = boundedSearchLimit(limit, 30);
    let payload;
    if (typeof financeService?.search === "function") {
      const options = {
        entityTypes: entityTypes.length ? entityTypes : null,
        limit: effectiveLimit,
      };
      payload = await financeService.search(query, options);
    } else if (demoMode) {
      payload = demoSearchPayload(
        demo.searchSeed,
        query,
        entityTypes,
        effectiveLimit,
      );
    } else {
      const error = new Error("Finance search is unavailable.");
      error.statusCode = 503;
      error.expose = true;
      throw error;
    }
    return normalizeSearchPayload(payload, {
      query,
      entityTypes,
      limit: effectiveLimit,
    });
  }

  router.use((req, res, next) => {
    res.locals.formatMoney = formatMoney;
    res.locals.currentPath = req.path;
    res.locals.query = req.query;
    res.locals.csrfToken =
      typeof req.csrfToken === "function"
        ? req.csrfToken()
        : res.locals.csrfToken || "";
    next();
  });

  async function renderPage(req, res, view) {
    const [pageTitle, pageDescription] = pageMeta(req.path);
    const serviceModel = demoMode
      ? await demoPageModel(
          view,
          req.query,
          demo,
          financeService,
        )
      : await financeService?.getPageData?.(view, req);
    if (!demoMode) assertPageModel(view, serviceModel);
    if (view === "dashboard" && serviceModel?.hasAccounts === false) {
      res.render("states/empty", {
        ...demo,
        viewer: viewerFromRequest(req, null),
        pageTitle: "Connect your finances",
        currentPath: "/empty",
      });
      return;
    }
    res.render(view, {
      ...(demoMode ? demo : {}),
      ...(serviceModel || {}),
      viewer: viewerFromRequest(
        req,
        serviceModel?.viewer ||
          (demoMode ? demo.viewer : emptyViewer()),
      ),
      pageTitle,
      pageDescription,
      activePath: req.path,
    });
  }

  router.get("/login", (req, res) => res.render("auth/login", {
    pageTitle: "Sign in",
    currentPath: "/login",
    error: req.query.error || null,
  }));

  router.get("/empty", requireAuth, (req, res) => res.render("states/empty", {
    ...demo,
    pageTitle: "Connect your finances",
    currentPath: "/empty",
    viewer: viewerFromRequest(req, demo.viewer),
  }));

  router.get("/error", requireAuth, (req, res) => res.status(503).render("states/error", {
    pageTitle: "Something needs attention",
    currentPath: "/error",
    viewer: viewerFromRequest(req, demo.viewer),
    requestId: req.query.request_id || "req_demo_72af",
  }));

  router.get("/", requireAuth, (req, res, next) => renderPage(req, res, "dashboard").catch(next));
  router.get("/insights", requireAuth, (req, res, next) => renderPage(req, res, "insights").catch(next));
  router.get("/transactions", requireAuth, (req, res, next) => renderPage(req, res, "transactions").catch(next));
  router.get("/recurring", requireAuth, (req, res, next) => renderPage(req, res, "recurring").catch(next));
  router.get("/portfolio", requireAuth, (req, res, next) => renderPage(req, res, "portfolio").catch(next));
  router.get("/credit", requireAuth, (req, res, next) => renderPage(req, res, "credit").catch(next));
  router.get("/accounts", requireAuth, (req, res, next) => renderPage(req, res, "accounts").catch(next));
  router.get("/search", requireAuth, async (req, res, next) => {
    try {
      const request = normalizedSearchPageRequest(req);
      if (request.currentTarget !== request.canonicalTarget) {
        res.redirect(302, request.canonicalTarget);
        return;
      }

      const entityTypes = request.entityType
        ? [request.entityType]
        : [];
      let searchPayload = emptySearchPayload(request.query, entityTypes);
      let searchState =
        request.query.length === 0
          ? "initial"
          : request.query.length < 2
            ? "too_short"
            : "empty";
      let searchError = null;
      let statusCode = 200;

      if (request.query.length >= 2) {
        try {
          searchPayload = await executeSearch(request.query, {
            entityTypes,
            limit: 50,
          });
          searchState =
            searchPayload.returned_count > 0 ? "results" : "empty";
        } catch {
          searchState = "error";
          searchError =
            "Search is unavailable right now. Try again in a moment.";
          statusCode = 503;
        }
      }

      const [pageTitle, pageDescription] = pageMeta("/search");
      res.status(statusCode).render("search", {
        ...(demoMode ? demo : {}),
        viewer: viewerFromRequest(
          req,
          demoMode ? demo.viewer : emptyViewer(),
        ),
        pageTitle,
        pageDescription,
        activePath: "/search",
        searchQuery: request.query,
        searchEntityType: request.entityType,
        searchEntityTypes: SEARCH_ENTITY_OPTIONS,
        searchPayload,
        searchState,
        searchError,
      });
    } catch (error) {
      next(error);
    }
  });
  router.get("/settings", requireAuth, requireAdmin, (req, res, next) => renderPage(req, res, "settings").catch(next));

  router.get("/api/search", requireAuth, async (req, res, next) => {
    try {
      const query = normalizedSearchQuery(firstQueryValue(req.query.q));
      const entityTypes = searchEntityTypes(req.query.entity_type);
      if (req.query.entity_type && !entityTypes.length) {
        return res.status(400).json({
          error: "invalid_entity_type",
          message: "The requested search filter is not supported.",
        });
      }
      if (query.length < 2) {
        return res.json(emptySearchPayload(query, entityTypes));
      }
      const hasLimit = Object.hasOwn(req.query, "limit");
      return res.json(await executeSearch(query, {
        entityTypes,
        limit: hasLimit
          ? boundedSearchLimit(firstQueryValue(req.query.limit), 30)
          : undefined,
      }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function cleanupName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(
      /\b(inc|llc|ltd|corp|corporation|company|co|online|payment|purchase)\b/g,
      " ",
    )
    .replace(/\b\d{3,}\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanupSimilarity(left, right) {
  const leftKey = cleanupName(left);
  const rightKey = cleanupName(right);
  if (!leftKey || !rightKey) return 0;
  if (leftKey === rightKey) return 10_000;
  const grams = (value) => {
    const padded = `  ${value} `;
    const result = [];
    for (let index = 0; index < padded.length - 2; index += 1) {
      result.push(padded.slice(index, index + 3));
    }
    return result;
  };
  const leftGrams = grams(leftKey);
  const remaining = grams(rightKey);
  let overlap = 0;
  for (const gram of leftGrams) {
    const index = remaining.indexOf(gram);
    if (index < 0) continue;
    overlap += 1;
    remaining.splice(index, 1);
  }
  return Math.round(
    (2 * overlap * 10_000) /
      (leftGrams.length + grams(rightKey).length),
  );
}

function demoCleanupTransaction(transaction, {
  score = 10_000,
  reason = "source",
  preselected = false,
} = {}) {
  return {
    id: transaction.id,
    display_name: transaction.merchant,
    raw_merchant: transaction.rawMerchant ?? transaction.merchant,
    raw_name: transaction.rawName ?? transaction.merchant,
    category_primary: transaction.category,
    tags: transaction.tags ?? [],
    posted_on: transaction.date,
    account_name: transaction.account,
    amount: transaction.amount,
    similarity_basis_points: score,
    match_reason: reason,
    preselected,
  };
}

function demoTransactionCleanup(query, demo) {
  const anchor =
    demo.transactions.find(
      (transaction) => transaction.id === query.transaction,
    ) ?? null;
  const rawQuery = String(
    query.cleanup_q ??
      anchor?.rawMerchant ??
      anchor?.merchant ??
      "",
  ).trim();
  const queryKey = cleanupName(rawQuery);
  const matches = queryKey
    ? demo.transactions
        .filter(
          (transaction) =>
            transaction.status !== "pending" &&
            transaction.id !== anchor?.id &&
            Math.sign(transaction.amount.amount_minor) ===
              Math.sign(anchor?.amount.amount_minor ?? transaction.amount.amount_minor),
        )
        .map((transaction) => {
          const rawMerchant =
            transaction.rawMerchant ?? transaction.merchant;
          const score = cleanupSimilarity(rawMerchant, rawQuery);
          return {
            transaction,
            score,
            exact: cleanupName(rawMerchant) === queryKey,
          };
        })
        .filter((match) => match.score >= 3_500)
        .sort(
          (left, right) =>
            Number(right.exact) - Number(left.exact) ||
            right.score - left.score ||
            right.transaction.date.localeCompare(left.transaction.date) ||
            left.transaction.id.localeCompare(right.transaction.id),
        )
        .slice(0, 50)
        .map(({ transaction, score, exact }) =>
          demoCleanupTransaction(transaction, {
            score,
            reason: exact ? "exact_merchant" : "similar_name",
            preselected: exact,
          }),
        )
    : [];
  const availableTags = [
    ...new Set(
      demo.transactions.flatMap(
        (transaction) => transaction.tags ?? [],
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  return {
    query: rawQuery,
    anchor: anchor
      ? demoCleanupTransaction(anchor, {
          reason: "source",
          preselected: true,
        })
      : null,
    matches,
    available_tags: availableTags,
  };
}

function demoServiceTransactionForWeb(transaction, demo) {
  const stored = demo.transactions.find(
    (candidate) => candidate.id === transaction.id,
  );
  const accountName =
    transaction.account?.name ??
    transaction.account_name ??
    stored?.account ??
    "Unknown account";
  return {
    ...(stored || {}),
    id: transaction.id,
    date:
      transaction.date ??
      transaction.posted_on ??
      stored?.date ??
      "",
    merchant:
      transaction.display_name ??
      transaction.merchant ??
      transaction.raw_merchant ??
      transaction.raw_name ??
      stored?.merchant ??
      "Transaction",
    rawMerchant:
      transaction.raw_merchant ??
      stored?.rawMerchant ??
      transaction.merchant ??
      null,
    rawName:
      transaction.raw_name ??
      stored?.rawName ??
      transaction.description ??
      null,
    category:
      transaction.category_primary ??
      transaction.category ??
      stored?.category ??
      "Uncategorized",
    tags: [...(transaction.tags ?? stored?.tags ?? [])],
    account: accountName,
    accountId:
      transaction.account?.id ??
      transaction.account_id ??
      stored?.accountId ??
      null,
    amount: transaction.amount ?? stored?.amount,
    icon: stored?.icon ?? "ph-receipt",
    status:
      transaction.pending === true ||
      transaction.status === "pending"
        ? "pending"
        : "posted",
  };
}

async function demoTransactionsFromService(demo, financeService) {
  if (typeof financeService?.listTransactions !== "function") {
    return demo.transactions;
  }
  const result = await financeService.listTransactions({
    status: "all",
    limit: 100,
  });
  const serviceRows = result?.data?.transactions ?? [];
  const currentById = new Map(
    serviceRows.map((transaction) => [
      transaction.id,
      demoServiceTransactionForWeb(transaction, demo),
    ]),
  );
  return [
    ...demo.transactions.map(
      (transaction) => currentById.get(transaction.id) ?? transaction,
    ),
    ...serviceRows
      .filter(
        (transaction) =>
          !demo.transactions.some(
            (candidate) => candidate.id === transaction.id,
          ),
      )
      .map((transaction) =>
        demoServiceTransactionForWeb(transaction, demo),
      ),
  ];
}

async function demoPageModel(view, query, demo, financeService = null) {
  if (view === "settings") {
    const listedRules =
      typeof financeService?.listTransactionCleanupRules === "function"
        ? await financeService.listTransactionCleanupRules()
        : demo.transactionRules;
    const staticCleanup = demoTransactionCleanup(query, demo);
    const transactionCleanup =
      (query.transaction || query.cleanup_q) &&
      typeof financeService?.findTransactionMatches === "function"
        ? await financeService.findTransactionMatches({
            transaction_id: query.transaction,
            q: query.cleanup_q,
            limit: 50,
          })
        : staticCleanup;
    return {
      transactionCleanup,
      transactionTags:
        transactionCleanup.available_tags ??
        staticCleanup.available_tags,
      transactionRules: Array.isArray(listedRules)
        ? listedRules
        : listedRules?.rules ?? demo.transactionRules,
    };
  }
  if (view === "dashboard") {
    const periodName = ["1w", "1m", "1y", "all"].includes(query.period)
      ? query.period
      : "1m";
    const history = demo.dashboardHistories[periodName];
    return {
      dashboardPeriod: history.period,
      wealthSeries: history.series,
      wealthLabels: history.labels,
      netWorthSeries: history.series.net_worth,
      netWorthLabels: history.labels,
    };
  }
  if (view === "transactions") {
    const currentTransactions =
      await demoTransactionsFromService(demo, financeService);
    const normalized = String(query.q ?? "").trim().toLowerCase();
    const filtered = currentTransactions.filter(
      (transaction) =>
        (!normalized ||
          `${transaction.merchant} ${transaction.category} ${transaction.account}`
            .toLowerCase()
            .includes(normalized)) &&
        (!query.category || transaction.category === query.category) &&
        (!query.account ||
          transaction.accountId === query.account ||
          demo.accounts.some(
            (account) =>
              account.id === query.account &&
              account.name === transaction.account,
          )),
    );
    const selectedCategory = demo.categories.find(
      (category) => category.label === query.category,
    );
    return {
      transactions: filtered,
      transactionPageInfo: { has_more: false, next_cursor: null },
      ...(selectedCategory
        ? demoCategorySpendingModel(selectedCategory, demo)
        : {}),
      selectedTransaction:
        currentTransactions.find(
          (transaction) => transaction.id === query.transaction,
        ) ?? null,
    };
  }
  if (view === "recurring") {
    return {
      inactiveRecurring: [],
      selectedRecurring:
        [...demo.subscriptions, ...demo.bills].find(
          (item) => item.id === (query.item ?? query.stream),
        ) ?? null,
    };
  }
  if (view === "portfolio") {
    const requestedScope =
      query.scope === "taxable"
        ? "trading"
        : ["all", "trading", "retirement"].includes(query.scope)
          ? query.scope
          : "all";
    const scopedHoldings =
      requestedScope === "all"
        ? demo.holdings
        : demo.holdings.filter(
            (holding) => holding.scope === requestedScope,
          );
    const portfolioMinor = scopedHoldings.reduce(
      (total, holding) => total + holding.value.amount_minor,
      0,
    );
    const displayedHoldings = scopedHoldings.map((holding) => ({
      ...holding,
      allocation:
        portfolioMinor === 0
          ? 0
          : Math.round(
              (holding.value.amount_minor / portfolioMinor) * 10_000,
            ) / 100,
    }));
    return {
      portfolioScope: requestedScope,
      holdings: displayedHoldings,
      allocation: displayedHoldings.map((holding) => ({
        label: holding.symbol,
        value: holding.allocation,
      })),
      overview: {
        ...demo.overview,
        portfolio: usd(portfolioMinor),
      },
      selectedHolding:
        displayedHoldings.find(
          (holding) => holding.symbol === query.holding,
        ) ??
        null,
    };
  }
  if (view === "credit") {
    const periodName = ["1w", "1m", "1y", "all"].includes(query.period)
      ? query.period
      : "1m";
    const scorePeriod = ["1m", "1y", "all"].includes(
      query.score_period,
    )
      ? query.score_period
      : "1y";
    const scoreResult =
      typeof financeService?.getCreditScoreSummary === "function"
        ? await financeService.getCreditScoreSummary({
            period: scorePeriod,
            currentUserId: "demo-user",
          })
        : null;
    return {
      creditData: demo.creditHistories[periodName],
      creditScoreData:
        scoreResult?.data ??
        (scorePeriod === "1y"
          ? demo.creditScoreData
          : buildCreditScoreSummary({
              members: demo.creditScoreData.people.map((person) => ({
                id: person.person_id,
                display_name: person.person_name,
              })),
              sources: demo.creditScoreData.people.flatMap((person) =>
                person.sources.map((source) => ({
                  id: source.source_id,
                  user_id: person.person_id,
                  label: source.label,
                  bureau: source.bureau,
                  model: source.model,
                })),
              ),
              observations: demo.creditScoreData.people.flatMap((person) =>
                person.sources
                  .filter((source) => source.score != null)
                  .map((source) => ({
                    id: `${source.source_id}_current`,
                    source_id: source.source_id,
                    observed_on: source.observed_on,
                    score: source.score,
                  })),
              ),
              currentOn: "2026-07-26",
              period: scorePeriod,
              currentUserId: "demo-user",
            })),
      creditScorePresets: CREDIT_SCORE_PRESETS,
    };
  }
  if (view === "accounts") {
    return {};
  }
  if (view === "insights") {
    const insightView = query.view === "archive" ? "archive" : "active";
    const displayedInsights =
      insightView === "archive" ? demo.archivedInsights : demo.insights;
    return {
      insights: displayedInsights,
      insightView,
      insightData: { view: insightView },
      selectedInsight:
        Object.values(displayedInsights)
          .flat()
          .find((finding) => finding.id === query.finding) ?? null,
    };
  }
  return {};
}

function presentDemoInsights(sections) {
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

function demoCategorySpendingModel(category, demo) {
  const currentMinor = category.amount.amount_minor;
  const overallCurrentMinor = demo.spendingDetails.total.amount_minor;
  const previousMinor = Math.round(
    demo.spendingDetails.previousTotal.amount_minor *
      (overallCurrentMinor ? currentMinor / overallCurrentMinor : 0),
  );
  const changeMinor = currentMinor - previousMinor;
  const percentBasisPoints =
    previousMinor === 0
      ? null
      : Math.round((changeMinor / previousMinor) * 10_000);
  const trendDirection =
    changeMinor > 0 ? "up" : changeMinor < 0 ? "down" : "flat";
  const scaledSeries = scaleSeries(
    demo.spendingDetails.seriesValues,
    currentMinor,
  );
  return {
    overview: {
      ...demo.overview,
      income: usd(0),
      spending: category.amount,
      cashFlow: usd(-currentMinor),
    },
    spendingDetails: {
      ...demo.spendingDetails,
      total: category.amount,
      previousTotal: usd(previousMinor),
      change: usd(changeMinor),
      trendDirection,
      trendLabel:
        percentBasisPoints == null
          ? `${formatMoney(category.amount)} from no prior spending`
          : trendDirection === "flat"
            ? "No change from the prior period"
            : `${(Math.abs(percentBasisPoints) / 100).toFixed(1)}% ${
                trendDirection === "up" ? "more" : "less"
              } than the prior period`,
      transactionCount: category.count,
      averageTransaction: usd(
        category.count
          ? Math.round(currentMinor / category.count)
          : 0,
      ),
      categories: [{ ...category, percent: 100 }],
      seriesValues: scaledSeries,
    },
  };
}

function scaleSeries(values, targetTotal) {
  const sourceTotal = values.reduce((sum, value) => sum + value, 0);
  if (!values.length || sourceTotal === 0) return values.map(() => 0);
  let assigned = 0;
  return values.map((value, index) => {
    if (index === values.length - 1) return targetTotal - assigned;
    const scaled = Math.round((value / sourceTotal) * targetTotal);
    assigned += scaled;
    return scaled;
  });
}

function firstQueryValue(value) {
  return Array.isArray(value) ? firstQueryValue(value[0]) : value;
}

function normalizedSearchQuery(value) {
  return String(value ?? "").trim().slice(0, 120);
}

function boundedSearchLimit(value, fallback = 30) {
  const number = Number(value ?? fallback);
  return Number.isSafeInteger(number)
    ? Math.max(1, Math.min(50, number))
    : fallback;
}

function normalizedSearchPageRequest(req) {
  const requestUrl = new URL(
    req.originalUrl || req.url || "/search",
    "http://money.local",
  );
  const query = normalizedSearchQuery(
    requestUrl.searchParams.get("q"),
  );
  const entityType =
    requestUrl.searchParams
      .getAll("entity_type")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim().toLowerCase())
      .find((value) => SEARCH_ENTITY_TYPES.has(value)) ?? "";
  const parameters = new URLSearchParams();
  if (query) parameters.set("q", query);
  if (entityType) parameters.set("entity_type", entityType);
  const search = parameters.toString();
  return {
    query,
    entityType,
    currentTarget: `${requestUrl.pathname}${requestUrl.search}`,
    canonicalTarget: `/search${search ? `?${search}` : ""}`,
  };
}

function emptySearchPayload(query, entityTypes = []) {
  return {
    query,
    entity_types: entityTypes,
    groups: [],
    returned_count: 0,
    group_count: 0,
  };
}

function normalizeSearchPayload(
  payload,
  { query, entityTypes = [], limit = 30 },
) {
  const source =
    payload && typeof payload === "object" ? payload : {};
  const groups = [];
  let remaining = boundedSearchLimit(limit, 30);

  for (const rawGroup of Array.isArray(source.groups)
    ? source.groups
    : []) {
    if (remaining === 0) break;
    const items = [];
    for (const rawItem of Array.isArray(rawGroup?.items)
      ? rawGroup.items
      : []) {
      if (remaining === 0) break;
      const url = safeSearchResultPath(rawItem?.url);
      if (!url) continue;
      const item = {
        ...(rawItem && typeof rawItem === "object" ? rawItem : {}),
        title: String(rawItem?.title ?? ""),
        meta: String(rawItem?.meta ?? ""),
        url,
        icon: String(rawItem?.icon ?? "ph-magnifying-glass"),
      };
      delete item.searchText;
      delete item.search_text;
      items.push(item);
      remaining -= 1;
    }
    if (!items.length) continue;
    groups.push({
      ...(rawGroup && typeof rawGroup === "object" ? rawGroup : {}),
      label: String(rawGroup?.label ?? "Other"),
      items,
      returned_count: items.length,
    });
  }

  const returnedCount = groups.reduce(
    (total, group) => total + group.items.length,
    0,
  );
  return {
    ...source,
    query,
    entity_types: entityTypes,
    groups,
    returned_count: returnedCount,
    group_count: groups.length,
  };
}

function safeSearchResultPath(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return null;
  }
  try {
    const base = new URL("http://money.local");
    const parsed = new URL(value, base);
    if (parsed.origin !== base.origin) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

function demoSearchPayload(seed, query, entityTypes, limit) {
  const queryKey = normalizedSearchText(query);
  if (queryKey.length < 2) {
    return emptySearchPayload(query, entityTypes);
  }
  const matches = seed
    .filter(
      (item) =>
        !entityTypes.length ||
        entityTypes.includes(item.entityType),
    )
    .map((item) => ({
      item,
      rank: demoSearchRank(item, queryKey),
    }))
    .filter(({ rank }) => rank != null)
    .sort(
      (left, right) =>
        right.rank.tier - left.rank.tier ||
        right.rank.similarity - left.rank.similarity ||
        String(left.item.title).localeCompare(
          String(right.item.title),
        ),
    )
    .slice(0, boundedSearchLimit(limit, 30));
  const grouped = new Map();
  for (const { item } of matches) {
    const items = grouped.get(item.group) ?? [];
    items.push(item);
    grouped.set(item.group, items);
  }
  return {
    query,
    entity_types: entityTypes,
    groups: [...grouped.entries()].map(([label, items]) => ({
      label,
      items,
      returned_count: items.length,
    })),
    returned_count: matches.length,
    group_count: grouped.size,
  };
}

function demoSearchRank(item, queryKey) {
  const text = normalizedSearchText(
    item.searchText ?? `${item.title} ${item.meta}`,
  );
  const similarity = searchTextSimilarity(text, queryKey);
  if (text === queryKey) return { tier: 4, similarity };
  if (text.startsWith(queryKey)) return { tier: 3, similarity };
  const words = new Set(text.split(" ").filter(Boolean));
  const queryWords = queryKey.split(" ").filter(Boolean);
  if (queryWords.every((word) => words.has(word))) {
    return { tier: 2, similarity };
  }
  if (text.includes(queryKey) || similarity >= 0.2) {
    return { tier: 1, similarity };
  }
  return null;
}

function normalizedSearchText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function searchTextSimilarity(left, right) {
  if (!left || !right) return 0;
  const trigrams = (value) => {
    const padded = `  ${value} `;
    const result = [];
    for (let index = 0; index < padded.length - 2; index += 1) {
      result.push(padded.slice(index, index + 3));
    }
    return result;
  };
  const leftTrigrams = trigrams(left);
  const remaining = trigrams(right);
  let overlap = 0;
  for (const trigram of leftTrigrams) {
    const index = remaining.indexOf(trigram);
    if (index < 0) continue;
    overlap += 1;
    remaining.splice(index, 1);
  }
  return (
    (2 * overlap) /
    (leftTrigrams.length + trigrams(right).length)
  );
}

function searchEntityTypes(value) {
  const raw = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      raw
        .flatMap((entry) => String(entry ?? "").split(","))
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => SEARCH_ENTITY_TYPES.has(entry)),
    ),
  ];
}

function emptyViewer() {
  return {
    name: "Finance user",
    email: "",
    initials: "FU",
    is_admin: false,
  };
}

function assertPageModel(view, model) {
  const required = {
    dashboard: [
      "overview",
      "categories",
      "insights",
      "transactions",
      "netWorthSeries",
      "netWorthLabels",
      "wealthSeries",
      "wealthLabels",
    ],
    insights: ["insights"],
    transactions: [
      "overview",
      "transactions",
      "accounts",
      "categories",
      "spendingDetails",
      "transactionPageInfo",
    ],
    recurring: ["overview", "subscriptions", "bills"],
    portfolio: ["overview", "holdings", "allocation", "portfolioData"],
    credit: ["creditData"],
    accounts: ["overview", "accounts", "manualAssets"],
    settings: [
      "connections",
      "rules",
      "fixedCategories",
      "observedCategories",
      "accounts",
      "manualAssets",
      "transactionTags",
      "transactionCleanup",
      "transactionRules",
    ],
  }[view] ?? [];
  if (
    !model ||
    required.some((key) => !Object.hasOwn(model, key))
  ) {
    throw new Error(`Finance page data is incomplete for ${view}`);
  }
  if (
    ["dashboard", "accounts", "portfolio"].includes(view) &&
    [
      "cashBalance",
      "shortTermWorth",
      "netWorth",
      "taxableInvestments",
      "retirementInvestments",
    ].some((key) => !Object.hasOwn(model.overview, key))
  ) {
    throw new Error(`Finance wealth totals are incomplete for ${view}`);
  }
}

export default createWebRouter;
