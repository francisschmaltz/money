import { stableId } from "../services/ids.js";
import { currencyFractionDigits } from "../currency.js";
import {
  canonicalTransactionCategory,
} from "../services/transactionCategories.js";
import { canonicalSecurityType } from "../services/investmentSecurities.js";

export function normalizePlaidCurrencyCode(
  source = {},
  fallback = "USD",
) {
  for (const candidate of [
    source?.iso_currency_code,
    source?.unofficial_currency_code,
    fallback,
    "USD",
  ]) {
    const normalized = String(candidate ?? "").trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(normalized)) return normalized;
  }
  return "USD";
}

export function amountToMinor(amount, currency = "USD") {
  if (amount == null || !Number.isFinite(Number(amount))) return null;
  const exponent = currencyFractionDigits(currency);
  const value = Math.round(Number(amount) * 10 ** exponent);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("Money amount exceeds safe integer range");
  }
  return value;
}

export function normalizeMerchant(value) {
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

export function normalizeTransactionName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\b\d{3,}\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizedLocationText(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizedCoordinate(value, minimum, maximum) {
  if (
    typeof value !== "number" &&
    typeof value !== "string"
  ) {
    return null;
  }
  if (typeof value === "string" && !value.trim()) return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) &&
    normalized >= minimum &&
    normalized <= maximum
    ? normalized
    : null;
}

function normalizePlaidLocation(location) {
  if (!location || typeof location !== "object") return null;
  const latitude = normalizedCoordinate(location.lat, -90, 90);
  const longitude = normalizedCoordinate(location.lon, -180, 180);
  const hasValidCoordinates = latitude != null && longitude != null;
  const normalized = {
    address: normalizedLocationText(location.address),
    city: normalizedLocationText(location.city),
    region: normalizedLocationText(location.region),
    postal_code: normalizedLocationText(location.postal_code),
    country: normalizedLocationText(location.country),
    lat: hasValidCoordinates ? latitude : null,
    lon: hasValidCoordinates ? longitude : null,
    store_number: normalizedLocationText(location.store_number),
  };
  return Object.values(normalized).some((value) => value != null)
    ? normalized
    : null;
}

const PLAID_OBLIGATION_CATEGORIES = new Set([
  "LOAN_PAYMENTS_CAR_PAYMENT",
  "LOAN_PAYMENTS_MORTGAGE_PAYMENT",
  "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT",
  "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT",
]);

function plaidCategoryKey(value) {
  return String(value ?? "")
    .trim()
    .toLocaleUpperCase("en-US")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const EXTRA_PRINCIPAL_PAYMENT_PATTERN =
  /\b(?:(?:extra|additional)\s+principal|principal[\s-]+only)(?:\s+(?:payment|paydown))?\b/i;

function plaidCashFlowRole(primary, detailed, ...descriptions) {
  const primaryKey = plaidCategoryKey(primary);
  const detailedKey = plaidCategoryKey(detailed);
  if (["TRANSFER_IN", "TRANSFER_OUT"].includes(primaryKey)) {
    return "transfer";
  }
  if (
    primaryKey === "LOAN_PAYMENTS" &&
    detailedKey === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"
  ) {
    return "transfer";
  }
  if (
    primaryKey === "LOAN_PAYMENTS" &&
    descriptions.some((value) =>
      EXTRA_PRINCIPAL_PAYMENT_PATTERN.test(String(value ?? "")),
    )
  ) {
    return "transfer";
  }
  if (
    (primaryKey === "LOAN_PAYMENTS" &&
      PLAID_OBLIGATION_CATEGORIES.has(detailedKey)) ||
    (primaryKey === "RENT_AND_UTILITIES" &&
      detailedKey === "RENT_AND_UTILITIES_RENT")
  ) {
    return "obligation";
  }
  return "spending";
}

export function normalizePlaidAccount(account, institutionName = null) {
  const currency = normalizePlaidCurrencyCode(account.balances);
  const isLiability = ["credit", "loan"].includes(account.type);
  return {
    id: stableId("account", account.account_id),
    provider_account_id: account.account_id,
    institution_name: institutionName,
    name: account.name ?? "Account",
    official_name: account.official_name ?? null,
    mask: account.mask ?? null,
    type: account.type ?? "other",
    subtype: account.subtype ?? null,
    currency_code: currency,
    current_balance_minor: amountToMinor(
      account.balances?.current,
      currency,
    ),
    available_balance_minor: amountToMinor(
      account.balances?.available,
      currency,
    ),
    credit_limit_minor: amountToMinor(account.balances?.limit, currency),
    is_liability: isLiability,
  };
}

export function normalizePlaidTransaction(transaction) {
  const currency = normalizePlaidCurrencyCode(transaction);
  const primary =
    transaction.personal_finance_category?.primary ??
    transaction.category?.[0] ??
    null;
  const detailed =
    transaction.personal_finance_category?.detailed ??
    transaction.category?.[1] ??
    null;
  const merchant = transaction.merchant_name ?? transaction.name ?? "";
  const name =
    transaction.name ?? transaction.merchant_name ?? "Transaction";
  const cashFlowRole = plaidCashFlowRole(
    primary,
    detailed,
    transaction.name,
    transaction.merchant_name,
  );
  return {
    id: stableId("transaction", transaction.transaction_id),
    provider_account_id: transaction.account_id,
    provider_transaction_id: transaction.transaction_id,
    provider_pending_transaction_id:
      transaction.pending_transaction_id ?? null,
    merchant_name: transaction.merchant_name ?? null,
    normalized_merchant: normalizeMerchant(merchant),
    name,
    normalized_name: normalizeTransactionName(name),
    category_primary: canonicalTransactionCategory(primary, detailed),
    category_detailed: detailed,
    // Plaid uses positive for money leaving the account. Our ledger is the
    // ordinary human convention: outflows negative, inflows positive.
    amount_minor: -amountToMinor(transaction.amount, currency),
    currency_code: currency,
    authorized_at: transaction.authorized_datetime ?? null,
    authorized_on:
      transaction.authorized_date ??
      transaction.authorized_datetime?.slice(0, 10) ??
      null,
    posted_at: transaction.datetime ?? null,
    posted_on: transaction.date,
    pending: Boolean(transaction.pending),
    cash_flow_role: cashFlowRole,
    excluded_from_spending: cashFlowRole !== "spending",
    payment_channel: transaction.payment_channel ?? null,
    provider_location: normalizePlaidLocation(transaction.location),
  };
}

export function normalizePlaidSecurity(security, fallbackCurrency = "USD") {
  const currency = normalizePlaidCurrencyCode(security, fallbackCurrency);
  return {
    id: stableId("security", security.security_id),
    provider_security_id: security.security_id,
    name: security.name ?? security.ticker_symbol ?? "Security",
    ticker_symbol: security.ticker_symbol ?? null,
    security_type: canonicalSecurityType(security),
    close_price_minor: amountToMinor(security.close_price, currency),
    close_price_as_of: security.close_price_as_of ?? null,
    currency_code: currency,
  };
}

export function normalizePlaidHolding(holding, fallbackCurrency = "USD") {
  const currency = normalizePlaidCurrencyCode(holding, fallbackCurrency);
  return {
    id: stableId(
      "holding",
      `${holding.account_id}:${holding.security_id}`,
    ),
    provider_account_id: holding.account_id,
    provider_security_id: holding.security_id,
    quantity: Number(holding.quantity ?? 0),
    vested_quantity:
      holding.vested_quantity == null
        ? null
        : Number(holding.vested_quantity),
    institution_value_minor: amountToMinor(
      holding.institution_value,
      currency,
    ),
    vested_value_minor: amountToMinor(
      holding.vested_value,
      currency,
    ),
    institution_price_minor: amountToMinor(
      holding.institution_price,
      currency,
    ),
    cost_basis_minor: amountToMinor(holding.cost_basis, currency),
    currency_code: currency,
  };
}

export function normalizePlaidInvestmentTransaction(
  transaction,
  fallbackCurrency = "USD",
) {
  const currency = normalizePlaidCurrencyCode(
    transaction,
    fallbackCurrency,
  );
  return {
    id: stableId(
      "investment_transaction",
      transaction.investment_transaction_id,
    ),
    provider_account_id: transaction.account_id,
    provider_security_id: transaction.security_id ?? null,
    provider_investment_transaction_id:
      transaction.investment_transaction_id,
    transaction_type: transaction.type ?? "other",
    subtype: transaction.subtype ?? null,
    amount_minor: amountToMinor(transaction.amount, currency) ?? 0,
    fees_minor: amountToMinor(transaction.fees, currency) ?? 0,
    quantity:
      transaction.quantity == null ? null : Number(transaction.quantity),
    price_minor: amountToMinor(transaction.price, currency),
    currency_code: currency,
    posted_on: transaction.date,
    name: transaction.name ?? null,
  };
}

export function normalizePlaidLiabilities(response) {
  const entries = [];
  const groups = response.liabilities ?? {};

  for (const credit of groups.credit ?? []) {
    const currency = "USD";
    const aprs = (credit.aprs ?? [])
      .map((apr) => Number(apr.apr_percentage))
      .filter(Number.isFinite);
    entries.push({
      id: stableId("liability", credit.account_id),
      provider_account_id: credit.account_id,
      liability_type: "credit",
      minimum_payment_minor: amountToMinor(
        credit.minimum_payment_amount,
        currency,
      ),
      last_payment_minor: amountToMinor(
        credit.last_payment_amount,
        currency,
      ),
      next_payment_due_on: credit.next_payment_due_date ?? null,
      apr_basis_points: aprs.length
        ? Math.round(Math.max(...aprs) * 100)
        : null,
      principal_minor: null,
      currency_code: currency,
      details: {
        is_overdue: Boolean(credit.is_overdue),
        last_statement_balance_minor: amountToMinor(
          credit.last_statement_balance,
          currency,
        ),
      },
    });
  }

  for (const student of groups.student ?? []) {
    const currency = "USD";
    entries.push({
      id: stableId("liability", student.account_id),
      provider_account_id: student.account_id,
      liability_type: "student",
      minimum_payment_minor: amountToMinor(
        student.minimum_payment_amount,
        currency,
      ),
      last_payment_minor: amountToMinor(
        student.last_payment_amount,
        currency,
      ),
      next_payment_due_on: student.next_payment_due_date ?? null,
      apr_basis_points:
        student.interest_rate_percentage == null
          ? null
          : Math.round(Number(student.interest_rate_percentage) * 100),
      principal_minor: amountToMinor(student.origination_principal_amount, currency),
      currency_code: currency,
      details: {
        repayment_plan: student.repayment_plan?.type ?? null,
        guarantor: student.guarantor ?? null,
      },
    });
  }

  for (const mortgage of groups.mortgage ?? []) {
    const currency = "USD";
    entries.push({
      id: stableId("liability", mortgage.account_id),
      provider_account_id: mortgage.account_id,
      liability_type: "mortgage",
      minimum_payment_minor: amountToMinor(
        mortgage.next_monthly_payment,
        currency,
      ),
      last_payment_minor: amountToMinor(
        mortgage.last_payment_amount,
        currency,
      ),
      next_payment_due_on: mortgage.next_payment_due_date ?? null,
      apr_basis_points:
        mortgage.interest_rate?.percentage == null
          ? null
          : Math.round(Number(mortgage.interest_rate.percentage) * 100),
      principal_minor: amountToMinor(
        mortgage.current_late_fee == null
          ? mortgage.origination_principal_amount
          : mortgage.origination_principal_amount,
        currency,
      ),
      currency_code: currency,
      details: {
        loan_type: mortgage.loan_type_description ?? null,
        escrow_balance_minor: amountToMinor(
          mortgage.escrow_balance,
          currency,
        ),
      },
    });
  }

  return entries;
}
