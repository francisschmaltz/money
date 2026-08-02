import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLE_CARD_CSV_HEADERS,
  APPLE_CARD_MAX_BYTES,
  AppleCardCsvError,
  exactDecimalToMinor,
  parseAppleCardCsv,
} from "../app/providers/appleCardCsv.js";

function quote(value) {
  const text = String(value);
  return /[",\r\n]/.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

function csv(rows, newline = "\n", headers = APPLE_CARD_CSV_HEADERS) {
  return Buffer.from(
    [headers, ...rows]
      .map((row) => row.map(quote).join(","))
      .join(newline),
    "utf8",
  );
}

function row(overrides = {}) {
  return [
    overrides.transactionDate ?? "07/01/2026",
    overrides.clearingDate ?? "07/03/2026",
    overrides.description ?? "Synthetic market purchase",
    overrides.merchant ?? "Example Market",
    overrides.category ?? "Grocery",
    overrides.type ?? "Purchase",
    overrides.amount ?? "10.10",
    overrides.cardholder ?? "Sample Cardholder",
  ];
}

test("Apple Card CSV parsing handles quoted commas, CRLF, signs, and date-only authorization", () => {
  const parsed = parseAppleCardCsv(
    csv(
      [
        row({
          description: "Synthetic purchase, location 2",
          merchant: "Example Market, West",
        }),
        row({
          transactionDate: "06/30/2026",
          clearingDate: "07/02/2026",
          category: "Restaurants",
          type: "Credit",
          amount: "-1.05",
          cardholder: "",
        }),
      ],
      "\r\n",
    ),
  );

  assert.equal(parsed.accepted_row_count, 2);
  assert.equal(parsed.rejected_row_count, 0);
  assert.equal(parsed.posted_start_on, "2026-07-02");
  assert.equal(parsed.posted_end_on, "2026-07-03");
  assert.equal(parsed.charge_total_minor, 1_010);
  assert.equal(parsed.credit_total_minor, 105);
  assert.equal(parsed.transactions[0].amount_minor, -1_010);
  assert.equal(parsed.transactions[0].category_primary, "Groceries");
  assert.equal(parsed.transactions[0].category_detailed, "Grocery");
  assert.equal(parsed.transactions[0].cash_flow_role, "spending");
  assert.equal(parsed.transactions[0].excluded_from_spending, false);
  assert.equal(
    parsed.transactions[0].name,
    "Synthetic purchase, location 2",
  );
  assert.equal(parsed.transactions[1].amount_minor, 105);
  assert.equal(parsed.transactions[1].authorized_on, "2026-06-30");
  assert.equal(parsed.transactions[1].posted_on, "2026-07-02");
  assert.equal(parsed.transactions[1].category_primary, "Dining");
  assert.equal(parsed.transactions[1].cardholder_name, null);
  assert.equal(parsed.transactions[1].source_transaction_type, "Credit");
  assert.equal(parsed.transactions[1].cash_flow_role, "spending");
  assert.equal(parsed.transactions[1].excluded_from_spending, false);
  assert.match(parsed.warnings[0].message, /nets against spending/);
});

test("Apple Card payments are transfers while merchant refunds net spending", () => {
  const parsed = parseAppleCardCsv(
    csv([
      row({
        description: "Payment - Thank You",
        merchant: "",
        category: "Payment",
        type: "Payment",
        amount: "-750.00",
      }),
      row({
        description: "Returned purchase",
        merchant: "Example Market",
        type: "Credit",
        amount: "-10.10",
      }),
    ]),
  );

  assert.equal(parsed.transactions[0].amount_minor, 75_000);
  assert.equal(parsed.transactions[0].cash_flow_role, "transfer");
  assert.equal(parsed.transactions[0].excluded_from_spending, true);
  assert.equal(parsed.transactions[1].amount_minor, 1_010);
  assert.equal(parsed.transactions[1].cash_flow_role, "spending");
  assert.equal(parsed.transactions[1].excluded_from_spending, false);
});

test("Apple Card CSV parsing handles BOMs, escaped quotes, embedded newlines, and blank rows", () => {
  const source = csv([
    row({
      description: 'Synthetic "weekly"\nmarket purchase',
      merchant: 'Example "Market"',
    }),
  ])
    .toString("utf8")
    .replace("\n", "\n\n");
  const parsed = parseAppleCardCsv(
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(source),
    ]),
  );

  assert.equal(parsed.total_row_count, 1);
  assert.equal(parsed.accepted_row_count, 1);
  assert.equal(
    parsed.transactions[0].name,
    'Synthetic "weekly" market purchase',
  );
  assert.equal(parsed.transactions[0].merchant_name, 'Example "Market"');
});

