const DAY_MS = 86_400_000;

export const BALANCE_GROUPS = Object.freeze([
  "cash",
  "taxable_investment",
  "retirement",
  "credit_card",
  "loan",
  "other_asset",
  "other_liability",
  "excluded",
]);

export function money(amountMinor, currency = "USD") {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new TypeError("Money values must be safe integer minor units");
  }
  return { amount_minor: amountMinor, currency };
}

export function splitHoldingEquity(holding = {}) {
  const totalValue = holding.value_minor;
  const quantity = Number(holding.quantity);
  const vestedQuantity =
    holding.vested_quantity == null
      ? null
      : Number(holding.vested_quantity);
  const vestedValue = holding.vested_value_minor;
  const price = holding.price_minor;
  const base = {
    current_value_minor: totalValue,
    future_value_minor: null,
    unvested_quantity: null,
    valuation_basis: null,
    observed: false,
    invalid: false,
  };

  if (!Number.isSafeInteger(totalValue) || totalValue < 0) {
    return { ...base, invalid: true };
  }

  const validQuantities =
    Number.isFinite(quantity) &&
    quantity >= 0 &&
    Number.isFinite(vestedQuantity) &&
    vestedQuantity >= 0 &&
    vestedQuantity <= quantity;
  const unvestedQuantity = validQuantities
    ? quantity - vestedQuantity
    : null;

  if (vestedValue != null) {
    if (
      !Number.isSafeInteger(vestedValue) ||
      vestedValue < 0 ||
      vestedValue > totalValue ||
      (vestedQuantity != null && !validQuantities)
    ) {
      return { ...base, invalid: true };
    }
    return {
      current_value_minor: vestedValue,
      future_value_minor: totalValue - vestedValue,
      unvested_quantity: unvestedQuantity,
      valuation_basis: "reported_vested_value",
      observed: true,
      invalid: false,
    };
  }

  if (vestedQuantity == null) return base;
  if (
    !validQuantities ||
    !Number.isSafeInteger(price) ||
    price < 0
  ) {
    return { ...base, invalid: true };
  }

  const futureValue = Math.round(unvestedQuantity * price);
  if (
    !Number.isSafeInteger(futureValue) ||
    futureValue < 0 ||
    futureValue > totalValue + 1
  ) {
    return { ...base, invalid: true };
  }
  const boundedFutureValue = Math.min(totalValue, futureValue);
  return {
    current_value_minor: totalValue - boundedFutureValue,
    future_value_minor: boundedFutureValue,
    unvested_quantity: unvestedQuantity,
    valuation_basis: "quantity_at_reported_price",
    observed: true,
    invalid: false,
  };
}

export function percentChangeBasisPoints(current, previous) {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / Math.abs(previous)) * 10_000);
}

export function completedWeeklyPeriods(asOf = new Date()) {
  const currentEnd = startOfUtcDay(asOf);
  const currentStart = shiftUtcDays(currentEnd, -7);
  const previousStart = shiftUtcDays(currentEnd, -14);
  return {
    current: {
      start_on: dateOnly(currentStart),
      end_on: dateOnly(currentEnd),
    },
    previous: {
      start_on: dateOnly(previousStart),
      end_on: dateOnly(currentStart),
    },
  };
}

export function inferBalanceGroup(account = {}) {
  const type = normalizedAccountLabel(account.type);
  const subtype = normalizedAccountLabel(account.subtype);
  const override = canonicalBalanceGroup(account.balance_group_override);
  const effective = canonicalBalanceGroup(account.balance_group);
  const retirementIdentity =
    isRetirementSubtype(subtype) || effective === "retirement";
  const requestedGroup = override ?? effective;
  if (
    retirementIdentity &&
    ["cash", "taxable_investment"].includes(requestedGroup)
  ) {
    return "retirement";
  }
  if (override) return override;
  if (effective) return effective;
  if (retirementIdentity) return "retirement";

  const liability =
    Boolean(account.is_liability) ||
    type === "credit" ||
    type === "loan";

  if (type === "credit" || subtype === "credit_card") {
    return "credit_card";
  }
  if (type === "loan" || liability) {
    return type === "loan" ? "loan" : "other_liability";
  }
  if (type === "investment" || type === "brokerage") {
    return isRetirementSubtype(subtype)
      ? "retirement"
      : "taxable_investment";
  }
  if (
    type === "depository" ||
    type === "cash" ||
    [
      "checking",
      "savings",
      "cash_management",
      "money_market",
      "certificate_of_deposit",
      "cd",
      "prepaid",
    ].includes(subtype)
  ) {
    return "cash";
  }
  return liability ? "other_liability" : "other_asset";
}

