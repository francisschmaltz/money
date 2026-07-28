import { createHash } from "node:crypto";
import { normalizeMerchant, normalizeTransactionName } from "./plaidNormalizer.js";
import { stableId } from "../services/ids.js";

export const APPLE_CARD_CSV_HEADERS = Object.freeze([
  "Transaction Date",
  "Clearing Date",
  "Description",
  "Merchant",
  "Category",
  "Type",
  "Amount (USD)",
  "Purchased By",
]);
export const APPLE_CARD_MAX_BYTES = 2 * 1024 * 1024;
export const APPLE_CARD_MAX_ROWS = 20_000;

const CATEGORY_MAP = new Map([
  ["Grocery", "Groceries"],
  ["Restaurants", "Dining"],
  ["Gas/Tolls", "Transportation"],
]);

export class AppleCardCsvError extends Error {
  constructor(message, { statusCode = 400, code = "invalid_csv" } = {}) {
    super(message);
    this.name = "AppleCardCsvError";
    this.statusCode = statusCode;
    this.code = code;
    this.expose = true;
  }
}

function parseCsvRows(source) {
  // Apple Card exports use a fixed RFC 4180-style schema. Keep this parser
  // intentionally narrow: commas, escaped quotes, embedded newlines, and BOM.
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let closedQuote = false;
  let rowStarted = false;

  const finishField = () => {
    row.push(field);
    field = "";
    closedQuote = false;
  };
  const finishRow = () => {
    if (!rowStarted && row.length === 0 && field.length === 0) return;
    finishField();
    rows.push(row);
    if (rows.length > APPLE_CARD_MAX_ROWS + 1) {
      throw new AppleCardCsvError(
        "The CSV exceeds the 20,000-row limit.",
        { statusCode: 413, code: "too_many_rows" },
      );
    }
    row = [];
    rowStarted = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character !== '"') {
        field += character;
        continue;
      }
      if (text[index + 1] === '"') {
        field += '"';
        index += 1;
        continue;
      }
      inQuotes = false;
      closedQuote = true;
      continue;
    }

    if (closedQuote) {
      if (character === ",") {
        finishField();
        rowStarted = true;
        continue;
      }
      if (character === "\n" || character === "\r") {
        finishRow();
        if (character === "\r" && text[index + 1] === "\n") index += 1;
        continue;
      }
      throw new Error("unexpected content after a quoted CSV field");
    }

    if (character === '"') {
      if (field.length > 0) {
        throw new Error("unexpected quote in an unquoted CSV field");
      }
      inQuotes = true;
      rowStarted = true;
      continue;
    }
    if (character === ",") {
      finishField();
      rowStarted = true;
      continue;
    }
    if (character === "\n" || character === "\r") {
      finishRow();
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      continue;
    }
    field += character;
    rowStarted = true;
  }

  if (inQuotes) throw new Error("unterminated quoted CSV field");
  if (closedQuote || rowStarted || row.length > 0 || field.length > 0) {
    finishRow();
  }
  return rows;
}

