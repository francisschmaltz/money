import { createHash } from "node:crypto";
import {
  buildPortfolioSummary,
  completedWeeklyPeriods,
  money,
  percentChangeBasisPoints,
  shiftDateOnly,
} from "./analytics.js";
import { stableFindingId, stableFindingKey } from "./ids.js";
import { isCashSecurity } from "./investmentSecurities.js";
import { effectiveTransactionName } from "./transactionNames.js";

export function detectWeeklyInsights(
  transactions,
  {
    asOf = new Date(),
    currency = "USD",
    minimumChangeMinor = 2_500,
    minimumChangeBasisPoints = 1_500,
    fixedCategories = [],
    spendLessEnabled = true,
    baseUrl = "https://money.example.com",
    dataAsOf = asOf,
  } = {},
) {
  const periods = completedWeeklyPeriods(asOf);
  const current = eligibleSpending(
    transactions,
    periods.current,
    currency,
  );
  const previous = eligibleSpending(
    transactions,
    periods.previous,
    currency,
  );
  const findings = [];
  const fixedCategorySet = new Set(
    fixedCategories.map((category) => String(category).toLowerCase()),
  );
  const categoryCurrent = aggregate(current, categoryKey);
  const categoryPrevious = aggregate(previous, categoryKey);
  const previousTop = new Set(
    [...categoryPrevious.entries()]
      .sort((a, b) => b[1].amount - a[1].amount)
      .slice(0, 3)
      .map(([key]) => key),
  );
  const currentTop = [...categoryCurrent.entries()]
    .sort((a, b) => b[1].amount - a[1].amount)
    .slice(0, 3)
    .map(([key]) => key);

  for (const [category, value] of categoryCurrent) {
    if (!spendLessEnabled) break;
    if (
      fixedCategorySet.has(category.toLowerCase()) ||
      value.transactions.every((transaction) => transaction.is_fixed)
    ) {
      continue;
    }
    const prior = categoryPrevious.get(category) ?? {
      amount: 0,
      count: 0,
      transactions: [],
    };
    const change = value.amount - prior.amount;
    const percent = percentChangeBasisPoints(value.amount, prior.amount);
    const newlyTop =
      currentTop.includes(category) &&
      !previousTop.has(category) &&
      value.amount >= minimumChangeMinor;
    if (
      !(
        change >= minimumChangeMinor &&
        (percent == null || percent >= minimumChangeBasisPoints)
      ) &&
      !newlyTop
    ) {
      continue;
    }
    findings.push(
      finding({
        family: "weekly",
        type: "spend_less",
        severity: change >= minimumChangeMinor * 3 ? "important" : "attention",
        identity: category,
        period: periods.current,
        title: `Spending rose in ${humanize(category)}`,
        explanation:
          prior.amount === 0
            ? `${humanize(category)} became a new discretionary spending area this week.`
            : `${humanize(category)} increased week over week.`,
        metrics: {
          current: money(value.amount, currency),
          previous: money(prior.amount, currency),
          change: money(change, currency),
          percent_change_basis_points: percent,
          current_transaction_count: value.count,
          previous_transaction_count: prior.count,
          transaction_count_change: value.count - prior.count,
        },
        rule: {
          key: "spend_less",
          minimum_change_minor: minimumChangeMinor,
          minimum_change_basis_points: minimumChangeBasisPoints,
          newly_top_three: newlyTop,
        },
        confidence: 9_000,
        evidenceTransactions: value.transactions.slice(0, 5),
        baseUrl,
        generatedAt: asOf,
        dataAsOf,
      }),
    );
  }

  const merchantCurrent = aggregate(current, merchantKey);
  const merchantPrevious = aggregate(previous, merchantKey);
  for (const [merchant, value] of merchantCurrent) {
    const prior = merchantPrevious.get(merchant) ?? {
      amount: 0,
      count: 0,
      transactions: [],
    };
    const amountChange = value.amount - prior.amount;
    const amountPercent = percentChangeBasisPoints(
      value.amount,
      prior.amount,
    );
    const flexibleMerchant = value.transactions.some(
      (transaction) =>
        !transaction.is_fixed &&
        !fixedCategorySet.has(categoryKey(transaction).toLowerCase()),
    );
    if (
      spendLessEnabled &&
      flexibleMerchant &&
      amountChange >= minimumChangeMinor &&
      (amountPercent == null ||
        amountPercent >= minimumChangeBasisPoints)
    ) {
      findings.push(
        finding({
          family: "weekly",
          type: "spend_less",
          severity:
            amountChange >= minimumChangeMinor * 3
              ? "important"
              : "attention",
          identity: `merchant:${merchant}`,
          period: periods.current,
          title: `Spending rose at ${displayMerchant(value.transactions[0])}`,
          explanation:
            prior.amount === 0
              ? "This merchant became a meaningful new source of discretionary spending this week."
              : "Spending at this merchant increased week over week.",
          metrics: {
            current: money(value.amount, currency),
            previous: money(prior.amount, currency),
            change: money(amountChange, currency),
            percent_change_basis_points: amountPercent,
            current_transaction_count: value.count,
            previous_transaction_count: prior.count,
            transaction_count_change: value.count - prior.count,
          },
          rule: {
            key: "merchant_spend_increase",
            minimum_change_minor: minimumChangeMinor,
            minimum_change_basis_points: minimumChangeBasisPoints,
          },
          confidence: 8_750,
          evidenceTransactions: value.transactions.slice(0, 5),
          baseUrl,
          generatedAt: asOf,
          dataAsOf,
        }),
      );
    }
    const countChange = value.count - prior.count;
    const frequencyIncrease =
      countChange >= 3 &&
      (prior.count === 0 || value.count >= Math.ceil(prior.count * 1.5));
    if (frequencyIncrease) {
      findings.push(
        finding({
          family: "weekly",
          type: "better_habits",
          severity: "attention",
          identity: `frequency:${merchant}`,
          period: periods.current,
          title: `More frequent spending at ${displayMerchant(value.transactions[0])}`,
          explanation:
            "Purchase frequency increased enough to be worth a habit check.",
          metrics: {
            current: money(value.amount, currency),
            previous: money(prior.amount, currency),
            change: money(value.amount - prior.amount, currency),
            percent_change_basis_points: percentChangeBasisPoints(
              value.amount,
              prior.amount,
            ),
            current_transaction_count: value.count,
            previous_transaction_count: prior.count,
            transaction_count_change: countChange,
          },
          rule: {
            key: "purchase_frequency",
            minimum_count_change: 3,
            minimum_ratio_basis_points: 15_000,
          },
          confidence: 8_500,
          evidenceTransactions: value.transactions.slice(0, 5),
          baseUrl,
          generatedAt: asOf,
          dataAsOf,
        }),
      );
    }
  }

  const convenienceCurrent = aggregate(
    current.filter(isConvenienceTransaction),
    () => "convenience",
  ).get("convenience");
  const conveniencePrevious = aggregate(
    previous.filter(isConvenienceTransaction),
    () => "convenience",
  ).get("convenience") ?? {
    amount: 0,
    count: 0,
    transactions: [],
  };
  if (
    convenienceCurrent?.count >= 3 &&
    convenienceCurrent.amount >= minimumChangeMinor &&
    (convenienceCurrent.count > conveniencePrevious.count ||
      convenienceCurrent.amount > conveniencePrevious.amount)
  ) {
    findings.push(
      finding({
        family: "weekly",
        type: "better_habits",
        severity:
          convenienceCurrent.amount >= minimumChangeMinor * 3
            ? "important"
            : "attention",
        identity: "convenience_spending",
        period: periods.current,
        title: "Convenience spending repeated this week",
        explanation:
          "Coffee, delivery, takeout, or ride purchases repeated often enough to deserve a habit check.",
        metrics: {
          current: money(convenienceCurrent.amount, currency),
          previous: money(conveniencePrevious.amount, currency),
          change: money(
            convenienceCurrent.amount - conveniencePrevious.amount,
            currency,
          ),
          percent_change_basis_points: percentChangeBasisPoints(
            convenienceCurrent.amount,
            conveniencePrevious.amount,
          ),
          current_transaction_count: convenienceCurrent.count,
          previous_transaction_count: conveniencePrevious.count,
          transaction_count_change:
            convenienceCurrent.count - conveniencePrevious.count,
        },
        rule: {
          key: "repeated_convenience_spending",
          minimum_transaction_count: 3,
          minimum_amount_minor: minimumChangeMinor,
        },
        confidence: 8_000,
        evidenceTransactions:
          convenienceCurrent.transactions.slice(0, 5),
        baseUrl,
        generatedAt: asOf,
        dataAsOf,
      }),
    );
  }

  const similarEligible = (transaction) =>
    !transaction.is_fixed &&
    !fixedCategorySet.has(categoryKey(transaction).toLowerCase());
  const similarCurrent = aggregate(
    current.filter(similarEligible),
    similarPurchaseKey,
  );
  const similarPrevious = aggregate(
    previous.filter(similarEligible),
    similarPurchaseKey,
  );
  for (const [cluster, value] of similarCurrent) {
    const prior = similarPrevious.get(cluster) ?? {
      amount: 0,
      count: 0,
      transactions: [],
    };
    if (
      value.count < 3 ||
      value.amount < minimumChangeMinor ||
      value.count <= prior.count
    ) {
      continue;
    }
    findings.push(
      finding({
        family: "weekly",
        type: "better_habits",
        severity: "attention",
        identity: `similar_purchases:${cluster}`,
        period: periods.current,
        title: `Similar ${humanize(categoryKey(value.transactions[0]))} purchases clustered`,
        explanation:
          "Several discretionary purchases landed in the same category and amount range this week.",
        metrics: {
          current: money(value.amount, currency),
          previous: money(prior.amount, currency),
          change: money(value.amount - prior.amount, currency),
          percent_change_basis_points: percentChangeBasisPoints(
            value.amount,
            prior.amount,
          ),
          current_transaction_count: value.count,
          previous_transaction_count: prior.count,
          transaction_count_change: value.count - prior.count,
        },
        rule: {
          key: "similar_purchase_cluster",
          minimum_transaction_count: 3,
          amount_bucket_minor: 500,
        },
        confidence: 7_500,
        evidenceTransactions: value.transactions.slice(0, 5),
        baseUrl,
        generatedAt: asOf,
        dataAsOf,
      }),
    );
  }

  const feeTransactions = current.filter((transaction) =>
    /\b(fee|interest|overdraft|late)\b/i.test(
      `${transaction.category_primary} ${transaction.category_detailed} ${transaction.name}`,
    ),
  );
  if (feeTransactions.length) {
    const previousFeeTransactions = previous.filter((transaction) =>
      /\b(fee|interest|overdraft|late)\b/i.test(
        `${transaction.category_primary} ${transaction.category_detailed} ${transaction.name}`,
      ),
    );
    const feeTotal = feeTransactions.reduce(
      (sum, transaction) => sum - transaction.amount_minor,
      0,
    );
    const previousFeeTotal = previousFeeTransactions.reduce(
      (sum, transaction) => sum - transaction.amount_minor,
      0,
    );
    findings.push(
      finding({
        family: "weekly",
        type: "better_habits",
        severity: feeTotal >= 5_000 ? "important" : "attention",
        identity: "fees",
        period: periods.current,
        title: "Fees or interest showed up this week",
        explanation:
          "These charges are often avoidable and deserve a quick review.",
        metrics: {
          current: money(feeTotal, currency),
          previous: money(previousFeeTotal, currency),
          change: money(feeTotal - previousFeeTotal, currency),
          percent_change_basis_points: percentChangeBasisPoints(
            feeTotal,
            previousFeeTotal,
          ),
          current_transaction_count: feeTransactions.length,
          previous_transaction_count: previousFeeTransactions.length,
          transaction_count_change:
            feeTransactions.length - previousFeeTransactions.length,
        },
        rule: { key: "fees_or_interest" },
        confidence: 9_500,
        evidenceTransactions: feeTransactions.slice(0, 5),
        baseUrl,
        generatedAt: asOf,
        dataAsOf,
      }),
    );
  }

  const history = transactions.filter(
    (transaction) =>
      transaction.currency_code === currency &&
      !transaction.pending &&
      transaction.amount_minor < 0,
  );
  const reviewed = new Set();
  for (const transaction of current) {
    const spend = -transaction.amount_minor;
    const sameGroup = history.filter(
      (candidate) =>
        candidate.id !== transaction.id &&
        (merchantKey(candidate) === merchantKey(transaction) ||
          categoryKey(candidate) === categoryKey(transaction)),
    );
    const typical = median(
      sameGroup.map((candidate) => -candidate.amount_minor),
    );
    const priorPeriodMatches = previous.filter(
      (candidate) =>
        merchantKey(candidate) === merchantKey(transaction) ||
        categoryKey(candidate) === categoryKey(transaction),
    );
    const previousComparableTotal = priorPeriodMatches.reduce(
      (sum, candidate) => sum - candidate.amount_minor,
      0,
    );
    let reviewReason = null;
    if (
      !transaction.category_primary &&
      spend >= 5_000
    ) {
      reviewReason = "large_uncategorized";
    } else if (
      /\b(cash withdrawal|atm)\b/i.test(
        `${transaction.category_primary} ${transaction.name}`,
      ) &&
      spend >= 5_000
    ) {
      reviewReason = "cash_withdrawal";
    } else if (spend >= 5_000 && typical > 0 && spend >= typical * 3) {
      reviewReason = "unusual_amount";
    }
    if (!reviewReason || reviewed.has(transaction.id)) continue;
    reviewed.add(transaction.id);
    findings.push(
      finding({
        family: "weekly",
        type: "needs_review",
        severity: spend >= 20_000 ? "important" : "attention",
        identity: `${reviewReason}:${transaction.id}`,
        period: periods.current,
        title: `${displayMerchant(transaction)} charge needs a look`,
        explanation:
          reviewReason === "unusual_amount"
            ? "This charge is more than three times the usual amount for similar transactions."
            : reviewReason === "large_uncategorized"
              ? "This large charge has no useful category yet."
              : "This cash withdrawal is large enough to confirm.",
        metrics: {
          amount: money(spend, currency),
          current: money(spend, currency),
          previous: money(previousComparableTotal, currency),
          change: money(spend - previousComparableTotal, currency),
          percent_change_basis_points: percentChangeBasisPoints(
            spend,
            previousComparableTotal,
          ),
          current_transaction_count: 1,
          previous_transaction_count: priorPeriodMatches.length,
          transaction_count_change: 1 - priorPeriodMatches.length,
          typical_amount:
            typical > 0 ? money(Math.round(typical), currency) : null,
        },
        rule: { key: reviewReason, median_multiple: 3 },
        confidence: typical > 0 ? 9_000 : 8_000,
        evidenceTransactions: [transaction],
        baseUrl,
        generatedAt: asOf,
        dataAsOf,
      }),
    );
  }

  // One transaction causing almost an entire category jump is explanation,
  // not a moral failure. Surface it under needs-review.
  for (const [category, value] of categoryCurrent) {
    const prior = categoryPrevious.get(category) ?? {
      amount: 0,
      count: 0,
      transactions: [],
    };
    const largest = [...value.transactions].sort(
      (a, b) => a.amount_minor - b.amount_minor,
    )[0];
    if (
      !largest ||
      value.amount < minimumChangeMinor ||
      -largest.amount_minor / value.amount < 0.8 ||
      reviewed.has(largest.id)
    ) {
      continue;
    }
    reviewed.add(largest.id);
    findings.push(
      finding({
        family: "weekly",
        type: "needs_review",
        severity: "info",
        identity: `single_charge:${largest.id}`,
        period: periods.current,
        title: `One charge drove ${humanize(category)}`,
        explanation:
          "A single transaction caused at least 80% of this category's spending.",
        metrics: {
          current: money(value.amount, currency),
          previous: money(prior.amount, currency),
          change: money(value.amount - prior.amount, currency),
          percent_change_basis_points: percentChangeBasisPoints(
            value.amount,
            prior.amount,
          ),
          current_transaction_count: value.count,
          previous_transaction_count: prior.count,
          transaction_count_change: value.count - prior.count,
          category_total: money(value.amount, currency),
          transaction_amount: money(-largest.amount_minor, currency),
          share_basis_points: Math.round(
            (-largest.amount_minor / value.amount) * 10_000,
          ),
        },
        rule: { key: "single_charge_category", share_basis_points: 8_000 },
        confidence: 10_000,
        evidenceTransactions: [largest],
        baseUrl,
        generatedAt: asOf,
        dataAsOf,
      }),
    );
  }

  return findings.sort(compareFindings).slice(0, 20);
}