export function buildBalanceSummary({
  accounts,
  manualAssets = [],
  currency = "USD",
}) {
  const totals = {
    cash: 0,
    taxable_investment: 0,
    retirement: 0,
    credit_card: 0,
    loan: 0,
    other_asset: 0,
    other_liability: 0,
  };
  const cashBreakdown = {
    checking_accounts: 0,
    savings_accounts: 0,
    personal_brokerage_accounts: 0,
    other_cash_accounts: 0,
  };
  let includedAccountCount = 0;
  let unknownBalanceCount = 0;
  let excludedCurrencyCount = 0;

  for (const account of accounts) {
    if (account.currency_code !== currency) {
      excludedCurrencyCount += 1;
      continue;
    }
    const group = inferBalanceGroup(account);
    if (group === "excluded") continue;
    includedAccountCount += 1;
    if (account.current_balance_minor == null) {
      unknownBalanceCount += 1;
      continue;
    }
    // Plaid reports liabilities as positive balances owed and overpayments as
    // negative balances. Keep that sign: a negative card balance is an asset
    // to the owner, not mysteriously more debt.
    const balance = account.current_balance_minor;
    totals[group] += balance;

    if (group === "taxable_investment") {
      cashBreakdown.personal_brokerage_accounts += balance;
    } else if (group === "cash") {
      const subtype = normalizedAccountLabel(account.subtype);
      if (subtype === "checking") {
        cashBreakdown.checking_accounts += balance;
      } else if (subtype === "savings") {
        cashBreakdown.savings_accounts += balance;
      } else {
        cashBreakdown.other_cash_accounts += balance;
      }
    }
  }

  const manualAssetValue = manualAssets
    .filter(
      (asset) =>
        asset.currency_code === currency &&
        asset.active !== false &&
        asset.value_minor != null,
    )
    .reduce((sum, asset) => sum + asset.value_minor, 0);
  excludedCurrencyCount += manualAssets.filter(
    (asset) =>
      asset.active !== false &&
      asset.value_minor != null &&
      asset.currency_code !== currency,
  ).length;
  unknownBalanceCount += manualAssets.filter(
    (asset) =>
      asset.active !== false &&
      asset.currency_code === currency &&
      asset.value_minor == null,
  ).length;
  const connectedAssets =
    totals.cash +
    totals.taxable_investment +
    totals.retirement +
    totals.other_asset;
  const totalAssets = connectedAssets + manualAssetValue;
  const totalLiabilities =
    totals.credit_card + totals.loan + totals.other_liability;
  const cashBalance = totals.cash + totals.taxable_investment;
  const shortTermWorth = cashBalance - totals.credit_card;

  return {
    currency,
    cash: money(totals.cash, currency),
    cash_balance: money(cashBalance, currency),
    cash_balance_breakdown: Object.fromEntries(
      Object.entries(cashBreakdown).map(([key, value]) => [
        key,
        money(value, currency),
      ]),
    ),
    short_term_worth: money(shortTermWorth, currency),
    taxable_investments: money(totals.taxable_investment, currency),
    retirement_assets: money(totals.retirement, currency),
    retirement_investments: money(totals.retirement, currency),
    manual_asset_value: money(manualAssetValue, currency),
    other_assets: money(totals.other_asset, currency),
    credit_card_liabilities: money(totals.credit_card, currency),
    loan_liabilities: money(totals.loan, currency),
    other_liabilities: money(totals.other_liability, currency),
    total_assets: money(totalAssets, currency),
    total_liabilities: money(totalLiabilities, currency),
    net_worth: money(totalAssets - totalLiabilities, currency),
    included_account_count: includedAccountCount,
    unknown_balance_count: unknownBalanceCount,
    excluded_from_usd_total_count: excludedCurrencyCount,
  };
}