function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAppleDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(
    normalizedText(value),
  );
  if (!match) return null;
  const [, month, day, year] = match;
  const iso = `${year}-${month}-${day}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === iso
    ? iso
    : null;
}

export function exactDecimalToMinor(value, { invert = false } = {}) {
  const normalized = normalizedText(value);
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) {
    throw new TypeError("amount must be a decimal with at most two places");
  }
  const [, sign, whole, fraction = ""] = match;
  let minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (sign === "-") minor = -minor;
  if (invert) minor = -minor;
  if (
    minor > BigInt(Number.MAX_SAFE_INTEGER) ||
    minor < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new RangeError("amount exceeds the supported range");
  }
  return Number(minor);
}

function rowError(rowNumber, code, message) {
  return { row: rowNumber, code, message };
}

function normalizedIdentity(row, originalAmountMinor) {
  return [
    row.authorized_on,
    row.posted_on,
    normalizedText(row.name).toLocaleLowerCase("en-US"),
    normalizedText(row.merchant_name).toLocaleLowerCase("en-US"),
    normalizedText(row.source_transaction_type).toLocaleLowerCase("en-US"),
    String(originalAmountMinor),
    normalizedText(row.cardholder_name).toLocaleLowerCase("en-US"),
  ].join("\0");
}

export function parseAppleCardCsv(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("buffer is required");
  }
  if (buffer.length > APPLE_CARD_MAX_BYTES) {
    throw new AppleCardCsvError("The CSV exceeds the 2 MiB limit.", {
      statusCode: 413,
      code: "csv_too_large",
    });
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new AppleCardCsvError("The CSV must be valid UTF-8.", {
      code: "invalid_utf8",
    });
  }

  let rows;
  try {
    rows = parseCsvRows(text);
  } catch (error) {
    if (error instanceof AppleCardCsvError) throw error;
    throw new AppleCardCsvError("The file is not a valid Apple Card CSV.");
  }

  if (!rows.length) {
    throw new AppleCardCsvError("The CSV is empty.");
  }
  const headers = rows[0].map((value) => String(value));
  if (
    headers.length !== APPLE_CARD_CSV_HEADERS.length ||
    headers.some((header, index) => header !== APPLE_CARD_CSV_HEADERS[index])
  ) {
    throw new AppleCardCsvError(
      "The CSV must use the exact eight-column Apple Card USD schema.",
      { code: "invalid_headers" },
    );
  }

  const dataRows = rows.slice(1);
  if (dataRows.length > APPLE_CARD_MAX_ROWS) {
    throw new AppleCardCsvError("The CSV exceeds the 20,000-row limit.", {
      statusCode: 413,
      code: "too_many_rows",
    });
  }

  const transactions = [];
  const rejected = [];
  const warnings = [];
  const occurrences = new Map();
  let chargeTotalMinor = 0;
  let creditTotalMinor = 0;

  dataRows.forEach((values, index) => {
    const rowNumber = index + 2;
    if (values.length !== APPLE_CARD_CSV_HEADERS.length) {
      rejected.push(
        rowError(
          rowNumber,
          "invalid_column_count",
          "Each row must contain exactly eight columns.",
        ),
      );
      return;
    }
    const [
      rawTransactionDate,
      rawClearingDate,
      rawDescription,
      rawMerchant,
      rawCategory,
      rawType,
      rawAmount,
      rawCardholder,
    ] = values;
    const authorizedOn = parseAppleDate(rawTransactionDate);
    const postedOn = parseAppleDate(rawClearingDate);
    const name = normalizedText(rawDescription);
    const merchantName = normalizedText(rawMerchant) || null;
    const categoryDetailed = normalizedText(rawCategory);
    const sourceTransactionType = normalizedText(rawType);
    const cardholderName = normalizedText(rawCardholder) || null;

    if (!authorizedOn || !postedOn) {
      rejected.push(
        rowError(
          rowNumber,
          "invalid_date",
          "Transaction and clearing dates must use MM/DD/YYYY.",
        ),
      );
      return;
    }
    if (!name || !categoryDetailed || !sourceTransactionType) {
      rejected.push(
        rowError(
          rowNumber,
          "missing_value",
          "Description, category, and type are required.",
        ),
      );
      return;
    }

    let originalAmountMinor;
    try {
      originalAmountMinor = exactDecimalToMinor(rawAmount);
    } catch {
      rejected.push(
        rowError(
          rowNumber,
          "invalid_amount",
          "Amount must be exact USD with at most two decimal places.",
        ),
      );
      return;
    }

    const categoryPrimary =
      CATEGORY_MAP.get(categoryDetailed) ?? categoryDetailed;
    const transaction = {
      authorized_on: authorizedOn,
      posted_on: postedOn,
      name,
      merchant_name: merchantName,
      normalized_merchant: normalizeMerchant(merchantName ?? name),
      normalized_name: normalizeTransactionName(name),
      category_primary: categoryPrimary,
      category_detailed: categoryDetailed,
      amount_minor: -originalAmountMinor,
      currency_code: "USD",
      cardholder_name: cardholderName,
      source_transaction_type: sourceTransactionType,
      pending: false,
      excluded_from_spending: sourceTransactionType !== "Purchase",
      payment_channel: "other",
    };
    const identity = normalizedIdentity(transaction, originalAmountMinor);
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    const providerTransactionId = stableId(
      "apple-card",
      `${identity}\0${occurrence}`,
    );
    transaction.id = stableId("transaction", providerTransactionId);
    transaction.provider_transaction_id = providerTransactionId;
    transaction.provider_pending_transaction_id = null;
    transactions.push(transaction);

    if (originalAmountMinor >= 0) {
      chargeTotalMinor += originalAmountMinor;
    } else {
      creditTotalMinor += -originalAmountMinor;
    }
    if (sourceTransactionType !== "Purchase") {
      warnings.push({
        row: rowNumber,
        code: "non_purchase_type",
        message: `${sourceTransactionType} is preserved but excluded from spending.`,
      });
    }
  });

  const postedDates = transactions.map((row) => row.posted_on).sort();
  return {
    digest: createHash("sha256").update(buffer).digest("hex"),
    total_row_count: dataRows.length,
    accepted_row_count: transactions.length,
    rejected_row_count: rejected.length,
    warning_count: warnings.length,
    posted_start_on: postedDates[0] ?? null,
    posted_end_on: postedDates.at(-1) ?? null,
    charge_total_minor: chargeTotalMinor,
    credit_total_minor: creditTotalMinor,
    transactions,
    rejected,
    warnings,
  };
}
