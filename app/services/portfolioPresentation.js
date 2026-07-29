import {
  cashCurrencyCode,
  isCashSecurity,
} from "./investmentSecurities.js";

function rowIsCash(holding) {
  return (
    holding.isCash === true ||
    isCashSecurity({
      security_type:
        holding.securityType ?? holding.security_type,
      ticker_symbol:
        holding.selectionKey ??
        holding.ticker_symbol ??
        holding.symbol,
    })
  );
}

function rowCurrency(holding) {
  return (
    cashCurrencyCode({
      ticker_symbol:
        holding.selectionKey ??
        holding.ticker_symbol ??
        holding.symbol,
    }) ??
    holding.value?.currency ??
    "USD"
  );
}

function rowValueMinor(holding) {
  return Number.isSafeInteger(holding.value?.amount_minor)
    ? holding.value.amount_minor
    : 0;
}

function cashBadge(currency) {
  return currency === "USD" ? "$" : currency;
}

function cashPositionName(positions, currency) {
  if (positions.length === 1) {
    return `${currency} in ${positions[0].account}`;
  }
  return `${currency} across ${positions.length} accounts`;
}

function consolidateCashCurrency(rows, currency) {
  const accounts = new Map();
  const legacySelectionKeys = new Set();
  let valueMinor = 0;
  let allocationBasisPoints = 0;

  for (const [index, holding] of rows.entries()) {
    valueMinor += rowValueMinor(holding);
    allocationBasisPoints += Math.round(
      Number(holding.allocation ?? 0) * 100,
    );
    for (const key of [
      holding.selectionKey,
      holding.ticker_symbol,
    ]) {
      if (key) legacySelectionKeys.add(key);
    }

    const account =
      holding.account || "Unknown investment account";
    const accountKey =
      holding.accountId ?? holding.account_id ?? account;
    const existing = accounts.get(accountKey) ?? {
      accountId:
        holding.accountId ?? holding.account_id ?? null,
      account,
      value: {
        amount_minor: 0,
        currency,
      },
      firstIndex: index,
    };
    existing.value.amount_minor += rowValueMinor(holding);
    accounts.set(accountKey, existing);
  }

  const positions = [...accounts.values()]
    .sort(
      (left, right) =>
        right.value.amount_minor - left.value.amount_minor ||
        left.firstIndex - right.firstIndex,
    )
    .map(({ firstIndex: _firstIndex, ...position }) => position);
  const selectionKey = `cash:${currency}`;

  return {
    id: selectionKey,
    securityId: null,
    accountId: null,
    account: null,
    selectionKey,
    symbol: "Cash",
    badge: cashBadge(currency),
    name: cashPositionName(positions, currency),
    isCash: true,
    securityType: "cash",
    balanceGroup: null,
    value: {
      amount_minor: valueMinor,
      currency,
    },
    costBasis: null,
    price: null,
    priceAsOf: null,
    allocation: allocationBasisPoints / 100,
    shares: null,
    positions,
    legacySelectionKeys: [...legacySelectionKeys],
  };
}

export function consolidatePortfolioCashRows(holdings = []) {
  const cashByCurrency = new Map();
  const displayed = [];

  for (const [index, holding] of holdings.entries()) {
    if (!rowIsCash(holding)) {
      displayed.push({ holding, index });
      continue;
    }
    const currency = rowCurrency(holding);
    const rows = cashByCurrency.get(currency) ?? [];
    rows.push(holding);
    cashByCurrency.set(currency, rows);
  }

  for (const [currency, rows] of cashByCurrency) {
    const firstIndex = holdings.indexOf(rows[0]);
    displayed.push({
      holding: consolidateCashCurrency(rows, currency),
      index: firstIndex,
    });
  }

  return displayed
    .sort(
      (left, right) =>
        rowValueMinor(right.holding) -
          rowValueMinor(left.holding) ||
        left.index - right.index,
    )
    .map(({ holding }) => holding);
}

export function selectPortfolioHolding(
  holdings = [],
  selectionKey = null,
) {
  if (!selectionKey) return null;
  return (
    holdings.find(
      (holding) =>
        holding.selectionKey === selectionKey ||
        holding.legacySelectionKeys?.includes(selectionKey),
    ) ?? null
  );
}
