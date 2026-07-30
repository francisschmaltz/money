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

function rowAllocationBasisPoints(holding) {
  return Math.round(Number(holding.allocation ?? 0) * 100);
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
    allocationBasisPoints += rowAllocationBasisPoints(holding);
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

function normalizedSecurityKey(holding, index) {
  const symbol = holding.selectionKey ?? holding.symbol;
  if (typeof symbol === "string" && symbol.trim()) {
    return `symbol:${symbol.trim().toUpperCase()}`;
  }
  if (holding.securityId) {
    return `security:${holding.securityId}`;
  }
  return `holding:${holding.id ?? index}`;
}

function decimalParts(value) {
  const text = String(value ?? "").trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  return {
    negative: match[1] === "-",
    whole: match[2],
    fraction: match[3] ?? "",
  };
}

function sumShareLabels(rows) {
  const parts = rows.map((row) => decimalParts(row.shares));
  if (parts.some((part) => !part)) return null;
  const scale = Math.max(
    0,
    ...parts.map((part) => part.fraction.length),
  );
  const total = parts.reduce((sum, part) => {
    const digits = BigInt(
      `${part.whole}${part.fraction.padEnd(scale, "0")}`,
    );
    return sum + (part.negative ? -digits : digits);
  }, 0n);
  const negative = total < 0n;
  const absolute = (negative ? -total : total)
    .toString()
    .padStart(scale + 1, "0");
  const whole =
    scale === 0 ? absolute : absolute.slice(0, -scale);
  const fraction =
    scale === 0
      ? ""
      : absolute.slice(-scale).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${
    fraction ? `.${fraction}` : ""
  }`;
}

function sumMoney(rows, field) {
  if (rows.some((row) => !row[field])) return null;
  const currency = rows[0][field].currency;
  if (
    rows.some(
      (row) =>
        row[field].currency !== currency ||
        !Number.isSafeInteger(row[field].amount_minor),
    )
  ) {
    return null;
  }
  return {
    amount_minor: rows.reduce(
      (sum, row) => sum + row[field].amount_minor,
      0,
    ),
    currency,
  };
}

function latestPricedRow(rows) {
  return rows
    .filter((row) => row.price)
    .sort((left, right) =>
      String(right.priceAsOf ?? "").localeCompare(
        String(left.priceAsOf ?? ""),
      ),
    )[0];
}

function securityPositions(rows, currency) {
  const accounts = new Map();

  for (const [index, holding] of rows.entries()) {
    const account =
      holding.account || "Unknown investment account";
    const accountKey =
      holding.accountId ?? holding.account ?? `unknown:${index}`;
    const existing = accounts.get(accountKey) ?? {
      accountId: holding.accountId ?? null,
      account,
      rows: [],
      value: {
        amount_minor: 0,
        currency,
      },
      firstIndex: index,
    };
    existing.rows.push(holding);
    existing.value.amount_minor += rowValueMinor(holding);
    accounts.set(accountKey, existing);
  }

  return [...accounts.values()]
    .sort(
      (left, right) =>
        right.value.amount_minor - left.value.amount_minor ||
        left.firstIndex - right.firstIndex,
    )
    .map(({ rows: accountRows, firstIndex: _firstIndex, ...position }) => ({
      ...position,
      shares: sumShareLabels(accountRows),
    }));
}

function singleValue(rows, field) {
  const first = rows[0][field] ?? null;
  return rows.every((row) => (row[field] ?? null) === first)
    ? first
    : null;
}

function consolidateSecurity(rows) {
  const first = rows[0];
  const currency = first.value?.currency ?? "USD";
  const positions = securityPositions(rows, currency);
  const latest = latestPricedRow(rows);
  const legacySelectionKeys = [
    ...new Set(
      rows
        .flatMap((row) => [
          row.selectionKey,
          ...(row.legacySelectionKeys ?? []),
        ])
        .filter(Boolean),
    ),
  ];

  return {
    ...first,
    id: null,
    securityId: singleValue(rows, "securityId"),
    accountId: positions.length === 1 ? positions[0].accountId : null,
    account: positions.length === 1 ? positions[0].account : null,
    balanceGroup: singleValue(rows, "balanceGroup"),
    value: {
      amount_minor: rows.reduce(
        (sum, row) => sum + rowValueMinor(row),
        0,
      ),
      currency,
    },
    costBasis: sumMoney(rows, "costBasis"),
    price: latest?.price ?? null,
    priceAsOf: latest?.priceAsOf ?? null,
    allocation:
      rows.reduce(
        (sum, row) => sum + rowAllocationBasisPoints(row),
        0,
      ) / 100,
    shares: sumShareLabels(rows),
    positions,
    isAggregated: true,
    legacySelectionKeys,
  };
}

export function consolidatePortfolioHoldingRows(holdings = []) {
  const cashByCurrency = new Map();
  const securities = new Map();

  for (const [index, holding] of holdings.entries()) {
    if (rowIsCash(holding)) {
      const currency = rowCurrency(holding);
      const group = cashByCurrency.get(currency) ?? {
        rows: [],
        index,
      };
      group.rows.push(holding);
      cashByCurrency.set(currency, group);
      continue;
    }

    const key = normalizedSecurityKey(holding, index);
    const group = securities.get(key) ?? { rows: [], index };
    group.rows.push(holding);
    securities.set(key, group);
  }

  const displayed = [];
  for (const [currency, group] of cashByCurrency) {
    displayed.push({
      holding: consolidateCashCurrency(group.rows, currency),
      index: group.index,
    });
  }
  for (const group of securities.values()) {
    displayed.push({
      holding:
        group.rows.length === 1
          ? group.rows[0]
          : consolidateSecurity(group.rows),
      index: group.index,
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
