import { currencyFractionDigits } from "../currency.js";

const ISO_CURRENCY = /^[A-Z]{3}$/;

export function amountToMinorUnits(amount, currency = "USD") {
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    typeof currency !== "string" ||
    !ISO_CURRENCY.test(currency)
  ) {
    throw new TypeError("A finite amount and ISO-4217 currency are required.");
  }
  const factor = 10 ** currencyFractionDigits(currency);
  const scaled = amount * factor;
  const rounded = Math.round(scaled);
  if (
    !Number.isSafeInteger(rounded) ||
    Math.abs(scaled - rounded) >
      Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4
  ) {
    throw new TypeError(
      `amount supports at most ${currencyFractionDigits(currency)} decimal places for ${currency}.`,
    );
  }
  return rounded;
}

export function hasCurrencyPrecision(amount, currency = "USD") {
  try {
    amountToMinorUnits(amount, currency);
    return true;
  } catch {
    return false;
  }
}

export function percentageToBasisPoints(percentage) {
  if (typeof percentage !== "number" || !Number.isFinite(percentage)) {
    throw new TypeError("percentage must be a finite number.");
  }
  const scaled = percentage * 100;
  const rounded = Math.round(scaled);
  if (
    !Number.isSafeInteger(rounded) ||
    Math.abs(scaled - rounded) >
      Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4
  ) {
    throw new TypeError("percentage supports at most two decimal places.");
  }
  return rounded;
}

export function hasPercentagePrecision(percentage) {
  try {
    percentageToBasisPoints(percentage);
    return true;
  } catch {
    return false;
  }
}

export function financeCardValue(value, inheritedCurrency = "USD") {
  if (Array.isArray(value)) {
    return value.map((item) => financeCardValue(item, inheritedCurrency));
  }
  if (value instanceof Date) {
    return value;
  }
  if (!value || typeof value !== "object") return value;

  if (
    Object.keys(value).length === 2 &&
    Number.isSafeInteger(value.amount_minor) &&
    typeof value.currency === "string"
  ) {
    return {
      amount:
        value.amount_minor /
        10 ** currencyFractionDigits(value.currency),
      currency: value.currency,
    };
  }

  const currency =
    typeof value.currency_code === "string"
      ? value.currency_code
      : typeof value.currency === "string"
        ? value.currency
        : inheritedCurrency;
  const normalized = {};
  for (const [key, child] of Object.entries(value)) {
    if (key.endsWith("_minor") && Number.isSafeInteger(child)) {
      normalized[key.replace(/_minor$/, "")] = {
        amount: child / 10 ** currencyFractionDigits(currency),
        currency,
      };
    } else if (key.endsWith("_minor") && child === null) {
      normalized[key.replace(/_minor$/, "")] = null;
    } else if (
      key.endsWith("_basis_points") &&
      (Number.isSafeInteger(child) || child === null)
    ) {
      const percentageKey =
        key === "percent_basis_points"
          ? "percentage"
          : key.replace(/_basis_points$/, "_percentage");
      normalized[percentageKey] =
        child === null ? null : child / 100;
    } else {
      normalized[key] = financeCardValue(child, currency);
    }
  }
  return normalized;
}
