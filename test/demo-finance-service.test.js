import assert from "node:assert/strict";
import test from "node:test";

import { createDemoFinanceService } from "../app/services/demoFinanceService.js";

const amount = (value) => value.amount_minor;
const flattenAccounts = (result) =>
  result.data.groups.flatMap((group) => group.accounts);

test("demo overview exposes the complete wealth model", async () => {
  const service = createDemoFinanceService();
  const overview = await service.getFinanceOverview();

  assert.equal(amount(overview.data.cash), 4_487_780);
  assert.equal(amount(overview.data.cash_balance), 10_830_721);
  assert.equal(amount(overview.data.short_term_worth), 10_549_258);
  assert.equal(amount(overview.data.taxable_investments), 6_342_941);
  assert.equal(amount(overview.data.retirement_assets), 6_024_608);
  assert.equal(amount(overview.data.manual_asset_value), 3_471_461);
  assert.equal(amount(overview.data.credit_card_liabilities), 281_463);
  assert.equal(amount(overview.data.loan_liabilities), 1_618_327);
  assert.equal(amount(overview.data.assets), 20_326_790);
  assert.equal(amount(overview.data.liabilities), 1_899_790);
  assert.equal(amount(overview.data.net_worth), 18_427_000);
  assert.equal(overview.data.account_count, 7);
  assert.equal(overview.data.manual_asset_count, 1);
  assert.equal(overview.data.manual_assets[0].name, "2024 vehicle");
  assert.equal(
    amount(overview.data.manual_assets[0].current_value),
    3_471_461,
  );
});

test("demo accounts include manual assets, totals, and balance-group filters", async () => {
  const service = createDemoFinanceService();
  const all = await service.listAccounts();
  const retirement = await service.listAccounts({
    balance_group: "retirement",
  });

  assert.equal(all.data.account_count, 7);
  assert.equal(flattenAccounts(all).length, 7);
  assert.equal(all.data.manual_asset_count, 1);
  assert.equal(all.data.manual_assets[0].asset_type, "vehicle");
  assert.equal(
    amount(all.data.balance_summary.cash_balance),
    10_830_721,
  );
  assert.equal(
    amount(all.data.balance_summary.net_worth),
    18_427_000,
  );
  assert.equal(retirement.data.account_count, 2);
  assert.ok(
    flattenAccounts(retirement).every(
      (account) => account.balance_group === "retirement",
    ),
  );
});

test("demo account overrides update totals and portfolio scopes", async () => {
  const service = createDemoFinanceService();

  await service.updateAccountBalanceGroup({
    account_id: "account_brokerage",
    balance_group: "retirement",
  });

  const accounts = await service.listAccounts({
    balance_group: "retirement",
  });
  const overview = await service.getFinanceOverview();
  const trading = await service.getPortfolioSummary({
    retirement_scope: "exclude",
  });
  const retirement = await service.getPortfolioSummary({
    retirement_scope: "only",
  });

  assert.equal(accounts.data.account_count, 3);
  assert.equal(amount(overview.data.cash_balance), 4_487_780);
  assert.equal(amount(overview.data.short_term_worth), 4_206_317);
  assert.equal(amount(overview.data.net_worth), 18_427_000);
  assert.equal(amount(trading.data.total_value), 0);
  assert.equal(amount(retirement.data.total_value), 12_367_549);

  await service.updateAccountBalanceGroup({
    account_id: "account_brokerage",
    balance_group: null,
  });
  const restored = await service.getPortfolioSummary({
    retirement_scope: "exclude",
  });
  assert.equal(amount(restored.data.total_value), 6_342_941);
});

test("demo transactions expose the optimistic split version", async () => {
  const service = createDemoFinanceService();
  const ledger = await service.listTransactions({ status: "posted" });

  assert.ok(ledger.data.transactions.length > 0);
  assert.ok(
    ledger.data.transactions.every(
      (transaction) => transaction.split_version === 0,
    ),
  );
});