export function buildCreditSummary({
  accounts = [],
  snapshots = [],
  currency = "USD",
  currentOn = null,
} = {}) {
  const creditAccounts = accounts
    .filter(
      (account) =>
        account.active !== false &&
        inferBalanceGroup(account) === "credit_card",
    )
    .sort((left, right) =>
      [
        left.institution_name ?? "",
        left.name ?? "",
        left.id ?? "",
      ]
        .join("\u0000")
        .localeCompare(
          [
            right.institution_name ?? "",
            right.name ?? "",
            right.id ?? "",
          ].join("\u0000"),
        ),
    );
  const accountById = new Map(
    creditAccounts.map((account) => [account.id, account]),
  );
  const snapshotsByAccount = new Map(
    creditAccounts.map((account) => [account.id, new Map()]),
  );

  for (const snapshot of snapshots) {
    if (!accountById.has(snapshot.account_id) || !snapshot.snapshot_on) {
      continue;
    }
    snapshotsByAccount
      .get(snapshot.account_id)
      .set(dateOnly(snapshot.snapshot_on), snapshot);
  }

  if (currentOn) {
    const snapshotOn = dateOnly(currentOn);
    for (const account of creditAccounts) {
      snapshotsByAccount.get(account.id).set(snapshotOn, {
        account_id: account.id,
        snapshot_on: snapshotOn,
        current_balance_minor: account.current_balance_minor,
        available_balance_minor: account.available_balance_minor,
        credit_limit_minor: account.credit_limit_minor,
        currency_code: account.currency_code,
      });
    }
  }

  const cards = creditAccounts.map((account) => {
    const current = creditValues(account);
    const series = [...snapshotsByAccount.get(account.id).values()]
      .sort((left, right) =>
        String(left.snapshot_on).localeCompare(String(right.snapshot_on)),
      )
      .map((snapshot) => ({
        timestamp: dateOnly(snapshot.snapshot_on),
        ...creditValues(snapshot),
      }));
    return {
      id: account.id,
      institution: account.institution_name ?? "Other",
      name: account.name ?? "Credit card",
      mask: account.mask ?? null,
      ...current,
      series,
    };
  });

  const summary = aggregateCreditValues(creditAccounts, currency);
  const eventsByDate = new Map();
  for (const card of cards) {
    const account = accountById.get(card.id);
    if (account.currency_code !== currency) continue;
    for (const point of card.series) {
      const events = eventsByDate.get(point.timestamp) ?? [];
      events.push({ account_id: card.id, point });
      eventsByDate.set(point.timestamp, events);
    }
  }

  const latestByAccount = new Map();
  const series = [...eventsByDate.keys()]
    .sort()
    .map((timestamp) => {
      for (const event of eventsByDate.get(timestamp)) {
        latestByAccount.set(event.account_id, event.point);
      }
      const pointSummary = aggregateCreditValues(
        [...latestByAccount.values()].map((point) => ({
          currency_code: currency,
          current_balance_minor:
            point.current_balance?.amount_minor ?? null,
          credit_limit_minor:
            point.credit_limit?.amount_minor ?? null,
        })),
        currency,
      );
      return {
        timestamp,
        balance_owed: pointSummary.total_balance_owed,
        total_credit_limit: pointSummary.total_credit_limit,
        utilization_basis_points:
          pointSummary.utilization_basis_points,
        partial:
          pointSummary.missing_limit_card_count > 0 ||
          pointSummary.missing_balance_card_count > 0,
      };
    });

  return {
    currency,
    summary: {
      card_count: creditAccounts.length,
      total_balance_owed: summary.total_balance_owed,
      total_credit_limit: summary.total_credit_limit,
      available_credit: summary.available_credit,
      utilization_basis_points: summary.utilization_basis_points,
      utilization_covered_card_count:
        summary.utilization_covered_card_count,
      missing_limit_card_count: summary.missing_limit_card_count,
      missing_balance_card_count: summary.missing_balance_card_count,
      excluded_from_usd_total_count:
        summary.excluded_from_usd_total_count,
    },
    cards,
    series,
  };
}

export function buildOverview({
  accounts,
  transactions,
  holdings = [],
  recurringStreams = [],
  manualAssets = [],
  currency = "USD",
  periodStart,
  periodEnd,
}) {
  const balanceSummary = buildBalanceSummary({
    accounts,
    manualAssets,
    currency,
  });
  const portfolio = holdings
    .filter((holding) => holding.currency_code === currency)
    .reduce((sum, holding) => sum + holding.value_minor, 0);
  const periodTransactions = transactions.filter(
    (transaction) =>
      transaction.posted_on >= periodStart &&
      transaction.posted_on < periodEnd,
  );
  const { income, spending } = cashFlowTotals(periodTransactions, currency);
  const subscriptions = recurringStreams
    .filter(
      (stream) =>
        stream.currency_code === currency &&
        stream.stream_type === "subscription" &&
        ["active", "resumed", "irregular"].includes(stream.status),
    )
    .reduce((sum, stream) => sum + stream.monthly_equivalent_minor, 0);

  return {
    currency,
    period: { start_on: periodStart, end_on: periodEnd },
    ...balanceSummary,
    assets: balanceSummary.total_assets,
    liabilities: balanceSummary.total_liabilities,
    portfolio: money(portfolio, currency),
    spending: money(spending, currency),
    income: money(income, currency),
    cash_flow: money(income - spending, currency),
    subscriptions_monthly: money(subscriptions, currency),
    account_count: balanceSummary.included_account_count,
    manual_asset_count: manualAssets.filter(
      (asset) => asset.active !== false,
    ).length,
  };
}

function creditValues(account) {
  const currency = account.currency_code ?? "USD";
  const balance = safeMinor(account.current_balance_minor);
  const limit = safeNonnegativeMinor(account.credit_limit_minor);
  const balanceOwed = balance == null ? null : Math.max(balance, 0);
  const hasUtilization =
    balanceOwed != null && limit != null && limit > 0;
  return {
    current_balance:
      balance == null ? null : money(balance, currency),
    balance_owed:
      balanceOwed == null ? null : money(balanceOwed, currency),
    credit_limit:
      limit == null ? null : money(limit, currency),
    available_credit:
      hasUtilization ? money(limit - balanceOwed, currency) : null,
    utilization_basis_points:
      hasUtilization
        ? Math.round((balanceOwed / limit) * 10_000)
        : null,
    over_limit:
      hasUtilization && balanceOwed > limit,
    partial: balance == null || limit == null || limit <= 0,
  };
}

