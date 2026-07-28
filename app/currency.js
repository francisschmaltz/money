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
  {
    locale = "en-US",
    signDisplay = "auto",
    fractionDigits = null,
  } = {},
) {
  if (!value || !Number.isSafeInteger(value.amount_minor)) return null;
  const currency = value.currency || "USD";
  if (
    fractionDigits != null &&
    (!Number.isInteger(fractionDigits) ||
      fractionDigits < 0 ||
      fractionDigits > 20)
  ) {
    throw new TypeError(
      "fractionDigits must be an integer between 0 and 20",
    );
  }
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    signDisplay,
    ...(fractionDigits == null
      ? {}
      : {
          minimumFractionDigits: fractionDigits,
          maximumFractionDigits: fractionDigits,
        }),
  }).format(majorUnits(value.amount_minor, currency));
}