test("demo manual-asset mutations immediately update account and overview data", async () => {
  const service = createDemoFinanceService();
  const created = await service.createManualAsset({
    name: "Home workshop",
    asset_type: "other",
    description: "Replacement value",
    currency_code: "USD",
    value_minor: 100_000,
    valued_on: "2026-07-26",
  });

  let overview = await service.getFinanceOverview();
  let accounts = await service.listAccounts();
  assert.equal(amount(overview.data.manual_asset_value), 3_571_461);
  assert.equal(accounts.data.manual_asset_count, 2);

  await service.updateManualAsset({
    asset_id: created.asset.id,
    value_minor: 200_000,
    valued_on: "2026-07-27",
  });
  overview = await service.getFinanceOverview();
  assert.equal(amount(overview.data.manual_asset_value), 3_671_461);
  assert.equal(amount(overview.data.net_worth), 18_627_000);

  const search = await service.search("workshop", {
    entityTypes: ["manual_asset"],
  });
  assert.equal(search.groups[0].items[0].title, "Home workshop");

  await service.archiveManualAsset({ asset_id: created.asset.id });
  overview = await service.getFinanceOverview();
  accounts = await service.listAccounts();
  assert.equal(amount(overview.data.manual_asset_value), 3_471_461);
  assert.equal(accounts.data.manual_asset_count, 1);
});

test("demo portfolio scopes all, trading, and retirement coherently", async () => {
  const service = createDemoFinanceService();
  const all = await service.getPortfolioSummary({
    retirement_scope: "include",
  });
  const trading = await service.getPortfolioSummary({
    retirement_scope: "exclude",
  });
  const retirement = await service.getPortfolioSummary({
    retirement_scope: "only",
  });
  const legacyTaxable = await service.getPortfolioSummary({
    scope: "taxable",
  });
  const publicTrading = await service.getPortfolioSummary({
    scope: "trading",
  });

  assert.equal(all.data.scope, "all");
  assert.equal(trading.data.scope, "trading");
  assert.equal(retirement.data.scope, "retirement");
  assert.equal(amount(all.data.total_value), 12_367_549);
  assert.equal(amount(trading.data.total_value), 6_342_941);
  assert.equal(amount(retirement.data.total_value), 6_024_608);
  assert.equal(amount(all.data.taxable_value), 6_342_941);
  assert.equal(amount(all.data.retirement_value), 6_024_608);
  assert.ok(
    trading.data.holdings.every(
      (holding) => holding.balance_group === "taxable_investment",
    ),
  );
  assert.ok(
    retirement.data.holdings.every(
      (holding) => holding.balance_group === "retirement",
    ),
  );
  assert.equal(
    trading.data.holdings.reduce(
      (sum, holding) => sum + holding.allocation_basis_points,
      0,
    ),
    10_000,
  );
  assert.equal(legacyTaxable.data.scope, "trading");
  assert.equal(
    amount(legacyTaxable.data.total_value),
    amount(publicTrading.data.total_value),
  );

  const rothOnly = await service.getPortfolioSummary({
    retirement_scope: "only",
    account_id: "account_roth",
  });
  assert.equal(amount(rothOnly.data.total_value), 3_852_325);
  assert.equal(rothOnly.data.holdings.length, 2);
});

test("demo transaction matching exposes raw facts and ranked editable rows", async () => {
  const service = createDemoFinanceService();
  const result = await service.findTransactionMatches({
    transaction_id: "txn_whole_foods",
    q: "apple",
    limit: 50,
  });

  assert.equal(result.query, "apple");
  assert.equal(result.anchor.id, "txn_whole_foods");
  assert.equal(result.anchor.raw_merchant, "WHOLE FOODS MKT #1024");
  assert.equal(result.anchor.raw_name, "WHOLE FOODS MKT #1024");
  assert.equal(result.anchor.preselected, true);
  assert.deepEqual(
    result.matches.map((match) => match.id),
    ["txn_apple_services"],
  );
  assert.equal(result.matches[0].match_reason, "text_match");
  assert.ok(result.matches[0].similarity_basis_points >= 9_300);
  assert.deepEqual(result.available_tags, [
    "Business",
    "Reimbursable",
    "Tax",
  ]);
});

