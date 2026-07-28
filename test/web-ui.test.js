import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import ejs from "ejs";
import express from "express";
import request from "supertest";
import {
  buildDemoModel,
  createWebRouter,
  formatMoney,
} from "../app/routes/web.js";
import {
  createDemoFinanceService,
} from "../app/services/demoFinanceService.js";

const viewsRoot = path.resolve("app/views");
const demo = buildDemoModel();

function locals(overrides = {}) {
  return {
    ...demo,
    formatMoney,
    activePath: "/",
    currentPath: "/",
    pageTitle: "Dashboard",
    pageDescription: "Description",
    query: {},
    csrfToken: "csrf-test-value",
    ...overrides,
  };
}

async function render(view, overrides = {}) {
  return ejs.renderFile(path.join(viewsRoot, `${view}.ejs`), locals(overrides));
}

test("all primary finance views render with shared navigation and local assets", async () => {
  const pages = [
    ["dashboard", "/"],
    ["insights", "/insights"],
    ["transactions", "/transactions"],
    ["recurring", "/recurring"],
    ["portfolio", "/portfolio"],
    ["credit", "/credit"],
    ["accounts", "/accounts"],
    ["settings", "/settings"],
  ];

  for (const [view, activePath] of pages) {
    const html = await render(view, {
      pageTitle: view[0].toUpperCase() + view.slice(1),
      activePath,
    });
    assert.match(html, /\/vendor\/phosphor\/regular\/style\.css/);
    assert.match(html, /\/vendor\/chart\/chart\.umd\.js/);
    assert.match(html, /data-search-dialog/);
    if (activePath !== "/settings") {
      assert.match(html, new RegExp(`href="${activePath === "/" ? "\\/" : activePath}" aria-current="page"`));
    } else {
      assert.match(html, /<h1>Settings<\/h1>/);
    }
  }
});

test("Plaid OAuth callback renders a resumable authenticated return page", async () => {
  const app = express();
  app.set("views", viewsRoot);
  app.set("view engine", "ejs");
  app.use(createWebRouter({ demoMode: true }));

  const response = await request(app)
    .get("/plaid/oauth?oauth_state_id=plaid-state")
    .expect(200);

  assert.match(response.text, /data-page="plaid-oauth"/);
  assert.match(response.text, /data-plaid-oauth-return/);
  assert.match(response.text, /Returning to Plaid/);
  assert.match(response.text, /\/js\/money\.js\?v=15/);
  assert.doesNotMatch(response.text, /data-search-dialog/);
});

test("primary page headings omit redundant subtitles", async () => {
  const sharedHeadingPages = [
    "Dashboard",
    "Plan",
    "Insights",
    "Transactions",
    "Recurring",
    "Portfolio",
    "Credit",
    "Accounts",
    "Settings",
  ];
  const redundantSubtitle = "This page already explains itself.";

  for (const pageTitle of sharedHeadingPages) {
    const html = await render("partials/page-heading", {
      pageTitle,
      pageDescription: redundantSubtitle,
      eyebrow: "Your finances",
    });

    assert.doesNotMatch(
      html,
      /class="page-description"/,
      `${pageTitle} should not render a page subtitle`,
    );
    assert.doesNotMatch(
      html,
      new RegExp(redundantSubtitle),
      `${pageTitle} should not render pageDescription`,
    );
  }

  const searchHtml = await render("search", {
    pageTitle: "Search",
    pageDescription: redundantSubtitle,
    activePath: "/search",
  });
  assert.doesNotMatch(searchHtml, /class="page-description"/);
  assert.doesNotMatch(searchHtml, new RegExp(redundantSubtitle));
});

