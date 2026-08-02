import assert from "node:assert/strict";
import test from "node:test";

import { DEMO_IDS } from "../app/demo/fixtureIds.js";
import {
  UX_STRESS_SPLIT_TRANSACTION_ID,
} from "../app/demo/uxStressScenario.js";
import { createDemoFinanceService } from "../app/services/demoFinanceService.js";
import { createDemoPlanningService } from "../app/services/demoPlanningService.js";

const amount = (value) => value.amount_minor;
const flattenAccounts = (result) =>
  result.data.groups.flatMap((group) => group.accounts);

test("UX stress demo paginates hostile transactions and keeps long account data", async () => {
  const service = createDemoFinanceService({
    scenario: "ux-stress",
  });
  const first = await service.listTransactions({ limit: 100 });
  const second = await service.listTransactions({
    limit: 100,
    cursor: first.data.page_info.next_cursor,
  });
  const third = await service.listTransactions({
    limit: 100,
    cursor: second.data.page_info.next_cursor,
  });
  const accountResult = await service.listAccounts({ limit: 100 });
  const rows = [
    ...first.data.transactions,
    ...second.data.transactions,
    ...third.data.transactions,
  ];

  assert.equal(first.data.transactions.length, 100);
  assert.equal(second.data.transactions.length, 100);
  assert.ok(third.data.transactions.length > 80);
  assert.equal(third.data.page_info.has_more, false);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  const dates = rows
    .map((row) => row.posted_on ?? row.date)
    .sort();
  assert.ok(
    (Date.parse(`${dates.at(-1)}T00:00:00.000Z`) -
      Date.parse(`${dates[0]}T00:00:00.000Z`)) /
      86_400_000 >=
      389,
  );
  assert.ok(
    rows.some(
      (row) => row.display_name.length > 60,
    ),
  );
  assert.ok(
    rows.some(
      (row) =>
        Math.abs(row.amount.amount_minor) >= 100_000_000,
    ),
  );
  assert.ok(
    flattenAccounts(accountResult).some(
      (account) => account.name.length > 45,
    ),
  );
});

test("UX stress demo preloads a valid split transaction", async () => {
  const financeService = createDemoFinanceService({
    scenario: "ux-stress",
  });
  const planningService = createDemoPlanningService({
    scenario: "ux-stress",
  });
  const ledger = await financeService.listTransactions({
    search: "Metropolitan Transportation Authority",
    limit: 100,
  });
  const transaction = ledger.data.transactions.find(
    (row) => row.id === UX_STRESS_SPLIT_TRANSACTION_ID,
  );
  const split = await planningService.getTransactionSplit({
    transaction_id: UX_STRESS_SPLIT_TRANSACTION_ID,
  });

  assert.ok(transaction);
  assert.equal(split.split_version, 1);
  assert.equal(split.lines.length, 2);
  assert.equal(
    split.lines.reduce(
      (sum, line) => sum + line.amount_minor,
      0,
    ),
    transaction.amount.amount_minor,
  );
});

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
  assert.equal(overview.data.account_count, 8);
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

  assert.equal(all.data.account_count, 8);
  assert.equal(flattenAccounts(all).length, 8);
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

test("rejected demo category edits leave the prior state untouched", async () => {
  const service = createDemoFinanceService();
  const before = await service.listSpendingCategories({
    include_merged: true,
  });
  const dining = before.categories.find(
    (category) => category.path === "Dining",
  );

  await assert.rejects(
    service.updateSpendingCategory({
      category_id: dining.id,
      name: "Travel",
      classification: "fixed",
      expected_version: dining.version,
    }),
    (error) => error.statusCode === 409,
  );

  const after = await service.listSpendingCategories({
    include_merged: true,
  });
  const unchanged = after.categories.find(
    (category) => category.id === dining.id,
  );
  assert.equal(unchanged.name, "Dining");
  assert.equal(unchanged.path, "Dining");
  assert.equal(unchanged.classification, "flexible");
  assert.equal(unchanged.parent_category_id, null);
  assert.equal(unchanged.version, dining.version);
});