test("demo batch edits are atomic and immediately affect transactions and search", async () => {
  const service = createDemoFinanceService();
  const updated = await service.batchEditTransactions({
    transaction_ids: ["txn_whole_foods", "txn_apple_services"],
    changes: {
      display_name: "Household purchase",
      category_primary: "Household",
      tags: ["Reimbursable", "Shared"],
      excluded_from_spending: true,
      is_fixed: true,
    },
  });

  assert.deepEqual(updated, {
    updated_count: 2,
    transaction_ids: ["txn_whole_foods", "txn_apple_services"],
  });
  const ledger = await service.listTransactions({ status: "posted" });
  const edited = ledger.data.transactions.filter((transaction) =>
    updated.transaction_ids.includes(transaction.id),
  );
  assert.equal(edited.length, 2);
  assert.ok(
    edited.every(
      (transaction) =>
        transaction.display_name === "Household purchase" &&
        transaction.category_primary === "Household" &&
        transaction.excluded_from_spending === true &&
        transaction.is_fixed === true &&
        transaction.raw_merchant !== "Household purchase",
    ),
  );
  assert.deepEqual(edited[0].tags, ["Reimbursable", "Shared"]);

  const search = await service.search("Shared", {
    entityTypes: ["transaction"],
  });
  assert.equal(search.groups[0].items.length, 2);
  const matches = await service.findTransactionMatches({
    q: "Household purchase",
  });
  assert.deepEqual(
    matches.matches.map((match) => match.id),
    ["txn_whole_foods", "txn_apple_services"],
  );
  assert.deepEqual(matches.available_tags, [
    "Business",
    "Reimbursable",
    "Shared",
    "Tax",
  ]);

  const freshService = createDemoFinanceService();
  await assert.rejects(
    freshService.batchEditTransactions({
      transaction_ids: ["txn_whole_foods", "txn_con_edison"],
      changes: { display_name: "Should not stick" },
    }),
    (error) =>
      error.statusCode === 400 &&
      /Pending transactions/.test(error.message),
  );
  const untouched = await freshService.listTransactions({
    status: "posted",
  });
  assert.equal(
    untouched.data.transactions.find(
      (transaction) => transaction.id === "txn_whole_foods",
    ).display_name,
    "Whole Foods Market",
  );
  await assert.rejects(
    freshService.batchEditTransactions({
      transaction_ids: Array.from(
        { length: 101 },
        (_, index) => `txn_${index}`,
      ),
      changes: { tags: [] },
    }),
    (error) => error.statusCode === 400,
  );
});