test("dashboard defaults to cash and exposes four truthful balance views", async () => {
  const html = await render("dashboard");
  assert.match(html, /data-chart="line"/);
  assert.match(html, /data-chart="spending"/);
  assert.match(html, /Spend less on Dining/);
  assert.match(html, /Review VTI concentration/);
  assert.doesNotMatch(html, /Portfolio gained 1\.8% this month/);
  assert.match(html, /Check whether you need both Apple subscriptions/);
  assert.match(html, /data-dashboard-balance/);
  assert.match(
    html,
    /role="group" aria-label="Dashboard balance view"/,
  );
  assert.match(
    html,
    /data-balance-metric="cash"[\s\S]*?aria-pressed="true"[\s\S]*?>Cash<\/button>/,
  );
  for (const [metric, label] of [
    ["short_term", "Short Term"],
    ["retirement", "Retirement"],
    ["net_worth", "Net Worth"],
  ]) {
    assert.match(
      html,
      new RegExp(
        `data-balance-metric="${metric}"[\\s\\S]*?aria-pressed="false"[\\s\\S]*?>${label}<\\/button>`,
      ),
    );
  }
  assert.match(html, /data-balance-label>Cash balance</);
  assert.match(
    html,
    /data-balance-value>\$108,307\.21<\/h2>/,
  );
  assert.doesNotMatch(html, /class="wealth-ladder/);
  assert.match(
    html,
    /aria-label="Cash balance history · Last month"/,
  );
  assert.match(html, />Spending this month</);
  assert.match(html, />Cash flow this month</);

  const encodedMetrics = html.match(/data-metrics="([^"]+)"/)?.[1];
  assert.ok(encodedMetrics);
  const metricPayload = JSON.parse(
    encodedMetrics
      .replaceAll("&#34;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&amp;", "&"),
  );
  assert.deepEqual(Object.keys(metricPayload), [
    "cash",
    "short_term",
    "retirement",
    "net_worth",
  ]);
  assert.equal(metricPayload.short_term.label, "Short-term worth");
  assert.equal(metricPayload.short_term.action_label, "Credit details");
  assert.equal(metricPayload.short_term.action_href, "/credit");
  assert.equal(
    metricPayload.short_term.description,
    "Cash balance − credit-card debt",
  );
  assert.equal(metricPayload.retirement.label, "Retirement");
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(metricPayload).map(([key, metric]) => [
        key,
        metric.value.amount_minor,
      ]),
    ),
    {
      cash: 10_830_721,
      short_term: 10_549_258,
      retirement: 6_024_608,
      net_worth: 18_427_000,
    },
  );
  for (const metric of Object.values(metricPayload)) {
    assert.equal(metric.value.currency, "USD");
    assert.equal(
      metric.series.at(-1),
      metric.value.amount_minor,
    );
  }
});

test("dashboard places insights before spending", async () => {
  const html = await render("dashboard");
  const insightsPosition = html.indexOf('aria-labelledby="insight-heading"');
  const spendingPosition = html.indexOf('aria-labelledby="spending-heading"');

  assert.notEqual(insightsPosition, -1);
  assert.notEqual(spendingPosition, -1);
  assert.ok(
    insightsPosition < spendingPosition,
    "expected Insights to render before Spend by category",
  );
});

test("transactions puts detailed spending analysis before the ledger", async () => {
  const html = await render("transactions", {
    pageTitle: "Transactions",
    activePath: "/transactions",
    query: {
      period: "30",
      q: "coffee",
      account: "acc_001",
    },
  });
  const spendingPosition = html.indexOf(
    'aria-labelledby="transaction-spending-heading"',
  );
  const ledgerPosition = html.indexOf("<h2>All transactions</h2>");

  assert.notEqual(spendingPosition, -1);
  assert.notEqual(ledgerPosition, -1);
  assert.ok(spendingPosition < ledgerPosition);
  assert.match(html, /<h2 id="transaction-spending-heading">Spending detail<\/h2>/);
  assert.match(html, /\$4,126\.84/);
  assert.match(html, /\$4,605\.00/);
  assert.match(html, /10\.4% less than the prior period/);
  assert.match(
    html,
    />38<small>Pending activity is excluded<\/small><\/dd>/,
  );
  assert.match(html, /\$108\.60/);
  assert.match(html, /data-chart="spending"/);
  assert.match(html, /data-chart="line"/);
  assert.match(html, /Daily spending for Jul 1, 2026–Jul 26, 2026/);
  assert.match(html, /35% · 2 purchases/);
  assert.match(
    html,
    /href="\/transactions\?period=30&amp;q=coffee&amp;account=acc_001&amp;category=Housing"/,
  );
  assert.match(html, />Posted spending</);
  assert.match(html, /<h3>All categories<\/h3>/);
  assert.doesNotMatch(html, /<h3>Top categories<\/h3>/);
  assert.match(html, /Fees &amp; Interest/);
  assert.equal(
    (html.match(/class="spending-detail-category"/g) ?? []).length,
    demo.spendingDetails.categories.length,
  );
  const feeFilteredHtml = await render("transactions", {
    pageTitle: "Transactions",
    activePath: "/transactions",
    query: { category: "Fees & Interest" },
    transactions: demo.transactions.filter(
      (transaction) => transaction.category === "Fees & Interest",
    ),
  });
  assert.match(feeFilteredHtml, /Seacomm Overdraft Fee/);
  assert.match(feeFilteredHtml, /Personal Loan Interest/);
});