function aggregateCreditValues(accounts, currency) {
  let totalBalanceOwed = 0;
  let totalCreditLimit = 0;
  let coveredBalanceOwed = 0;
  let coveredCreditLimit = 0;
  let availableCredit = 0;
  let coveredCardCount = 0;
  let missingLimitCardCount = 0;
  let missingBalanceCardCount = 0;
  let excludedCurrencyCount = 0;

  for (const account of accounts) {
    if ((account.currency_code ?? "USD") !== currency) {
      excludedCurrencyCount += 1;
      continue;
    }
    const balance = safeMinor(account.current_balance_minor);
    const limit = safeNonnegativeMinor(account.credit_limit_minor);
    const balanceOwed = balance == null ? null : Math.max(balance, 0);
    if (balanceOwed == null) {
      missingBalanceCardCount += 1;
    } else {
      totalBalanceOwed += balanceOwed;
    }
    if (limit == null || limit <= 0) {
      missingLimitCardCount += 1;
    } else {
      totalCreditLimit += limit;
    }
    if (balanceOwed != null && limit != null && limit > 0) {
      coveredBalanceOwed += balanceOwed;
      coveredCreditLimit += limit;
      availableCredit += limit - balanceOwed;
      coveredCardCount += 1;
    }
  }

  return {
    total_balance_owed: money(totalBalanceOwed, currency),
    total_credit_limit: money(totalCreditLimit, currency),
    available_credit: money(availableCredit, currency),
    utilization_basis_points:
      coveredCreditLimit > 0
        ? Math.round(
            (coveredBalanceOwed / coveredCreditLimit) * 10_000,
          )
        : null,
    utilization_covered_card_count: coveredCardCount,
    missing_limit_card_count: missingLimitCardCount,
    missing_balance_card_count: missingBalanceCardCount,
    excluded_from_usd_total_count: excludedCurrencyCount,
  };
}

function safeMinor(value) {
  const normalized = value == null ? null : Number(value);
  return Number.isSafeInteger(normalized) ? normalized : null;
}

function safeNonnegativeMinor(value) {
  const normalized = safeMinor(value);
  return normalized != null && normalized >= 0 ? normalized : null;
}

export function buildSpendingSummary({
  transactions,
  currentPeriod,
  previousPeriod,
  groupBy = "category",
  currency = "USD",
}) {
  if (!["category", "merchant", "account"].includes(groupBy)) {
    throw new TypeError("groupBy must be category, merchant, or account");
  }
  const current = spendingTransactions(
    transactions,
    currentPeriod,
    currency,
  );
  const previous = spendingTransactions(
    transactions,
    previousPeriod,
    currency,
  );
  const total = sumSpend(current);
  const previousTotal = sumSpend(previous);
  const grouped = groupSpendingTransactions(current, groupBy);
  const previousGrouped = groupSpendingTransactions(previous, groupBy);
  const segments = [...grouped.entries()]
    .filter(([, value]) => value.amount > 0)
    .map(([label, value]) => {
      const previousAmount = Math.max(
        0,
        previousGrouped.get(label)?.amount ?? 0,
      );
      return {
        label,
        amount: money(value.amount, currency),
        previous_amount: money(previousAmount, currency),
        count: value.count,
        share_basis_points:
          total === 0 ? 0 : Math.round((value.amount / total) * 10_000),
        trend: {
          amount: money(value.amount - previousAmount, currency),
          percent_basis_points: percentChangeBasisPoints(
            value.amount,
            previousAmount,
          ),
          direction:
            value.amount === previousAmount
              ? "flat"
              : value.amount > previousAmount
                ? "up"
                : "down",
        },
      };
    })
    .sort((a, b) => b.amount.amount_minor - a.amount.amount_minor);

  const daily = new Map();
  for (const transaction of current) {
    daily.set(
      transaction.posted_on,
      (daily.get(transaction.posted_on) ?? 0) + -transaction.amount_minor,
    );
  }
  const series = [];
  for (
    let timestamp = dateOnly(currentPeriod.start_on);
    timestamp < dateOnly(currentPeriod.end_on);
    timestamp = shiftDateOnly(timestamp, 1)
  ) {
    series.push({
      timestamp,
      value: money(daily.get(timestamp) ?? 0, currency),
    });
  }

  return {
    currency,
    group_by: groupBy,
    period: currentPeriod,
    previous_period: previousPeriod,
    total: money(total, currency),
    previous_total: money(previousTotal, currency),
    trend: {
      amount: money(total - previousTotal, currency),
      percent_basis_points: percentChangeBasisPoints(total, previousTotal),
      direction:
        total === previousTotal ? "flat" : total > previousTotal ? "up" : "down",
    },
    transaction_count: uniqueSpendingTransactionCount(current),
    segments,
    series,
  };
}