export function detectInvestmentInsights({
  holdings,
  snapshots,
  investmentTransactions,
  asOf = new Date(),
  dataAsOf = asOf,
  currency = "USD",
  concentrationBasisPoints = 2_500,
  concentrationEnabled = true,
  investmentHistoryComplete = false,
  baseUrl = "https://money.example.com",
}) {
  const portfolio = buildPortfolioSummary({
    holdings,
    snapshots,
    investmentTransactions,
    currency,
    now: asOf,
    investmentHistoryComplete,
  });
  const findings = [];
  const period = {
    start_on: portfolio.series[0]?.timestamp ?? null,
    end_on: shiftDateOnly(asOf, 1),
  };
  if (portfolio.series.length >= 2) {
    const current = portfolio.total_value.amount_minor;
    const first = portfolio.series[0].value.amount_minor;
    const week = valueAtOrBefore(portfolio.series, shiftDateOnly(asOf, -7));
    const month = valueAtOrBefore(portfolio.series, shiftDateOnly(asOf, -30));
    findings.push(
      genericFinding({
        family: "investments",
        type: "performance",
        severity: "info",
        identity: "portfolio_performance",
        period,
        title: "Portfolio performance",
        explanation:
          portfolio.estimated_return_basis_points == null
            ? "Value changes are shown, but estimated return is hidden until cash-flow history is complete."
            : "Estimated performance separates recorded contributions and withdrawals from value change.",
        metrics: {
          current_value: portfolio.total_value,
          week_value_change: money(current - week, currency),
          month_value_change: money(current - month, currency),
          since_first_snapshot_change: money(current - first, currency),
          external_cash_flow: portfolio.external_cash_flow,
          contributions: portfolio.contributions,
          withdrawals: portfolio.withdrawals,
          estimated_gain: portfolio.estimated_gain,
          estimated_return_basis_points:
            portfolio.estimated_return_basis_points,
        },
        rule: { key: "portfolio_performance", cash_flows_separated: true },
        confidence:
          portfolio.estimated_return_basis_points == null ? 6_000 : 8_500,
        evidence: portfolio.series.slice(-5).map((point) => ({
          entity_type: "portfolio_snapshot",
          entity_id: point.timestamp,
          label: point.timestamp,
          web_url: `${baseUrl}/portfolio`,
        })),
        actions: [
          action("review", "Review", `${baseUrl}/portfolio`),
          action("dismiss", "Dismiss", `${baseUrl}/insights`),
        ],
        baseUrl,
        generatedAt: asOf,
        dataAsOf,
      }),
    );
  }

  const holdingChanges = holdingValueChanges(snapshots, currency);
  const positive = holdingChanges
    .filter((change) => change.change_minor > 0)
    .sort((a, b) => b.change_minor - a.change_minor)[0];
  const negative = holdingChanges
    .filter((change) => change.change_minor < 0)
    .sort((a, b) => a.change_minor - b.change_minor)[0];
  for (const [direction, change] of [
    ["positive", positive],
    ["negative", negative],
  ]) {
    if (!change) continue;
    findings.push(
      genericFinding({
        family: "investments",
        type: "holding_value_contribution",
        severity: "info",
        identity: `${direction}:${change.security_id}`,
        period,
        title: `${change.ticker_symbol ?? change.name} had the largest ${direction} value contribution`,
        explanation:
          "This is the holding's value change across local snapshots, not a standalone return calculation.",
        metrics: {
          starting_value: money(change.start_minor, currency),
          ending_value: money(change.end_minor, currency),
          value_change: money(change.change_minor, currency),
        },
        rule: { key: `largest_${direction}_holding_value_change` },
        confidence: 8_000,
        evidence: [
          {
            entity_type: "holding",
            entity_id: change.security_id,
            label: change.ticker_symbol ?? change.name,
            web_url: `${baseUrl}/portfolio`,
          },
        ],
        actions: [
          action("review", "Review", `${baseUrl}/portfolio`),
          action("dismiss", "Dismiss", `${baseUrl}/insights`),
        ],
        generatedAt: asOf,
        dataAsOf,
      }),
    );
  }

  const allocationChanges = holdingChanges
    .filter(
      (change) =>
        change.start_allocation_basis_points != null &&
        Math.abs(
          change.end_allocation_basis_points -
            change.start_allocation_basis_points,
        ) >= 500,
    )
    .sort(
      (a, b) =>
        Math.abs(
          b.end_allocation_basis_points -
            b.start_allocation_basis_points,
        ) -
        Math.abs(
          a.end_allocation_basis_points -
            a.start_allocation_basis_points,
        ),
    );
  if (allocationChanges[0]) {
    const change = allocationChanges[0];
    findings.push(
      genericFinding({
        family: "investments",
        type: "allocation_change",
        severity: "attention",
        identity: change.security_id,
        period,
        title: `${change.ticker_symbol ?? change.name} allocation moved meaningfully`,
        explanation:
          "Its portfolio share changed by at least five percentage points across local snapshots.",
        metrics: {
          previous_allocation_basis_points:
            change.start_allocation_basis_points,
          current_allocation_basis_points:
            change.end_allocation_basis_points,
          change_basis_points:
            change.end_allocation_basis_points -
            change.start_allocation_basis_points,
        },
        rule: {
          key: "allocation_change",
          minimum_change_basis_points: 500,
        },
        confidence: 8_500,
        evidence: [
          {
            entity_type: "holding",
            entity_id: change.security_id,
            label: change.ticker_symbol ?? change.name,
            web_url: `${baseUrl}/portfolio`,
          },
        ],
        actions: [
          action("review", "Review", `${baseUrl}/portfolio`),
          action("dismiss", "Dismiss", `${baseUrl}/insights`),
        ],
        generatedAt: asOf,
        dataAsOf,
      }),
    );
  }

  const added = holdingChanges.filter((change) => change.added);
  const removed = holdingChanges.filter((change) => change.removed);
  if (added.length || removed.length) {
    findings.push(
      genericFinding({
        family: "investments",
        type: "holdings_changed",
        severity: "info",
        identity: `${added.map((item) => item.security_id).sort()}:${removed.map((item) => item.security_id).sort()}`,
        period,
        title: "Portfolio holdings changed",
        explanation: `${added.length} holding${added.length === 1 ? " was" : "s were"} added and ${removed.length} ${removed.length === 1 ? "was" : "were"} removed across local snapshots.`,
        metrics: {
          added_count: added.length,
          removed_count: removed.length,
          added_security_ids: added.map((item) => item.security_id),
          removed_security_ids: removed.map((item) => item.security_id),
        },
        rule: { key: "holding_membership_change" },
        confidence: 9_000,
        evidence: [...added, ...removed].slice(0, 10).map((item) => ({
          entity_type: "holding",
          entity_id: item.security_id,
          label: item.ticker_symbol ?? item.name,
          web_url: `${baseUrl}/portfolio`,
        })),
        actions: [
          action("review", "Review", `${baseUrl}/portfolio`),
          action("dismiss", "Dismiss", `${baseUrl}/insights`),
        ],
        generatedAt: asOf,
        dataAsOf,
      }),
    );
  }

  for (const holding of portfolio.holdings) {
    if (!concentrationEnabled) break;
    if (isCashSecurity(holding)) continue;
    if (holding.allocation_basis_points <= concentrationBasisPoints) continue;
    findings.push(
      genericFinding({
        family: "investments",
        type: "concentration",
        severity:
          holding.allocation_basis_points >= 5_000
            ? "important"
            : "attention",
        identity: holding.security_id,
        period,
        title: `${holding.ticker_symbol ?? holding.name} is a concentrated position`,
        explanation:
          "This holding exceeds the configured single-security concentration threshold.",
        metrics: {
          value: holding.value,
          allocation_basis_points: holding.allocation_basis_points,
        },
        rule: {
          key: "single_security_concentration",
          threshold_basis_points: concentrationBasisPoints,
        },
        confidence: 10_000,
        evidence: [
          {
            entity_type: "holding",
            entity_id: holding.id,
            label: holding.ticker_symbol ?? holding.name,
            web_url: `${baseUrl}/portfolio`,
          },
        ],
        actions: [
          action("review", "Review", `${baseUrl}/portfolio`),
          action("dismiss", "Dismiss", `${baseUrl}/insights`),
        ],
        generatedAt: asOf,
        dataAsOf,
      }),
    );
  }

  const fees = investmentTransactions.reduce(
    (sum, transaction) => sum + Math.abs(transaction.fees_minor ?? 0),
    0,
  );
  if (fees > 0) {
    findings.push(
      genericFinding({
        family: "investments",
        type: "fees",
        severity: fees >= 5_000 ? "attention" : "info",
        identity: "fees",
        period,
        title: "Investment fees detected",
        explanation: "Recorded investment transactions include fees.",
        metrics: { fees: money(fees, currency) },
        rule: { key: "investment_fees" },
        confidence: 10_000,
        evidence: investmentTransactions
          .filter((transaction) => (transaction.fees_minor ?? 0) > 0)
          .slice(0, 5)
          .map((transaction) => ({
            entity_type: "investment_transaction",
            entity_id: transaction.id,
            label: transaction.name ?? transaction.transaction_type,
            web_url: `${baseUrl}/portfolio`,
          })),
        actions: [
          action("review", "Review", `${baseUrl}/portfolio`),
          action("dismiss", "Dismiss", `${baseUrl}/insights`),
        ],
        generatedAt: asOf,
        dataAsOf,
      }),
    );
  }

  for (const warning of portfolio.warnings) {
    findings.push(
      genericFinding({
        family: "investments",
        type: warning.includes("stale")
          ? "stale_pricing"
          : warning.includes("cost basis")
            ? "missing_cost_basis"
            : "incomplete_history",
        severity: "info",
        identity: warning,
        period,
        title: warning.replace(/\.$/, ""),
        explanation: warning,
        metrics: {},
        rule: { key: "data_quality" },
        confidence: 10_000,
        evidence: [],
        actions: [
          action("review", "Review", `${baseUrl}/portfolio`),
          action("dismiss", "Dismiss", `${baseUrl}/insights`),
        ],
        generatedAt: asOf,
        dataAsOf,
      }),
    );
  }

  return findings.sort(compareFindings).slice(0, 20);
}

