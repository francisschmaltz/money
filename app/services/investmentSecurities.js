const CURRENCY_CASH_TICKER = /^CUR:([A-Z]{3})$/i;

export function cashCurrencyCode(security = {}) {
  const ticker = security.ticker_symbol ?? security.symbol;
  const match = CURRENCY_CASH_TICKER.exec(String(ticker ?? "").trim());
  return match?.[1].toUpperCase() ?? null;
}

export function isCashSecurity(security = {}) {
  const type = security.security_type ?? security.type;
  return (
    String(type ?? "").toLowerCase() === "cash" ||
    cashCurrencyCode(security) != null
  );
}

export function canonicalSecurityType(security = {}) {
  if (isCashSecurity(security)) return "cash";
  return security.security_type ?? security.type ?? null;
}