test("selected transactions link administrators to Settings cleanup", async () => {
  const html = await render("transactions", {
    pageTitle: "Transactions",
    activePath: "/transactions",
    selectedTransaction: demo.transactions[0],
  });

  assert.match(
    html,
    /href="\/settings\?transaction=txn_whole_foods#transaction-cleanup"/,
  );
  assert.match(html, /Clean up name, category &amp; tags/);
  assert.doesNotMatch(html, /data-transaction-classification/);
});

test("transaction split editing preserves custom categories and hides unsupported currencies", async () => {
  const customCategory = "Shared family expense";
  const customHtml = await render("transactions", {
    pageTitle: "Transactions",
    activePath: "/transactions",
    selectedTransaction: demo.transactions[0],
    selectedTransactionSplits: [
      { category: customCategory, amount_minor: -5_000 },
      { category: "Groceries", amount_minor: -8_842 },
    ],
  });
  assert.match(
    customHtml,
    new RegExp(
      `<option value="${customCategory}" selected>${customCategory}<\\/option>`,
    ),
  );

  const foreignHtml = await render("transactions", {
    pageTitle: "Transactions",
    activePath: "/transactions",
    selectedTransaction: {
      ...demo.transactions[0],
      amount: { amount_minor: -13_842, currency: "CAD" },
    },
  });
  assert.match(
    foreignHtml,
    /Transaction splits currently support USD only\./,
  );
  assert.doesNotMatch(foreignHtml, /data-transaction-split/);
});

test("category-filtered transaction HTTP keeps the split projection in rows and detail", async () => {
  const projected = {
    id: "split-parent",
    merchant: "Family market",
    displayName: "Family market",
    rawMerchant: "Family market",
    rawName: "Family market",
    tags: [],
    category: "Dining",
    account: "Checking",
    amount: { amount_minor: -4_250, currency: "USD" },
    providerAmount: { amount_minor: -10_000, currency: "USD" },
    date: "2026-07-20",
    status: "posted",
    excludedFromSpending: false,
    isFixed: false,
    splitVersion: 3,
    isSplitCategoryProjection: true,
    splitCategoryLineCount: 2,
    icon: "ph-fork-knife",
  };
  const app = express();
  app.set("views", viewsRoot);
  app.set("view engine", "ejs");
  app.use(
    createWebRouter({
      demoMode: false,
      financeService: {
        async getPageData() {
          return {
            ...demo,
            freshness: "Fresh",
            transactions: [projected],
            transactionPageInfo: {
              has_more: false,
              next_cursor: null,
            },
            selectedTransaction: projected,
          };
        },
      },
      planningService: {
        async getTransactionSplit() {
          return {
            split_version: 3,
            lines: [
              { category: "Dining", amount_minor: -4_250 },
              { category: "Groceries", amount_minor: -5_750 },
            ],
          };
        },
      },
    }),
  );

  const result = await request(app)
    .get(
      "/transactions?category=Dining&transaction=split-parent",
    )
    .expect(200);

  assert.match(
    result.text,
    /href="\/transactions\?category=Dining&amp;transaction=split-parent"/,
  );
  assert.match(
    result.text,
    /id="selected-transaction-heading">Family market<\/h2>/,
  );
  assert.match(result.text, /Dining · Checking · 2026-07-20/);
  assert.match(result.text, /data-source-amount="-10000"/);
  assert.match(result.text, /name="expected_version" value="3"/);
  assert.match(result.text, /-\$42\.50/);
  assert.doesNotMatch(result.text, /Shopping · Checking/);
});