export function detectSubscriptionInsights(
  streams,
  transactions,
  {
    asOf = new Date(),
    dataAsOf = asOf,
    currency = "USD",
    expensiveThresholdMinor = 5_000,
    expensiveEnabled = true,
    baseUrl = "https://money.example.com",
  } = {},
) {
  const active = streams.filter(
    (stream) =>
      stream.currency_code === currency &&
      stream.stream_type === "subscription" &&
      ["active", "resumed", "irregular"].includes(stream.status),
  );
  const subscriptionStreams = streams.filter(
    (stream) =>
      stream.currency_code === currency &&
      stream.stream_type === "subscription",
  );
  const findings = [];
  const transactionById = new Map(
    transactions.map((transaction) => [transaction.id, transaction]),
  );
  const period = {
    start_on: shiftDateOnly(asOf, -365),
    end_on: shiftDateOnly(asOf, 1),
  };
  const total = active.reduce(
    (sum, stream) => sum + stream.monthly_equivalent_minor,
    0,
  );

  const byFamily = groupBy(active, (stream) => stream.service_family);
  for (const [family, matches] of byFamily) {
    if (matches.length < 2) continue;
    const candidates = matches.filter(
      (stream) => stream.duplicate_state === "unknown",
    );
    if (candidates.length < 2) continue;
    const overlapping = candidates.filter((stream, index) =>
      candidates.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          streamsCouldOverlap(stream, other),
      ),
    );
    if (overlapping.length < 2) continue;
    const monthly = overlapping.reduce(
      (sum, stream) => sum + stream.monthly_equivalent_minor,
      0,
    );
    findings.push(
      genericFinding({
        family: "subscriptions",
        type: "possible_duplicate",
        severity: monthly >= 5_000 ? "important" : "attention",
        identity: `duplicate:${family}:${overlapping.map((s) => s.id).sort().join(":")}`,
        period,
        title: `Possible duplicate ${overlapping[0].display_name} subscriptions`,
        explanation:
          "Multiple active streams from the same service family have overlapping billing periods.",
        metrics: {
          service_family: family,
          service: overlapping[0].display_name,
          combined_monthly: money(monthly, currency),
          combined_annual: money(monthly * 12, currency),
          stream_count: overlapping.length,
          charged_account_ids: overlapping
            .map((stream) => stream.account_id)
            .filter(Boolean),
          cadences: [...new Set(overlapping.map((stream) => stream.cadence))],
          recent_amounts: overlapping.flatMap((stream) =>
            stream.transaction_ids
              .map((id) => transactionById.get(id))
              .filter(Boolean)
              .sort((a, b) => b.posted_on.localeCompare(a.posted_on))
              .slice(0, 3)
              .map((transaction) => ({
                transaction_id: transaction.id,
                posted_on: transaction.posted_on,
                amount: money(-transaction.amount_minor, currency),
              })),
          ),
        },
        rule: {
          key: "possible_duplicate",
          requires_confirmation: true,
        },
        confidence: Math.min(
          ...overlapping.map((stream) => stream.confidence_basis_points),
        ),
        evidence: [
          ...overlapping.map((stream) => streamEvidence(stream, baseUrl)),
          ...overlapping.flatMap((stream) =>
            stream.transaction_ids
              .map((id) => transactionById.get(id))
              .filter(Boolean)
              .slice(-2)
              .map((transaction) =>
                transactionEvidence(transaction, baseUrl),
              ),
          ),
        ].slice(0, 12),
        actions: [
          action(
            "confirm",
            "Confirm duplicate",
            `${baseUrl}/recurring?service=${encodeURIComponent(family)}`,
          ),
          action(
            "dismiss",
            "Dismiss",
            `${baseUrl}/insights`,
          ),
        ],
        generatedAt: asOf,
        dataAsOf,
      }),
    );
  }

  const expensiveCount = Math.max(1, Math.ceil(active.length * 0.2));
  const topIds = new Set(
    [...active]
      .sort(
        (a, b) =>
          b.monthly_equivalent_minor - a.monthly_equivalent_minor,
      )
      .slice(0, expensiveCount)
      .map((stream) => stream.id),
  );
  for (const stream of active) {
    if (!expensiveEnabled) break;
    const share =
      total === 0
        ? 0
        : Math.round((stream.monthly_equivalent_minor / total) * 10_000);
    if (
      stream.monthly_equivalent_minor < expensiveThresholdMinor &&
      !(topIds.has(stream.id) && share >= 1_000)
    ) {
      continue;
    }
    findings.push(
      genericFinding({
        family: "subscriptions",
        type: "expensive",
        severity:
          stream.monthly_equivalent_minor >= expensiveThresholdMinor * 2
            ? "important"
            : "attention",
        identity: `expensive:${stream.id}`,
        period,
        title: `${stream.display_name} is an expensive subscription`,
        explanation:
          "Its monthly equivalent crosses the configured threshold or takes a large share of subscription spending.",
        metrics: {
          service_family: stream.service_family,
          service: stream.display_name,
          charged_account_ids: stream.account_id
            ? [stream.account_id]
            : [],
          cadence: stream.cadence,
          monthly: money(stream.monthly_equivalent_minor, currency),
          annual: money(stream.monthly_equivalent_minor * 12, currency),
          recent_amounts: recentAmountsForStream(
            stream,
            transactionById,
            currency,
          ),
          share_basis_points: share,
        },
        rule: {
          key: "expensive_subscription",
          monthly_threshold_minor: expensiveThresholdMinor,
          share_threshold_basis_points: 1_000,
        },
        confidence: stream.confidence_basis_points,
        evidence: streamEvidenceWithTransactions(
          stream,
          transactionById,
          baseUrl,
        ),
        actions: [
          action(
            "review",
            "Review subscription",
            `${baseUrl}/recurring?stream=${stream.id}`,
          ),
          action("confirm", "Confirm", `${baseUrl}/insights`),
          action("dismiss", "Dismiss", `${baseUrl}/insights`),
        ],
        generatedAt: asOf,
        dataAsOf,
      }),
    );
  }

  for (const stream of active) {
    const amounts = stream.transaction_ids
      .map((id) => transactionById.get(id))
      .filter(Boolean)
      .sort((a, b) => a.posted_on.localeCompare(b.posted_on))
      .map((transaction) => ({
        id: transaction.id,
        amount: -transaction.amount_minor,
        transaction,
      }));
    if (amounts.length < 3) continue;
    const latest = amounts.at(-1);
    const stablePrior = median(amounts.slice(-4, -1).map((entry) => entry.amount));
    const increase = latest.amount - stablePrior;
    const percent = percentChangeBasisPoints(latest.amount, stablePrior);
    if (increase < 500 || percent < 1_000) continue;
    findings.push(
      genericFinding({
        family: "subscriptions",
        type: "price_increase",
        severity: percent >= 2_500 ? "important" : "attention",
        identity: `price:${stream.id}`,
        period,
        title: `${stream.display_name} price increased`,
        explanation:
          "The latest charge is at least $5 and 10% above the recent stable amount.",
        metrics: {
          service_family: stream.service_family,
          service: stream.display_name,
          charged_account_ids: stream.account_id
            ? [stream.account_id]
            : [],
          cadence: stream.cadence,
          previous_amount: money(Math.round(stablePrior), currency),
          latest_amount: money(latest.amount, currency),
          change: money(Math.round(increase), currency),
          annual: money(stream.monthly_equivalent_minor * 12, currency),
          recent_amounts: recentAmountsForStream(
            stream,
            transactionById,
            currency,
          ),
          percent_change_basis_points: percent,
        },
        rule: {
          key: "subscription_price_increase",
          minimum_change_minor: 500,
          minimum_change_basis_points: 1_000,
        },
        confidence: stream.confidence_basis_points,
        evidence: streamEvidenceWithTransactions(
          stream,
          transactionById,
          baseUrl,
        ),
        actions: [
          action(
            "review",
            "Review subscription",
            `${baseUrl}/recurring?stream=${stream.id}`,
          ),
          action("confirm", "Confirm", `${baseUrl}/insights`),
          action("dismiss", "Dismiss", `${baseUrl}/insights`),
        ],
        generatedAt: asOf,
        dataAsOf,
      }),
    );
  }

  for (const stream of subscriptionStreams) {
    let type = null;
    if (stream.status === "resumed") type = "resumed";
    else if (stream.status === "canceled") type = "canceled";
    else if (stream.status === "irregular") type = "irregular";
    else if (daysBetween(stream.first_seen_on, shiftDateOnly(asOf, 1)) <= 30) {
      type = "new";
    }
    if (!type) continue;
    findings.push(
      genericFinding({
        family: "subscriptions",
        type,
        severity: type === "canceled" ? "info" : "attention",
        identity: `${type}:${stream.id}`,
        period,
        title: `${stream.display_name} is ${type}`,
        explanation: `The recurring stream is currently classified as ${type}.`,
        metrics: {
          service_family: stream.service_family,
          service: stream.display_name,
          charged_account_ids: stream.account_id
            ? [stream.account_id]
            : [],
          cadence: stream.cadence,
          monthly: money(stream.monthly_equivalent_minor, currency),
          annual: money(stream.monthly_equivalent_minor * 12, currency),
          recent_amounts: recentAmountsForStream(
            stream,
            transactionById,
            currency,
          ),
        },
        rule: { key: `subscription_${type}` },
        confidence: stream.confidence_basis_points,
        evidence: streamEvidenceWithTransactions(
          stream,
          transactionById,
          baseUrl,
        ),
        actions: [
          action(
            "review",
            "Review subscription",
            `${baseUrl}/recurring?stream=${stream.id}`,
          ),
          action("confirm", "Confirm", `${baseUrl}/insights`),
          action("dismiss", "Dismiss", `${baseUrl}/insights`),
        ],
        generatedAt: asOf,
        dataAsOf,
      }),
    );
  }

  return findings.sort(compareFindings).slice(0, 30);
}