function groupSpendingTransactions(transactions, groupBy) {
  const grouped = new Map();
  for (const transaction of transactions) {
    const key =
      groupBy === "category"
        ? transaction.category_primary ?? "Uncategorized"
        : groupBy === "merchant"
          ? transaction.merchant_name ?? transaction.name ?? "Unknown"
          : transaction.account_name ?? "Account";
    const entry = grouped.get(key) ?? {
      amount: 0,
      transactionIds: new Set(),
    };
    entry.amount += -transaction.amount_minor;
    entry.transactionIds.add(spendingTransactionIdentity(transaction));
    entry.count = entry.transactionIds.size;
    grouped.set(key, entry);
  }
  return grouped;
}

function uniqueSpendingTransactionCount(transactions) {
  return new Set(
    transactions.map(spendingTransactionIdentity),
  ).size;
}

function spendingTransactionIdentity(transaction) {
  return transaction.split_parent_id ?? transaction.id ?? transaction;
}

export function buildCashFlow({
  transactions,
  period,
  interval = "week",
  currency = "USD",
}) {
  if (!["day", "week", "month"].includes(interval)) {
    throw new TypeError("interval must be day, week, or month");
  }
  const included = postedLedgerTransactions(transactions, period, currency);
  const totals = cashFlowTotals(included, currency);
  const buckets = new Map();
  for (const transaction of included) {
    const key = bucketStart(transaction.posted_on, interval);
    const bucket = buckets.get(key) ?? { income: 0, spending: 0 };
    if (transaction.amount_minor > 0 && isIncomeTransaction(transaction)) {
      bucket.income += transaction.amount_minor;
    } else if (transaction.amount_minor > 0) {
      bucket.spending -= transaction.amount_minor;
    } else {
      bucket.spending += -transaction.amount_minor;
    }
    buckets.set(key, bucket);
  }
  return {
    currency,
    period,
    interval,
    income: money(totals.income, currency),
    spending: money(totals.spending, currency),
    net: money(totals.income - totals.spending, currency),
    buckets: [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([timestamp, value]) => ({
        timestamp,
        income: money(value.income, currency),
        spending: money(value.spending, currency),
        net: money(value.income - value.spending, currency),
      })),
  };
}

export function buildNetWorthHistory({
  snapshots,
  manualAssets = null,
  manualAssetValuations = [],
  currency = "USD",
}) {
  const accountEvents = new Map();
  for (const snapshot of snapshots) {
    if (snapshot.currency_code !== currency) continue;
    const events = accountEvents.get(snapshot.snapshot_on) ?? [];
    events.push(snapshot);
    accountEvents.set(snapshot.snapshot_on, events);
  }

  const manualAssetsById = new Map(
    (manualAssets ?? []).map((asset) => [asset.id, asset]),
  );
  const restrictManualAssets = manualAssets != null;
  const manualEvents = new Map();
  for (const valuation of manualAssetValuations) {
    const assetId =
      valuation.manual_asset_id ?? valuation.asset_id ?? valuation.id;
    if (
      !assetId ||
      (restrictManualAssets && !manualAssetsById.has(assetId)) ||
      valuation.currency_code !== currency ||
      valuation.value_minor == null
    ) {
      continue;
    }
    const rawTimestamp =
      valuation.valued_on ??
      valuation.valuation_on ??
      valuation.as_of;
    if (!rawTimestamp) continue;
    const timestamp = dateOnly(rawTimestamp);
    const events = manualEvents.get(timestamp) ?? [];
    events.push({ asset_id: assetId, value_minor: valuation.value_minor });
    manualEvents.set(timestamp, events);
  }

  const dates = [
    ...new Set([
      ...accountEvents.keys(),
      ...manualEvents.keys(),
      ...(manualAssets ?? [])
        .map((asset) =>
          asset.archived_at ? dateOnly(asset.archived_at) : null,
        )
        .filter(Boolean),
    ]),
  ].sort();
  const accountBalances = new Map();
  const manualValues = new Map();
  const series = dates.map((timestamp) => {
    for (const snapshot of accountEvents.get(timestamp) ?? []) {
      accountBalances.set(
        snapshot.account_id ??
          `${snapshot.account_name ?? "account"}:${snapshot.type ?? "other"}`,
        snapshot,
      );
    }
    for (const valuation of manualEvents.get(timestamp) ?? []) {
      manualValues.set(valuation.asset_id, valuation.value_minor);
    }
    let assets = 0;
    let liabilities = 0;
    const accountGroups = {
      cash: 0,
      taxable_investment: 0,
      retirement: 0,
      credit_card: 0,
      loan: 0,
      other_asset: 0,
      other_liability: 0,
    };
    for (const snapshot of accountBalances.values()) {
      if (snapshot.current_balance_minor == null) continue;
      const group = inferBalanceGroup(snapshot);
      if (group === "excluded") continue;
      accountGroups[group] += snapshot.current_balance_minor;
      if (
        ["credit_card", "loan", "other_liability"].includes(group)
      ) {
        liabilities += snapshot.current_balance_minor;
      } else {
        assets += snapshot.current_balance_minor;
      }
    }
    const manualAssetValue = [...manualValues.entries()].reduce(
      (sum, [assetId, value]) => {
        if (!restrictManualAssets) return sum + value;
        const asset = manualAssetsById.get(assetId);
        if (!asset) return sum;
        const createdOn = asset.created_at
          ? dateOnly(asset.created_at)
          : null;
        const archivedOn = asset.archived_at
          ? dateOnly(asset.archived_at)
          : null;
        if (createdOn && timestamp < createdOn) return sum;
        if (archivedOn && timestamp >= archivedOn) return sum;
        if (asset.active === false && !archivedOn) return sum;
        return sum + value;
      },
      0,
    );
    assets += manualAssetValue;
    const cashBalance =
      accountGroups.cash + accountGroups.taxable_investment;
    const shortTermWorth =
      cashBalance - accountGroups.credit_card;
    return {
      timestamp,
      assets: money(assets, currency),
      liabilities: money(liabilities, currency),
      manual_asset_value: money(manualAssetValue, currency),
      cash_balance: money(cashBalance, currency),
      short_term_worth: money(shortTermWorth, currency),
      retirement_assets: money(accountGroups.retirement, currency),
      net_worth: money(assets - liabilities, currency),
    };
  });
  const current = series.at(-1) ?? {
    assets: money(0, currency),
    liabilities: money(0, currency),
    manual_asset_value: money(0, currency),
    cash_balance: money(0, currency),
    short_term_worth: money(0, currency),
    retirement_assets: money(0, currency),
    net_worth: money(0, currency),
  };
  return {
    currency,
    current_assets: current.assets,
    current_liabilities: current.liabilities,
    current_manual_asset_value: current.manual_asset_value,
    current_cash_balance: current.cash_balance,
    current_short_term_worth: current.short_term_worth,
    current_retirement_assets: current.retirement_assets,
    current_net_worth: current.net_worth,
    series,
  };
}