test("accounts show inventory with local rename and direct Settings controls", async () => {
  const html = await render("accounts", {
    pageTitle: "Accounts",
    activePath: "/accounts",
    query: { account: "acc_001", asset: "asset_001" },
  });
  assert.match(html, /Cash balance/);
  assert.match(html, /\$108,307\.21/);
  assert.match(html, /Short-term worth/);
  assert.match(html, /\$105,492\.58/);
  assert.match(html, /Trading investments/);
  assert.match(html, /Retirement investments/);
  assert.match(html, /Manually tracked assets/);
  assert.match(html, /2024 vehicle/);
  assert.match(html, /\$34,714\.61/);
  assert.match(html, /id="account-acc_001"/);
  assert.match(html, /data-account-alias-edit="acc_001"/);
  assert.match(html, /data-account-display-name="acc_001"/);
  assert.match(html, /data-account-alias-dialog/);
  assert.match(html, /Plaid’s original name stays untouched/);
  assert.match(html, /href="\/settings#account-acc_001"/);
  assert.match(
    html,
    /href="\/settings\?asset=asset_001#asset-asset_001"/,
  );
  assert.doesNotMatch(html, /\/accounts\?account=/);
  assert.doesNotMatch(html, /Selected account/);
  assert.doesNotMatch(html, /Close account details/);
});