export function findingsHash(findings) {
  const canonical = findings
    .map((finding) => ({
      id: finding.id,
      metrics: finding.metrics,
      title: finding.title,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

function finding({
  evidenceTransactions,
  baseUrl,
  ...properties
}) {
  return genericFinding({
    ...properties,
    evidence: evidenceTransactions.map((transaction) =>
      transactionEvidence(transaction, baseUrl),
    ),
    actions: [
      action(
        "review",
        "Review",
        `${baseUrl}/transactions`,
      ),
      action(
        "mark_expected",
        "Mark expected",
        `${baseUrl}/transactions`,
      ),
      action(
        "recategorize",
        "Recategorize",
        `${baseUrl}/transactions`,
      ),
      action("dismiss", "Dismiss", `${baseUrl}/insights`),
    ],
  });
}

function genericFinding({
  family,
  type,
  severity,
  identity,
  period,
  title,
  explanation,
  metrics,
  rule,
  confidence,
  evidence,
  actions,
  generatedAt,
  dataAsOf,
}) {
  const periodEnd = period?.end_on ?? "";
  const id = stableFindingId(family, type, identity, periodEnd);
  return {
    id,
    finding_key: stableFindingKey(family, type, identity),
    family,
    type,
    severity,
    title,
    explanation,
    period_start: period?.start_on ?? null,
    period_end: period?.end_on ?? null,
    metrics,
    rule,
    confidence_basis_points: confidence,
    evidence: routeEvidenceLinks(evidence ?? []),
    actions: routeEvidenceActions(actions ?? [], evidence ?? [], id),
    generated_at: toIso(generatedAt),
    data_as_of: toIso(dataAsOf),
  };
}

function routeEvidenceLinks(evidence) {
  return evidence.map((entry) => {
    const current = new URL(
      entry.web_url ?? "/insights",
      "https://money.example.com",
    );
    if (
      ["recurring", "recurring_stream"].includes(entry.entity_type)
    ) {
      current.pathname = "/recurring";
      current.search = `?item=${encodeURIComponent(entry.entity_id)}`;
    } else if (entry.entity_type === "transaction") {
      current.pathname = "/transactions";
      current.search = `?transaction=${encodeURIComponent(entry.entity_id)}`;
    } else if (entry.entity_type === "holding") {
      current.pathname = "/portfolio";
      current.search = `?holding=${encodeURIComponent(entry.label)}`;
    }
    return { ...entry, web_url: current.toString() };
  });
}

function routeEvidenceActions(actions, evidence, findingId) {
  const routedEvidence = routeEvidenceLinks(evidence);
  const objectEvidence = routedEvidence.filter((entry) =>
    ["recurring", "recurring_stream", "holding"].includes(
      entry.entity_type,
    ),
  );
  const direct =
    objectEvidence.length === 1
      ? objectEvidence[0]
      : objectEvidence.length === 0 && routedEvidence.length === 1
        ? routedEvidence[0]
        : null;
  return actions.map((entry) => {
    if (!["review", "confirm"].includes(entry.type)) return entry;
    if (direct) return { ...entry, web_url: direct.web_url };
    const current = new URL(
      entry.web_url ?? "/insights",
      "https://money.example.com",
    );
    current.pathname = "/insights";
    current.search = `?finding=${encodeURIComponent(findingId)}`;
    return { ...entry, web_url: current.toString() };
  });
}

function transactionEvidence(transaction, baseUrl) {
  return {
    entity_type: "transaction",
    entity_id: transaction.id,
    label: displayMerchant(transaction),
    web_url: `${baseUrl}/transactions?transaction=${encodeURIComponent(transaction.id)}`,
  };
}

function streamEvidence(stream, baseUrl) {
  return {
    entity_type: "recurring",
    entity_id: stream.id,
    label: stream.display_name,
    web_url: `${baseUrl}/recurring?item=${encodeURIComponent(stream.id)}`,
  };
}

function streamEvidenceWithTransactions(stream, transactionById, baseUrl) {
  return [
    streamEvidence(stream, baseUrl),
    ...stream.transaction_ids
      .map((id) => transactionById.get(id))
      .filter(Boolean)
      .sort((left, right) => right.posted_on.localeCompare(left.posted_on))
      .slice(0, 5)
      .map((transaction) => transactionEvidence(transaction, baseUrl)),
  ];
}

function recentAmountsForStream(stream, transactionById, currency) {
  return stream.transaction_ids
    .map((id) => transactionById.get(id))
    .filter(Boolean)
    .sort((left, right) => right.posted_on.localeCompare(left.posted_on))
    .slice(0, 5)
    .map((transaction) => ({
      transaction_id: transaction.id,
      posted_on: transaction.posted_on,
      amount: money(-transaction.amount_minor, currency),
    }));
}

function action(id, label, webUrl) {
  return { type: id, label, web_url: webUrl };
}

function eligibleSpending(transactions, period, currency) {
  return transactions.filter(
    (transaction) =>
      transaction.currency_code === currency &&
      !transaction.pending &&
      !transaction.excluded_from_spending &&
      transaction.amount_minor < 0 &&
      transaction.posted_on >= period.start_on &&
      transaction.posted_on < period.end_on,
  );
}

function aggregate(transactions, keyFunction) {
  const result = new Map();
  for (const transaction of transactions) {
    const key = keyFunction(transaction);
    const value = result.get(key) ?? {
      amount: 0,
      count: 0,
      transactions: [],
    };
    value.amount += -transaction.amount_minor;
    value.count += 1;
    value.transactions.push(transaction);
    result.set(key, value);
  }
  return result;
}

function categoryKey(transaction) {
  return transaction.category_primary ?? "uncategorized";
}

function merchantKey(transaction) {
  return effectiveTransactionName(transaction, "unknown")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}

function isConvenienceTransaction(transaction) {
  return /\b(coffee|cafe|delivery|takeout|fast food|convenience|doordash|uber eats|ubereats|grubhub|seamless|postmates|rideshare|uber|lyft)\b/i.test(
    `${transaction.category_primary ?? ""} ${transaction.category_detailed ?? ""} ${transaction.merchant_name ?? ""} ${transaction.name ?? ""}`,
  );
}

function similarPurchaseKey(transaction) {
  const amountBucket = Math.round(
    Math.abs(transaction.amount_minor) / 500,
  );
  return `${categoryKey(transaction).toLowerCase()}:${amountBucket}`;
}

function displayMerchant(transaction) {
  return effectiveTransactionName(transaction);
}

function humanize(value) {
  return value
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function valueAtOrBefore(series, date) {
  return (
    [...series]
      .reverse()
      .find((point) => point.timestamp <= date)?.value.amount_minor ??
    series[0]?.value.amount_minor ??
    0
  );
}

function holdingValueChanges(snapshots, currency) {
  const included = snapshots.filter(
    (snapshot) =>
      snapshot.currency_code === currency &&
      !isCashSecurity(snapshot),
  );
  if (!included.length) return [];
  const globalDates = [...new Set(included.map((snapshot) => snapshot.snapshot_on))].sort();
  const firstDate = globalDates[0];
  const lastDate = globalDates.at(-1);
  const startTotal = included
    .filter((snapshot) => snapshot.snapshot_on === firstDate)
    .reduce((sum, snapshot) => sum + snapshot.value_minor, 0);
  const endTotal = included
    .filter((snapshot) => snapshot.snapshot_on === lastDate)
    .reduce((sum, snapshot) => sum + snapshot.value_minor, 0);
  const grouped = groupBy(included, (snapshot) => snapshot.security_id);
  return [...grouped.entries()].map(([securityId, values]) => {
    const sorted = [...values].sort((a, b) =>
      a.snapshot_on.localeCompare(b.snapshot_on),
    );
    const first = sorted[0];
    const last = sorted.at(-1);
    const existedAtStart = first.snapshot_on === firstDate;
    const existsAtEnd = last.snapshot_on === lastDate;
    const start = existedAtStart ? first.value_minor : 0;
    const end = existsAtEnd ? last.value_minor : 0;
    return {
      security_id: securityId,
      name: last.name ?? first.name,
      ticker_symbol: last.ticker_symbol ?? first.ticker_symbol,
      start_minor: start,
      end_minor: end,
      change_minor: end - start,
      start_allocation_basis_points:
        existedAtStart && startTotal
          ? Math.round((start / startTotal) * 10_000)
          : null,
      end_allocation_basis_points:
        existsAtEnd && endTotal
          ? Math.round((end / endTotal) * 10_000)
          : null,
      added: !existedAtStart && existsAtEnd,
      removed: existedAtStart && !existsAtEnd,
    };
  });
}

function groupBy(values, keyFunction) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFunction(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function streamsCouldOverlap(left, right) {
  if (
    left.id === right.id ||
    left.duplicate_state === "not_duplicate" ||
    right.duplicate_state === "not_duplicate"
  ) {
    return false;
  }
  // Same descriptor on the same account is usually one detector split, not
  // two real subscriptions. Require a different account or descriptor.
  if (
    left.account_id === right.account_id &&
    left.display_name.toLowerCase() === right.display_name.toLowerCase()
  ) {
    return false;
  }
  const windowDays = Math.max(
    cadenceWindow(left.cadence),
    cadenceWindow(right.cadence),
  );
  return (
    Math.abs(daysBetween(left.last_seen_on, right.last_seen_on)) <= windowDays
  );
}

function cadenceWindow(cadence) {
  return {
    weekly: 10,
    biweekly: 20,
    monthly: 45,
    quarterly: 110,
    annual: 400,
    irregular: 60,
  }[cadence] ?? 45;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function daysBetween(a, b) {
  return Math.round(
    (new Date(`${b}T00:00:00.000Z`) -
      new Date(`${a}T00:00:00.000Z`)) /
      86_400_000,
  );
}

function compareFindings(a, b) {
  const rank = { important: 3, attention: 2, info: 1 };
  return rank[b.severity] - rank[a.severity] || a.id.localeCompare(b.id);
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