function holdingKey(holding) {
  const securityId = holding.security_id ?? holding.id ?? "";
  return `${holding.account_id ?? ""}:${securityId}`;
}

export function buildPortfolioSummary({
  holdings,
  snapshots,
  investmentTransactions = [],
  currency = "USD",
  now = new Date(),
  investmentHistoryComplete = false,
  retirementScope = "include",
}) {
  if (!["include", "exclude", "only"].includes(retirementScope)) {
    throw new TypeError(
      "retirementScope must be include, exclude, or only",
    );
  }
  const includedHoldings = holdings.filter(
    (holding) => holding.currency_code === currency,
  );
  const holdingSplits = includedHoldings.map((holding) => ({
    holding,
    split: splitHoldingEquity(holding),
  }));
  const total = holdingSplits.reduce(
    (sum, entry) => sum + entry.split.current_value_minor,
    0,
  );
  const holdingsResult = holdingSplits.map(({ holding, split }) => ({
    id: holding.id,
    security_id: holding.security_id,
    name: holding.name,
    ticker_symbol: holding.ticker_symbol,
    security_type: holding.security_type,
    balance_group: holding.balance_group ?? null,
    value: money(split.current_value_minor, currency),
    cost_basis:
      holding.cost_basis_minor == null ||
      (split.future_value_minor ?? 0) > 0
        ? null
        : money(holding.cost_basis_minor, currency),
    quantity: split.observed
      ? holding.vested_quantity ?? null
      : holding.quantity,
    allocation_basis_points:
      total === 0
        ? 0
        : Math.round(
            (split.current_value_minor / total) * 10_000,
          ),
    price_as_of: holding.close_price_as_of,
  }));

  const futureHoldings = holdingSplits
    .filter(({ split }) => (split.future_value_minor ?? 0) > 0)
    .map(({ holding, split }) => ({
      holding_id: holding.id,
      account_id: holding.account_id,
      account_name: holding.account_name ?? null,
      security_id: holding.security_id,
      name: holding.name,
      ticker_symbol: holding.ticker_symbol,
      unvested_quantity: split.unvested_quantity,
      value: money(split.future_value_minor, currency),
      observed_at: holding.as_of ?? null,
      valuation_basis: split.valuation_basis,
    }))
    .sort(
      (left, right) =>
        right.value.amount_minor - left.value.amount_minor,
    );
  const futureTotal = futureHoldings.reduce(
    (sum, holding) => sum + holding.value.amount_minor,
    0,
  );

  const allocationGroups = new Map();
  for (const { holding, split } of holdingSplits) {
    const key = holding.security_type ?? "other";
    allocationGroups.set(
      key,
      (allocationGroups.get(key) ?? 0) +
        split.current_value_minor,
    );
  }
  const allocation = [...allocationGroups.entries()]
    .map(([label, value]) => ({
      label,
      value: money(value, currency),
      share_basis_points:
        total === 0 ? 0 : Math.round((value / total) * 10_000),
    }))
    .sort((a, b) => b.value.amount_minor - a.value.amount_minor);

  const vestingAwareKeys = new Set(
    holdingSplits
      .filter(({ split }) => split.observed)
      .map(({ holding }) => holdingKey(holding)),
  );
  const snapshotsByDate = new Map();
  for (const snapshot of snapshots) {
    if (snapshot.currency_code !== currency) continue;
    const values = snapshotsByDate.get(snapshot.snapshot_on) ?? [];
    values.push(snapshot);
    snapshotsByDate.set(snapshot.snapshot_on, values);
  }
  const byDate = new Map();
  const includedSnapshots = [];
  for (const [snapshotOn, values] of snapshotsByDate) {
    const splitValues = values.map((snapshot) => ({
      snapshot,
      split: splitHoldingEquity(snapshot),
    }));
    const observedKeys = new Set(
      splitValues
        .filter(({ split }) => split.observed)
        .map(({ snapshot }) => holdingKey(snapshot)),
    );
    if (
      [...vestingAwareKeys].some(
        (key) => !observedKeys.has(key),
      )
    ) {
      continue;
    }
    byDate.set(
      snapshotOn,
      splitValues.reduce(
        (sum, entry) => sum + entry.split.current_value_minor,
        0,
      ),
    );
    includedSnapshots.push(...splitValues);
  }
  const series = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([timestamp, value]) => ({
      timestamp,
      value: money(value, currency),
    }));

  const first = series[0];
  const externalFlowTransactions = investmentTransactions.filter(
      (transaction) =>
        transaction.currency_code === currency &&
        isExternalInvestmentFlow(transaction),
    );
  const contributions = externalFlowTransactions
    .filter((transaction) => !isWithdrawal(transaction))
    .reduce(
      (sum, transaction) => sum + Math.abs(transaction.amount_minor),
      0,
    );
  const withdrawals = externalFlowTransactions
    .filter(isWithdrawal)
    .reduce(
      (sum, transaction) => sum + Math.abs(transaction.amount_minor),
      0,
    );
  const externalFlows = contributions - withdrawals;
  const valueOnlyVesting = includedSnapshots.some(
    ({ snapshot, split }) =>
      split.observed &&
      snapshot.vested_quantity == null,
  );
  const vestedQuantityChanged = [...vestingAwareKeys].some((key) => {
    const quantities = includedSnapshots
      .filter(
        ({ snapshot, split }) =>
          holdingKey(snapshot) === key &&
          split.observed &&
          snapshot.vested_quantity != null,
      )
      .map(({ snapshot }) => Number(snapshot.vested_quantity));
    return new Set(quantities).size > 1;
  });
  const vestingPerformanceUnreliable =
    valueOnlyVesting || vestedQuantityChanged;
  const completeHistory =
    investmentHistoryComplete &&
    Boolean(first) &&
    differenceInDays(first.timestamp, dateOnly(now)) >= 7 &&
    hasContinuousSnapshotCoverage(series) &&
    includedHoldings.every(
      (holding) =>
        holding.close_price_as_of != null &&
        differenceInDays(holding.close_price_as_of, dateOnly(now)) <= 3,
    ) &&
    !vestingPerformanceUnreliable;
  const estimatedGain =
    completeHistory && first
      ? total - first.value.amount_minor - externalFlows
      : null;
  const estimatedReturn =
    estimatedGain == null || first.value.amount_minor === 0
      ? null
      : Math.round(
          (estimatedGain / Math.abs(first.value.amount_minor)) * 10_000,
        );

  const warnings = [];
  if (!series.length) warnings.push("Portfolio history begins after the first local snapshot.");
  if (
    includedHoldings.some((holding) => holding.cost_basis_minor == null)
  ) {
    warnings.push("Some holdings are missing cost basis.");
  }
  if (
    includedHoldings.some((holding) => {
      if (!holding.close_price_as_of) return true;
      return differenceInDays(holding.close_price_as_of, dateOnly(now)) > 3;
    })
  ) {
    warnings.push("Some holding prices are stale.");
  }
  if (!completeHistory) {
    warnings.push("Estimated return is hidden until history and cash flows are complete.");
  }
  if (holdingSplits.some(({ split }) => split.invalid)) {
    warnings.push(
      "Some provider vesting data was inconsistent, so future equity was hidden.",
    );
  }
  if (vestingPerformanceUnreliable) {
    warnings.push(
      "Estimated return is hidden when vesting changes cannot be separated from market performance.",
    );
  }

  return {
    currency,
    retirement_scope: retirementScope,
    total_value: money(total, currency),
    future_equity:
      futureTotal > 0
        ? {
            total_value: money(futureTotal, currency),
            valuation_basis: "provider_reported_price",
            holdings: futureHoldings,
          }
        : null,
    holdings: holdingsResult,
    allocation,
    series,
    external_cash_flow: money(externalFlows, currency),
    contributions: money(contributions, currency),
    withdrawals: money(withdrawals, currency),
    estimated_gain:
      estimatedGain == null ? null : money(estimatedGain, currency),
    estimated_return_basis_points: estimatedReturn,
    warnings,
  };
}