test("demo cleanup rules apply exact provider normalization without overriding manual edits", async () => {
  const service = createDemoFinanceService();
  const initial = await service.listTransactionCleanupRules();
  assert.equal(initial.rules.length, 1);
  assert.equal(
    initial.rules[0].matcher.field,
    "normalized_merchant",
  );

  const createdResult = await service.createTransactionCleanupRule({
    matcher: {
      field: "normalized_name",
      value: "AAPL SRV 0042",
    },
    changes: {
      display_name: "Apple billing",
      category_primary: "Shopping",
      tags: ["Tax"],
    },
    enabled: true,
  });
  const created = createdResult.rule;
  assert.equal(createdResult.created, true);
  assert.equal(created.matcher.normalized_value, "aapl srv");
  assert.equal(created.matched_transaction_count, 1);

  let ledger = await service.listTransactions({ status: "posted" });
  let apple = ledger.data.transactions.find(
    (transaction) => transaction.id === "txn_apple_services",
  );
  assert.equal(apple.raw_name, "AAPL SRV 0042");
  assert.equal(apple.display_name, "Apple billing");
  assert.equal(apple.category_primary, "Shopping");
  assert.deepEqual(apple.tags, ["Tax"]);

  const merchantWinnerResult =
    await service.createTransactionCleanupRule({
      matcher: {
        field: "normalized_merchant",
        value: "Apple Services",
      },
      changes: { display_name: "Apple merchant winner" },
    });
  let rules = (await service.listTransactionCleanupRules()).rules;
  assert.equal(
    rules.find((rule) => rule.id === created.id)
      .matched_transaction_count,
    0,
  );
  assert.equal(
    rules.find(
      (rule) => rule.id === merchantWinnerResult.rule.id,
    ).matched_transaction_count,
    1,
  );
  ledger = await service.listTransactions({ status: "posted" });
  apple = ledger.data.transactions.find(
    (transaction) => transaction.id === "txn_apple_services",
  );
  assert.equal(apple.display_name, "Apple merchant winner");
  await service.deleteTransactionCleanupRule({
    rule_id: merchantWinnerResult.rule.id,
  });

  const fuzzyNearMissResult =
    await service.createTransactionCleanupRule({
      matcher: {
        field: "normalized_name",
        value: "AAPL SERVICE",
      },
      changes: { display_name: "Must not apply" },
    });
  const fuzzyNearMiss = fuzzyNearMissResult.rule;
  assert.equal(fuzzyNearMiss.matched_transaction_count, 0);
  ledger = await service.listTransactions({ status: "posted" });
  apple = ledger.data.transactions.find(
    (transaction) => transaction.id === "txn_apple_services",
  );
  assert.equal(apple.display_name, "Apple billing");

  const pendingRuleResult =
    await service.createTransactionCleanupRule({
      matcher: {
        field: "normalized_merchant",
        value: "Con Edison",
      },
      changes: { display_name: "ConEd" },
    });
  assert.equal(
    pendingRuleResult.rule.matched_transaction_count,
    0,
  );
  const pendingLedger = await service.listTransactions({
    status: "pending",
  });
  assert.equal(
    pendingLedger.data.transactions[0].display_name,
    "ConEd",
  );

  const disabled = await service.updateTransactionCleanupRule({
    rule_id: created.id,
    matcher: {
      field: created.matcher.field,
      value: created.matcher.value,
    },
    changes: created.changes,
    enabled: false,
  });
  assert.equal(disabled.rule.matched_transaction_count, 0);
  rules = (
    await service.listTransactionCleanupRules({
      include_disabled: false,
    })
  ).rules;
  assert.equal(
    rules.some((rule) => rule.id === created.id),
    false,
  );
  ledger = await service.listTransactions({ status: "posted" });
  apple = ledger.data.transactions.find(
    (transaction) => transaction.id === "txn_apple_services",
  );
  assert.equal(apple.display_name, "Apple Services");
  assert.equal(apple.category_primary, "Subscriptions");
  assert.deepEqual(apple.tags, []);

  await service.updateTransactionCleanupRule({
    rule_id: created.id,
    matcher: {
      field: created.matcher.field,
      value: created.matcher.value,
    },
    changes: created.changes,
    enabled: true,
  });
  await service.batchEditTransactions({
    transaction_ids: ["txn_apple_services"],
    changes: { display_name: "Apple one-off fix" },
  });
  await service.batchEditTransactions({
    transaction_ids: ["txn_apple_services"],
    changes: { display_name: null },
  });
  ledger = await service.listTransactions({ status: "posted" });
  apple = ledger.data.transactions.find(
    (transaction) => transaction.id === "txn_apple_services",
  );
  assert.equal(apple.display_name, "Apple billing");

  await service.batchEditTransactions({
    transaction_ids: ["txn_apple_services"],
    changes: { display_name: "Apple one-off fix" },
  });
  await service.deleteTransactionCleanupRule({
    rule_id: created.id,
  });

  ledger = await service.listTransactions({ status: "posted" });
  apple = ledger.data.transactions.find(
    (transaction) => transaction.id === "txn_apple_services",
  );
  assert.equal(apple.display_name, "Apple one-off fix");
  assert.equal(apple.category_primary, "Subscriptions");
  assert.deepEqual(apple.tags, []);
});