test("merging or deleting a demo parent reparents children and their transactions", async () => {
  const service = createDemoFinanceService();
  const parent = (
    await service.createSpendingCategory({
      name: "Vehicle",
      classification: "fixed",
    })
  ).category;
  const child = (
    await service.createSpendingCategory({
      name: "Fuel",
      classification: "flexible",
      parent_category_id: parent.id,
    })
  ).category;
  const destination = (
    await service.createSpendingCategory({
      name: "Transport",
      classification: "flexible",
    })
  ).category;
  await service.batchEditTransactions({
    transaction_ids: ["txn_004"],
    changes: { category_primary: child.path },
  });

  await service.mergeSpendingCategories({
    source_category_ids: [parent.id],
    destination: { category_id: destination.id },
    expected_versions: {
      [parent.id]: parent.version,
      [destination.id]: destination.version,
    },
  });
  let categories = (
    await service.listSpendingCategories({ include_merged: true })
  ).categories;
  let reparented = categories.find(
    (category) => category.id === child.id,
  );
  assert.equal(reparented.parent_category_id, null);
  assert.equal(reparented.path, "Fuel");
  let transactions = (
    await service.listTransactions({ status: "posted", limit: 100 })
  ).data.transactions;
  assert.equal(
    transactions.find((transaction) => transaction.id === "txn_004")
      .category_primary,
    "Fuel",
  );

  const secondParent = (
    await service.createSpendingCategory({
      name: "Home",
      classification: "fixed",
    })
  ).category;
  const secondChild = (
    await service.createSpendingCategory({
      name: "Repairs",
      classification: "flexible",
      parent_category_id: secondParent.id,
    })
  ).category;
  await service.batchEditTransactions({
    transaction_ids: ["txn_006"],
    changes: { category_primary: secondChild.path },
  });
  await service.deleteSpendingCategory({
    category_id: secondParent.id,
    expected_version: secondParent.version,
  });

  categories = (
    await service.listSpendingCategories({ include_merged: true })
  ).categories;
  reparented = categories.find(
    (category) => category.id === secondChild.id,
  );
  assert.equal(reparented.parent_category_id, null);
  assert.equal(reparented.path, "Repairs");
  transactions = (
    await service.listTransactions({ status: "posted", limit: 100 })
  ).data.transactions;
  assert.equal(
    transactions.find((transaction) => transaction.id === "txn_006")
      .category_primary,
    "Repairs",
  );
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

test("demo transaction notes save optimistically and are searchable", async () => {
  const service = createDemoFinanceService();
  const ledger = await service.listTransactions({ status: "posted" });
  const transaction = ledger.data.transactions.find(
    (item) => item.id === "txn_whole_foods",
  );

  assert.equal(transaction.note_version, 1);
  const saved = await service.updateTransactionNote(
    {
      transaction_id: transaction.id,
      note: "  Split with Alex  ",
      expected_note_version: 1,
    },
    { id: "member-1" },
  );
  assert.equal(saved.note, "Split with Alex");
  assert.equal(saved.note_version, 2);

  const filtered = await service.listTransactions({
    status: "posted",
    search: "Alex",
  });
  assert.deepEqual(
    filtered.data.transactions.map((item) => item.id),
    [transaction.id],
  );
  const global = await service.search("Alex", {
    entityTypes: ["transaction"],
  });
  assert.deepEqual(
    global.groups[0].items.map((item) => item.url),
    [`/transactions?transaction=${transaction.id}`],
  );

  await assert.rejects(
    service.updateTransactionNote({
      transaction_id: transaction.id,
      note: "Stale edit",
      expected_note_version: 1,
    }),
    (error) => error.statusCode === 409,
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
  const mixedUpdate = await freshService.batchEditTransactions({
    transaction_ids: ["txn_whole_foods", "txn_con_edison"],
    changes: {
      display_name: "Pending-safe edit",
      cash_flow_role: "obligation",
    },
  });
  assert.equal(mixedUpdate.updated_count, 2);
  const updatedPosted = await freshService.listTransactions({
    status: "posted",
  });
  assert.equal(
    updatedPosted.data.transactions.find(
      (transaction) => transaction.id === "txn_whole_foods",
    ).cash_flow_role,
    "obligation",
  );
  const updatedPending = await freshService.listTransactions({
    status: "pending",
  });
  assert.equal(
    updatedPending.data.transactions.find(
      (transaction) => transaction.id === "txn_con_edison",
    ).display_name,
    "Pending-safe edit",
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

test("demo Plan month edits persist the exact selected month", async () => {
  const service = createDemoFinanceService();
  const posted = await service.listTransactions({ status: "posted" });
  const target = posted.data.transactions.find(
    (transaction) => transaction.date.startsWith("2026-07"),
  );
  assert.ok(target);

  await service.batchEditTransactions({
    transaction_ids: [target.id],
    changes: { budget_month_offset: -1 },
  });
  let edited = (
    await service.listTransactions({ status: "posted" })
  ).data.transactions.find((transaction) => transaction.id === target.id);
  assert.equal(edited.budget_month_on, "2026-06-01");

  await service.batchEditTransactions({
    transaction_ids: [target.id],
    changes: { budget_month_offset: 0 },
  });
  edited = (
    await service.listTransactions({ status: "posted" })
  ).data.transactions.find((transaction) => transaction.id === target.id);
  assert.equal(edited.budget_month_on, "2026-07-01");

  await assert.rejects(
    service.batchEditTransactions({
      transaction_ids: [target.id],
      changes: { budget_month_offset: 12 },
    }),
    /budget_month_offset must be -1, 0, or 1/,
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
      cash_flow_role: "obligation",
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
  assert.equal(apple.cash_flow_role, "obligation");
  assert.equal(apple.excluded_from_spending, true);
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
  assert.equal(apple.display_name, "Apple Services");

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

test("demo cleanup contains rules match any normalized substring and yield to exact rules", async () => {
  const service = createDemoFinanceService();
  const containsResult = await service.createTransactionCleanupRule({
    matcher: {
      field: "normalized_name",
      mode: "contains",
      value: "SRV",
    },
    changes: { display_name: "Contained billing" },
  });

  assert.equal(containsResult.rule.matcher.mode, "contains");
  assert.equal(containsResult.rule.matched_transaction_count, 1);
  let ledger = await service.listTransactions({ status: "posted" });
  let apple = ledger.data.transactions.find(
    (transaction) => transaction.id === "txn_apple_services",
  );
  assert.equal(apple.display_name, "Contained billing");

  const exactResult = await service.createTransactionCleanupRule({
    matcher: {
      field: "normalized_name",
      mode: "exact",
      value: "AAPL SRV 0042",
    },
    changes: { display_name: "Exact billing" },
  });
  const rules = (await service.listTransactionCleanupRules()).rules;
  assert.equal(
    rules.find((rule) => rule.id === containsResult.rule.id)
      .matched_transaction_count,
    0,
  );
  assert.equal(exactResult.rule.matched_transaction_count, 1);
  ledger = await service.listTransactions({ status: "posted" });
  apple = ledger.data.transactions.find(
    (transaction) => transaction.id === "txn_apple_services",
  );
  assert.equal(apple.display_name, "Exact billing");
});

test("demo bulk insight actions enforce subscription-only corrections", async () => {
  const service = createDemoFinanceService();
  const archived = await service.batchActOnFindings({
    finding_ids: [
      DEMO_IDS.insights.weeklyDining,
      DEMO_IDS.insights.weeklyCoffee,
    ],
    action: "archive",
  });
  assert.equal(archived.updated_count, 2);
  assert.equal(archived.state, "archived");

  const restoredFromWeb = await service.batchActOnFindings({
    finding_ids: [
      "ins_week_archive_001",
      "ins_sub_archive_001",
    ],
    action: "restore",
  });
  assert.equal(restoredFromWeb.updated_count, 2);
  assert.equal(restoredFromWeb.state, "active");

  const corrected = await service.batchActOnFindings({
    finding_ids: [
      DEMO_IDS.insights.subscriptionDuplicate,
      DEMO_IDS.insights.subscriptionExpensive,
    ],
    action: "report_incorrect",
    reason_code: "not_subscription",
  });
  assert.equal(corrected.updated_count, 2);
  assert.equal(corrected.reason_code, "not_subscription");

  await assert.rejects(
    service.batchActOnFindings({
      finding_ids: [DEMO_IDS.insights.weeklyDining],
      action: "report_incorrect",
      reason_code: "not_subscription",
    }),
    (error) => error.statusCode === 400,
  );
});