function canonicalBalanceGroup(value) {
  if (value == null || value === "") return null;
  const normalized = normalizedAccountLabel(value);
  const aliases = {
    liquid_cash: "cash",
    short_term_cash: "cash",
    brokerage: "taxable_investment",
    personal_brokerage: "taxable_investment",
    short_term_investment: "taxable_investment",
    retirement_asset: "retirement",
    retirement_investment: "retirement",
    credit: "credit_card",
    credit_cards: "credit_card",
    loans: "loan",
    asset: "other_asset",
    liability: "other_liability",
    ignore: "excluded",
  };
  const canonical = aliases[normalized] ?? normalized;
  if (!BALANCE_GROUPS.includes(canonical)) {
    throw new TypeError(`Unsupported balance group override: ${value}`);
  }
  return canonical;
}

function normalizedAccountLabel(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isRetirementSubtype(subtype) {
  return /(?:^|_)(?:401a|401k|403b|457b|ira|roth|sep_ira|simple_ira|sarsep|pension|retirement|profit_sharing|thrift_savings|non_taxable_brokerage|hsa|health_savings_account|keogh|sipp|rrsp|rrif|lif|lira|lrif|lrsp|prif|rlif|fixed_annuity|variable_annuity)(?:_|$)/.test(
    subtype,
  );
}

export function periodForMonth(date = new Date()) {
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
  );
  const end = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  );
  const previousStart = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1),
  );
  return {
    current: { start_on: dateOnly(start), end_on: dateOnly(end) },
    previous: { start_on: dateOnly(previousStart), end_on: dateOnly(start) },
  };
}