test("backend account controls stay admin-only while local aliases stay available", async () => {
  const html = await render("accounts", {
    pageTitle: "Accounts",
    activePath: "/accounts",
    viewer: {
      name: "Read only",
      email: "reader@example.com",
      initials: "RO",
      is_admin: false,
    },
  });
  assert.match(html, /href="\/accounts" aria-current="page"/);
  assert.match(html, /account-row--readonly/);
  assert.match(html, /data-account-alias-edit="acc_001"/);
  assert.doesNotMatch(html, /href="\/settings#account-/);
  assert.doesNotMatch(html, /Connect account/);
  assert.doesNotMatch(html, /Manage manual assets/);
});

test("portfolio exposes all, trading, and retirement views while preserving period", async () => {
  const html = await render("portfolio", {
    pageTitle: "Portfolio",
    activePath: "/portfolio",
    query: { period: "1y", scope: "retirement" },
  });
  assert.match(html, /aria-label="Investment account scope"/);
  assert.match(html, />All<\/a>/);
  assert.match(html, />Trading<\/a>/);
  assert.match(html, />Retirement<\/a>/);
  assert.match(html, /scope=all/);
  assert.match(html, /scope=trading/);
  assert.match(html, /scope=retirement/);
  assert.match(
    html,
    /href="\/portfolio\?period=1y&amp;scope=retirement" aria-current="page"/,
  );

  const legacy = await render("portfolio", {
    pageTitle: "Portfolio",
    activePath: "/portfolio",
    query: { period: "1m", scope: "taxable" },
  });
  assert.match(
    legacy,
    /href="\/portfolio\?period=1m&amp;scope=trading" aria-current="page"/,
  );
});

test("settings exposes account grouping and manual asset CRUD controls", async () => {
  const html = await render("settings", {
    pageTitle: "Settings",
    activePath: "/settings",
    query: { asset: "asset_001" },
  });
  assert.match(html, /data-account-group-form/);
  assert.match(html, /id="account-acc_001"/);
  assert.match(html, /value="taxable_investment"/);
  assert.match(html, /Cash balance minus credit-card debt/);
  assert.match(html, /data-manual-asset-create/);
  assert.match(html, /data-manual-asset-edit/);
  assert.match(
    html,
    /name="value" type="text" inputmode="decimal"/,
  );
  assert.match(
    html,
    /id="asset-asset_001"[\s\S]*?data-manual-asset-item="asset_001"[\s\S]*?open/,
  );
  assert.match(html, /data-manual-asset-archive="asset_001"/);
  assert.match(html, /value="34714\.61"/);
  assert.match(html, />Home \/ real estate</);
  assert.match(html, /href="#transaction-cleanup"/);
  assert.match(html, /data-transaction-cleanup/);
  assert.match(html, /data-cleanup-search/);
  assert.match(html, /Fuzzy matching suggests candidates/);
});

test("settings exposes Apple Card CSV preview, manual freshness, and card values", async () => {
  const html = await render("settings", {
    pageTitle: "Settings",
    activePath: "/settings",
    connections: [
      {
        id: "connection-apple-card",
        provider: "apple_card",
        ingestion_method: "csv",
        institution_name: "Apple Card",
        status: "active",
        imported_through_on: "2026-07-19",
        balance_as_of: "2026-07-18",
        current_balance_minor: 12_345,
        credit_limit_minor: 500_000,
        manual_update_due: true,
        last_imported_at: "2026-07-19T12:00:00.000Z",
        last_import: {
          new_row_count: 4,
          existing_row_count: 2,
          warning_count: 1,
        },
      },
    ],
  });

  assert.match(html, /Connect with Plaid/);
  assert.match(html, /Import Apple Card CSV/);
  assert.match(html, /Manual CSV · Posted through 2026-07-19/);
  assert.match(html, /Balance \$123\.45\s+as of 2026-07-18/);
  assert.match(html, /Limit \$5,000\.00/);
  assert.match(html, /Manual update due/);
  assert.match(html, /data-apple-card-import-form/);
  assert.match(html, /data-apple-card-values-form/);
  assert.match(html, /data-apple-card-remove/);
  assert.match(html, /never stored/);
  assert.doesNotMatch(html, /synced through/i);
});

test("transaction cleanup preloads raw values and leaves fuzzy rows unchecked", async () => {
  const html = await render("settings", {
    pageTitle: "Settings",
    activePath: "/settings",
    transactionTags: ["Household", "Reimbursable"],
    transactionCleanup: {
      query: "WHOLE FOODS MKT #1024",
      anchor: {
        id: "txn_anchor",
        display_name: "Whole Foods Market",
        raw_merchant: "WHOLE FOODS MKT #1024",
        raw_name: "WHOLE FOODS MKT #1024 BROOKLYN",
        category_primary: "Groceries",
        tags: ["Household"],
        posted_on: "2026-07-25",
        account_id: "acc_001",
        account_name: "Everyday checking",
        amount: { amount_minor: -13_842, currency: "USD" },
        similarity_basis_points: 10_000,
        match_reason: "source",
        preselected: true,
      },
      matches: [
        {
          id: "txn_fuzzy",
          display_name: "Whole Foods Mkt 117",
          raw_merchant: "WHOLEFDS MKT 117",
          raw_name: "WHOLEFDS MKT 117 BROOKLYN",
          category_primary: "Groceries",
          tags: [],
          posted_on: "2026-07-14",
          account_id: "acc_003",
          account_name: "Sapphire card",
          amount: { amount_minor: -6_249, currency: "USD" },
          similarity_basis_points: 7_642,
          match_reason: "similar_name",
          preselected: false,
        },
      ],
      available_tags: ["Household", "Reimbursable"],
    },
  });

  assert.equal(
    (html.match(/data-cleanup-match(?=\s)/g) ?? []).length,
    2,
  );
  assert.match(html, /Provider: WHOLE FOODS MKT #1024/);
  assert.match(html, /data-account-display-name="acc_001"/);
  assert.match(html, /76% match/);
  assert.match(
    html,
    /value="txn_anchor"[^>]*data-cleanup-select[^>]*checked/,
  );
  assert.match(
    html,
    /value="txn_fuzzy"[^>]*data-cleanup-select/,
  );
  assert.doesNotMatch(
    html,
    /value="txn_fuzzy"[^>]*checked/,
  );
  assert.match(html, /data-cleanup-change="display_name"/);
  assert.match(html, /data-cleanup-change="category_primary"/);
  assert.match(html, /data-cleanup-change="tags"/);
});

test("settings keeps exact automatic cleanup rules above one-time fuzzy edits", async () => {
  const html = await render("settings", {
    pageTitle: "Settings",
    activePath: "/settings",
    transactionRules: [
      {
        id: "cleanup_rule_apple",
        matcher: {
          field: "normalized_name",
          value: "AAPL SRV 0042",
          normalized_value: "aapl srv",
        },
        changes: {
          display_name: "Apple billing",
          category_primary: "Subscriptions",
          tags: ["Business"],
        },
        enabled: false,
        matched_transaction_count: 1,
        updated_at: "2026-07-27T10:00:00.000Z",
      },
    ],
  });

  assert.match(html, /data-cleanup-rules/);
  assert.match(
    html,
    /Transaction name exactly “AAPL SRV 0042”/,
  );
  assert.match(
    html,
    /Rename to Apple billing · Subscriptions · Business/,
  );
  assert.match(html, /1 matching posted transaction/);
  assert.match(html, /cleanup-rule-row--disabled/);
  assert.match(html, /data-cleanup-rule-new/);
  assert.match(html, /data-cleanup-rule-dialog/);
  assert.match(html, /data-cleanup-rule-edit/);
  assert.match(html, /data-cleanup-rule-delete/);
  assert.match(html, /data-cleanup-rule-toggle/);
  assert.match(html, /data-cleanup-save-rule hidden/);
  assert.match(
    html,
    /Automatic cleanup rules[\s\S]*One-time cleanup[\s\S]*data-cleanup-search/,
  );

  const matcherSelect = html.match(
    /<select[^>]*data-cleanup-rule-matcher-field[\s\S]*?<\/select>/,
  )?.[0];
  assert.ok(matcherSelect);
  assert.match(matcherSelect, /value="normalized_merchant"/);
  assert.match(matcherSelect, /value="normalized_name"/);
  assert.doesNotMatch(matcherSelect, /contains|regex|fuzzy/i);
});

test("demo transaction pages follow cleanup-rule create, disable, and delete", async () => {
  const financeService = createDemoFinanceService();
  const app = express();
  app.set("views", viewsRoot);
  app.set("view engine", "ejs");
  app.use(
    createWebRouter({
      demoMode: true,
      financeService,
    }),
  );

  const created = await financeService.createTransactionCleanupRule({
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
  const rule = created.rule;

  let rendered = await request(app)
    .get("/transactions?transaction=txn_apple_services")
    .expect(200);
  assert.match(
    rendered.text,
    /id="selected-transaction-heading">Apple billing</,
  );
  assert.match(rendered.text, /Shopping · Sapphire Preferred/);

  rendered = await request(app)
    .get("/settings?transaction=txn_apple_services")
    .expect(200);
  assert.match(
    rendered.text,
    /value="Apple billing"[\s\S]*?data-cleanup-display-name/,
  );
  assert.match(rendered.text, /Provider: Apple Services/);

  await financeService.updateTransactionCleanupRule({
    rule_id: rule.id,
    matcher: {
      field: rule.matcher.field,
      value: rule.matcher.value,
    },
    changes: rule.changes,
    enabled: false,
  });
  rendered = await request(app)
    .get("/transactions?transaction=txn_apple_services")
    .expect(200);
  assert.match(
    rendered.text,
    /id="selected-transaction-heading">Apple Services</,
  );
  assert.doesNotMatch(
    rendered.text,
    /id="selected-transaction-heading">Apple billing</,
  );

  await financeService.updateTransactionCleanupRule({
    rule_id: rule.id,
    matcher: {
      field: rule.matcher.field,
      value: rule.matcher.value,
    },
    changes: rule.changes,
    enabled: true,
  });
  rendered = await request(app)
    .get("/transactions?transaction=txn_apple_services")
    .expect(200);
  assert.match(
    rendered.text,
    /id="selected-transaction-heading">Apple billing</,
  );

  await financeService.deleteTransactionCleanupRule({
    rule_id: rule.id,
  });
  rendered = await request(app)
    .get("/transactions?transaction=txn_apple_services")
    .expect(200);
  assert.match(
    rendered.text,
    /id="selected-transaction-heading">Apple Services</,
  );
  assert.doesNotMatch(
    rendered.text,
    /id="selected-transaction-heading">Apple billing</,
  );
});

test("global search offers compact entity filters", async () => {
  const html = await render("dashboard");
  assert.match(html, /data-search-entity-type/);
  assert.match(html, /value="manual_asset">Assets</);
  assert.match(html, /value="transaction">Transactions</);
});

test("active insights lead with actions and keep lifecycle controls compact", async () => {
  const html = await render("insights", {
    pageTitle: "Insights",
    activePath: "/insights",
    insightView: "active",
  });
  assert.equal((html.match(/class="insight-summary card"/g) ?? []).length, 1);
  assert.match(html, /aria-label="Insight status"/);
  assert.match(html, /href="\/insights" aria-current="page"/);
  assert.match(html, /id="review-now"/);
  assert.match(html, /id="spend-less"/);
  assert.match(html, /id="change-a-habit"/);
  assert.match(html, /id="investment-risk"/);
  assert.match(html, />Review now</);
  assert.match(html, />Spend less</);
  assert.match(html, />Change a habit</);
  assert.match(html, />Investment risk</);
  assert.match(html, /<h3>Spend less on Dining<\/h3>[\s\S]*?Jul 19–25 vs Jul 12–18[\s\S]*?You spent \$126 more/);
  assert.match(html, /class="button button--secondary insight-card__solve"/);
  assert.match(html, /data-insight-action="archive"/);
  assert.match(html, /data-insight-action="mark_bad"/);
  assert.match(html, /data-insight-action="delete"/);
  assert.match(html, /<details class="insight-context">/);
  assert.match(html, /Portfolio gained 1\.8% this month/);
  assert.doesNotMatch(
    html,
    /class="insight-card__topline"|class="tag">Spend less/,
  );
});

test("insight archive exposes restore, bad, and confirmed delete actions", async () => {
  const html = await render("insights", {
    pageTitle: "Insights",
    activePath: "/insights",
    insights: demo.archivedInsights,
    insightView: "archive",
    insightData: { view: "archive" },
  });

  assert.match(html, /href="\/insights\?view=archive" aria-current="page"/);
  assert.match(html, /Past findings stay here, out of your way/);
  assert.match(html, /id="archive-heading"/);
  assert.match(html, /data-insight-action="restore"/);
  assert.match(html, /data-insight-action="mark_bad"/);
  assert.match(html, /data-insight-action="delete"/);
  assert.match(html, /Delete this insight permanently\?/);
  assert.match(html, />Archived</);
  assert.match(html, />Marked bad</);
  assert.doesNotMatch(html, /id="review-now"/);
});

test("recurring view includes functional monthly and annual values", async () => {
  const html = await render("recurring", {
    pageTitle: "Recurring",
    activePath: "/recurring",
  });
  assert.match(html, /data-period="monthly"/);
  assert.match(html, /data-period="annual"/);
  assert.match(html, /data-monthly="\$85\.64"/);
  assert.match(html, /data-annual="\$1,027\.68"/);
});

test("shared header keeps Accounts in the user menu, not primary navigation", async () => {
  const html = await render("accounts", {
    pageTitle: "Accounts",
    activePath: "/accounts",
    viewer: {
      name: "Authenticated Person",
      email: "person@example.com",
      initials: "AP",
      is_admin: true,
    },
  });
  assert.match(html, /<form class="account-menu__logout" action="\/auth\/logout" method="post">/);
  assert.match(html, /name="_csrf" value="csrf-test-value"/);
  assert.match(html, /Authenticated Person/);
  assert.match(html, /summary aria-label="Open user menu"/);
  assert.match(
    html,
    /href="\/accounts" aria-current="page"[\s\S]*?ph-bank[\s\S]*?Accounts/,
  );
  const primaryNavigation =
    html.match(
      /<nav class="desktop-nav" aria-label="Primary navigation">([\s\S]*?)<\/nav>/,
    )?.[1] ?? "";
  const mobileNavigation =
    html.match(
      /<nav class="mobile-nav" aria-label="Mobile navigation"[\s\S]*?>([\s\S]*?)<\/nav>/,
    )?.[1] ?? "";
  assert.doesNotMatch(primaryNavigation, />Accounts</);
  assert.doesNotMatch(mobileNavigation, />Accounts/);
  assert.doesNotMatch(html, /Francis/);
});

test("auth, empty, and error states render without application data dependencies", async () => {
  const login = await render("auth/login", { pageTitle: "Sign in", error: "not-allowed" });
  const empty = await render("states/empty", { pageTitle: "Connect your finances" });
  const error = await render("states/error", { pageTitle: "Something needs attention", requestId: "req_test", statusCode: 503 });
  const notFound = await render("states/error", { pageTitle: "Page not found", requestId: "req_404", statusCode: 404, message: "That page does not exist." });

  assert.match(login, /Continue with Duo/);
  assert.match(login, /Sign-in failed/);
  assert.match(empty, /Connect finances/);
  assert.doesNotMatch(empty, /\$3,000|Example category|data-chart="spending"/);
  assert.match(error, /Request ID: req_test/);
  assert.match(notFound, /That page isn’t here/);
  assert.match(notFound, /Back to dashboard/);
});

test("demo finance arithmetic stays internally consistent", () => {
  const categoryTotal = demo.categories.reduce((sum, category) => sum + category.amount.amount_minor, 0);
  const previousCategoryTotal = demo.categories.reduce(
    (sum, category) => sum + category.previousAmount.amount_minor,
    0,
  );
  const subscriptionTotal = demo.subscriptions.reduce((sum, subscription) => sum + subscription.amount.amount_minor, 0);
  const portfolioAccountTotal = demo.accounts
    .filter((account) => account.type === "Investment")
    .reduce((sum, account) => sum + account.balance.amount_minor, 0);
  const holdingTotal = demo.holdings.reduce((sum, holding) => sum + holding.value.amount_minor, 0);
  assert.equal(categoryTotal, demo.overview.spending.amount_minor);
  assert.equal(
    previousCategoryTotal,
    demo.spendingDetails.previousTotal.amount_minor,
  );
  assert.equal(
    demo.spendingDetails.seriesValues.reduce(
      (sum, value) => sum + value,
      0,
    ),
    demo.spendingDetails.total.amount_minor,
  );
  assert.equal(
    demo.spendingDetails.categories.reduce(
      (sum, category) => sum + category.count,
      0,
    ),
    demo.spendingDetails.transactionCount,
  );
  assert.equal(subscriptionTotal, demo.overview.subscriptions.amount_minor);
  assert.equal(portfolioAccountTotal, demo.overview.portfolio.amount_minor);
  assert.equal(holdingTotal, demo.overview.portfolio.amount_minor);
  const cashBalance = demo.accounts
    .filter((account) =>
      ["cash", "taxable_investment"].includes(account.balanceGroup),
    )
    .reduce((sum, account) => sum + account.balance.amount_minor, 0);
  const shortTermWorth =
    cashBalance +
    demo.accounts
      .filter((account) => account.balanceGroup === "credit_card")
      .reduce((sum, account) => sum + account.balance.amount_minor, 0);
  const netWorth =
    demo.accounts
      .filter((account) => account.balanceGroup !== "excluded")
      .reduce((sum, account) => sum + account.balance.amount_minor, 0) +
    demo.manualAssets.reduce(
      (sum, asset) => sum + asset.value.amount_minor,
      0,
    );
  assert.equal(cashBalance, demo.overview.cashBalance.amount_minor);
  assert.equal(
    shortTermWorth,
    demo.overview.shortTermWorth.amount_minor,
  );
  assert.equal(netWorth, demo.overview.netWorth.amount_minor);
  assert.equal(formatMoney({ amount_minor: 8564, currency: "USD" }), "$85.64");
  assert.equal(formatMoney({ amount_minor: 219100, currency: "USD" }, { sign: true }), "+$2,191.00");
});
