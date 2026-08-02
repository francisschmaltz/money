import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../migrations/032_cash_flow_roles.sql",
  import.meta.url,
);

test("cash-flow role schema constrains provider, override, and cleanup layers", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  for (const table of [
    "transactions",
    "categorization_overrides",
    "transaction_cleanup_rules",
  ]) {
    assert.match(
      migration,
      new RegExp(
        `ALTER TABLE ${table}\\s+[\\s\\S]*?ADD COLUMN cash_flow_role text`,
      ),
    );
  }
  assert.match(
    migration,
    /transactions_cash_flow_role_check[\s\S]*cash_flow_role IN \('spending', 'obligation', 'transfer'\)/,
  );
  assert.match(
    migration,
    /categorization_overrides_cash_flow_role_check[\s\S]*cash_flow_role IS NULL[\s\S]*cash_flow_role IN \('spending', 'obligation', 'transfer'\)/,
  );
  assert.match(
    migration,
    /transaction_cleanup_rules_cash_flow_role_check[\s\S]*cash_flow_role IS NULL[\s\S]*cash_flow_role IN \('spending', 'obligation', 'transfer'\)/,
  );
  assert.match(
    migration,
    /transaction_cleanup_rules_has_change_check[\s\S]*OR cash_flow_role IS NOT NULL/,
  );
});

test("cash-flow role backfill prioritizes known provider intent", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const transactionBackfill = migration.match(
    /UPDATE transactions\s+SET cash_flow_role = CASE[\s\S]*?\nEND;/,
  )?.[0];
  assert.ok(transactionBackfill);

  const orderedMarkers = [
    "source_transaction_type, ''))) = 'payment'",
    "WHEN source_transaction_type IS NOT NULL",
    "('TRANSFER_IN', 'TRANSFER_OUT')",
    "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
    "concat_ws(' ', merchant_name, name)",
    "LOAN_PAYMENTS_CAR_PAYMENT",
    "LOAN_PAYMENTS_MORTGAGE_PAYMENT",
    "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT",
    "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT",
    "RENT_AND_UTILITIES_RENT",
    "WHEN excluded_from_spending THEN 'transfer'",
    "ELSE 'spending'",
  ];
  let priorIndex = -1;
  for (const marker of orderedMarkers) {
    const index = transactionBackfill.indexOf(marker);
    assert.ok(index > priorIndex, `${marker} must follow provider precedence`);
    priorIndex = index;
  }

  assert.match(
    migration,
    /UPDATE categorization_overrides[\s\S]*WHEN excluded_from_spending THEN 'transfer'[\s\S]*ELSE 'spending'[\s\S]*WHERE excluded_from_spending IS NOT NULL/,
  );
});

test("effective treatment exposes roles and keeps the exclusion compatibility read", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(
    migration,
    /CREATE OR REPLACE VIEW transaction_effective_spending_treatments/,
  );
  assert.match(
    migration,
    /COALESCE\(\s*transaction_override\.cash_flow_role,[\s\S]*cleanup_rule\.cash_flow_role,[\s\S]*merchant_override\.cash_flow_role,[\s\S]*original_transaction_override\.cash_flow_role,[\s\S]*original_cleanup_rule\.cash_flow_role,[\s\S]*original_merchant_override\.cash_flow_role,[\s\S]*original_transaction\.cash_flow_role,[\s\S]*t\.cash_flow_role/,
  );
  assert.match(
    migration,
    /effective_cash_flow_role <> 'spending'\s+AS effective_excluded_from_spending,[\s\S]*effective_cash_flow_role/,
  );
  assert.match(
    migration,
    /CASE transaction_override\.excluded_from_spending\s+WHEN true THEN 'transfer'\s+WHEN false THEN 'spending'/,
  );
});
