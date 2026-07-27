export function currencyFractionDigits(currency) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

export function majorUnits(amountMinor, currency) {
  return amountMinor / 10 ** currencyFractionDigits(currency);
}

export function formatMinorMoney(
  value,
  { locale = "en-US", signDisplay = "auto" } = {},
) {
  if (!value || !Number.isSafeInteger(value.amount_minor)) return null;
  const currency = value.currency || "USD";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    signDisplay,
  }).format(majorUnits(value.amount_minor, currency));
}