export function dateOnly(date) {
  return typeof date === "string"
    ? date.slice(0, 10)
    : date.toISOString().slice(0, 10);
}

export function shiftDateOnly(value, days) {
  const date = new Date(`${dateOnly(value)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateOnly(date);
}

function spendingTransactions(transactions, period, currency) {
  return postedLedgerTransactions(transactions, period, currency).filter(
    (transaction) =>
      transaction.amount_minor < 0 ||
      (transaction.amount_minor > 0 && !isIncomeTransaction(transaction)),
  );
}

function postedLedgerTransactions(transactions, period, currency) {
  return transactions.filter(
    (transaction) =>
      transaction.currency_code === currency &&
      !transaction.pending &&
      !transaction.excluded_from_spending &&
      transaction.posted_on >= period.start_on &&
      transaction.posted_on < period.end_on,
  );
}

function cashFlowTotals(transactions, currency) {
  return transactions
    .filter(
      (transaction) =>
        transaction.currency_code === currency &&
        !transaction.pending &&
        !transaction.excluded_from_spending,
    )
    .reduce(
      (totals, transaction) => {
        if (
          transaction.amount_minor > 0 &&
          isIncomeTransaction(transaction)
        ) {
          totals.income += transaction.amount_minor;
        } else if (transaction.amount_minor > 0) {
          totals.spending -= transaction.amount_minor;
        } else {
          totals.spending += -transaction.amount_minor;
        }
        return totals;
      },
      { income: 0, spending: 0 },
    );
}

function sumSpend(transactions) {
  return Math.max(0, transactions.reduce(
    (sum, transaction) => sum - transaction.amount_minor,
    0,
  ));
}

function isIncomeTransaction(transaction) {
  return /\b(income|payroll|deposit|interest_earned)\b/i.test(
    `${transaction.category_primary ?? ""} ${transaction.category_detailed ?? ""}`,
  );
}

function bucketStart(dateString, interval) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  if (interval === "month") {
    date.setUTCDate(1);
  } else if (interval === "week") {
    const day = date.getUTCDay();
    date.setUTCDate(date.getUTCDate() - ((day + 6) % 7));
  }
  return dateOnly(date);
}

function isExternalInvestmentFlow(transaction) {
  const value = `${transaction.transaction_type} ${transaction.subtype}`
    .toLowerCase();
  return /\b(deposit|withdrawal|transfer)\b/.test(value);
}

function isWithdrawal(transaction) {
  return /\b(withdrawal|out)\b/.test(
    `${transaction.transaction_type} ${transaction.subtype}`.toLowerCase(),
  );
}

function startOfUtcDay(date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function shiftUtcDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function differenceInDays(a, b) {
  return Math.abs(
    Math.floor(
      (new Date(`${a}T00:00:00.000Z`) -
        new Date(`${b}T00:00:00.000Z`)) /
        DAY_MS,
    ),
  );
}

function hasContinuousSnapshotCoverage(series) {
  if (series.length < 7) return false;
  for (let index = 1; index < series.length; index += 1) {
    if (
      differenceInDays(series[index - 1].timestamp, series[index].timestamp) >
      2
    ) {
      return false;
    }
  }
  return true;
}