test("Apple Card CSV parsing rejects broken quote boundaries", () => {
  const headers = APPLE_CARD_CSV_HEADERS.join(",");
  for (const body of [
    `${headers}\n"unterminated`,
    `${headers}\n"closed"trailing`,
    `${headers}\nunquoted"quote`,
  ]) {
    assert.throws(
      () => parseAppleCardCsv(Buffer.from(body)),
      (error) =>
        error instanceof AppleCardCsvError &&
        error.code === "invalid_csv",
    );
  }
});

test("exact decimal conversion never routes cents through floating point", () => {
  assert.equal(exactDecimalToMinor("0.29"), 29);
  assert.equal(exactDecimalToMinor("-0.29"), -29);
  assert.equal(exactDecimalToMinor("90071992547409.91"), 9_007_199_254_740_991);
  assert.throws(
    () => exactDecimalToMinor("90071992547409.92"),
    /supported range/,
  );
  assert.throws(() => exactDecimalToMinor("1.001"), /at most two/);
});

test("category edits update a stable transaction ID while identical occurrences stay distinct", () => {
  const first = parseAppleCardCsv(csv([row(), row()]));
  const categoryEdit = parseAppleCardCsv(
    csv([row({ category: "Shopping" }), row({ category: "Shopping" })]),
  );

  assert.equal(
    first.transactions[0].provider_transaction_id,
    categoryEdit.transactions[0].provider_transaction_id,
  );
  assert.equal(
    first.transactions[1].provider_transaction_id,
    categoryEdit.transactions[1].provider_transaction_id,
  );
  assert.notEqual(
    first.transactions[0].provider_transaction_id,
    first.transactions[1].provider_transaction_id,
  );
});

test("malformed rows are reported without exposing their financial contents", () => {
  const parsed = parseAppleCardCsv(
    csv([
      row({ transactionDate: "02/30/2026" }),
      row({ amount: "not-money" }),
    ]),
  );

  assert.equal(parsed.accepted_row_count, 0);
  assert.equal(parsed.rejected_row_count, 2);
  assert.deepEqual(
    parsed.rejected.map(({ row: rowNumber, code }) => [rowNumber, code]),
    [
      [2, "invalid_date"],
      [3, "invalid_amount"],
    ],
  );
  assert.doesNotMatch(JSON.stringify(parsed.rejected), /not-money/);
});

test("Apple Card CSV rejects invalid UTF-8 and any non-USD or inexact schema", () => {
  assert.throws(
    () => parseAppleCardCsv(Buffer.from([0xff, 0xfe, 0xfd])),
    (error) =>
      error instanceof AppleCardCsvError &&
      error.code === "invalid_utf8",
  );
  assert.throws(
    () =>
      parseAppleCardCsv(
        csv([row()], "\n", [
          ...APPLE_CARD_CSV_HEADERS.slice(0, 6),
          "Amount (CAD)",
          "Purchased By",
        ]),
      ),
    (error) => error.code === "invalid_headers",
  );
  assert.throws(
    () =>
      parseAppleCardCsv(
        csv([row()], "\n", [...APPLE_CARD_CSV_HEADERS, "Extra"]),
      ),
    (error) => error.code === "invalid_headers",
  );
});

test("Apple Card CSV enforces byte and row limits", () => {
  assert.throws(
    () => parseAppleCardCsv(Buffer.alloc(APPLE_CARD_MAX_BYTES + 1, 0x61)),
    (error) =>
      error instanceof AppleCardCsvError &&
      error.statusCode === 413 &&
      error.code === "csv_too_large",
  );
  assert.throws(
    () =>
      parseAppleCardCsv(
        csv(Array.from({ length: 20_001 }, () => row())),
      ),
    (error) =>
      error instanceof AppleCardCsvError &&
      error.statusCode === 413 &&
      error.code === "too_many_rows",
  );
});
