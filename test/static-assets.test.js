import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile } from "node:fs/promises";

import { stableAssetCacheOptions } from "../app/app.js";

test("stable asset paths are revalidated instead of marked immutable", () => {
  assert.deepEqual(stableAssetCacheOptions({ production: true }), {
    immutable: false,
    maxAge: "1h",
  });
  assert.deepEqual(stableAssetCacheOptions({ production: false }), {
    immutable: false,
    maxAge: 0,
  });
});

test("first-party asset revisions change with the current deployment", async () => {
  const head = await readFile(
    path.resolve("app/views/partials/head.ejs"),
    "utf8",
  );
  assert.match(head, /\/css\/money\.css\?v=38/);
  assert.match(head, /\/js\/theme\.js\?v=1/);
  assert.match(head, /\/js\/charts\.js\?v=7/);
  assert.match(head, /\/js\/money\.js\?v=34/);
  assert.match(head, /\/js\/transactions\.js\?v=4/);
});

test("Format Rules keeps amount and cleanup controls compact", async () => {
  const styles = await readFile(
    path.resolve("app/public/css/money.css"),
    "utf8",
  );

  assert.match(
    styles,
    /\.cleanup-rule-form__amount\s*\{[\s\S]*?grid-template-columns:\s*auto minmax\(120px, 0\.55fr\) minmax\(150px, 0\.7fr\);/,
  );
  assert.match(
    styles,
    /\.cleanup-rule-form__amount-toggle input\[type="checkbox"\]\s*\{[\s\S]*?width:\s*17px;[\s\S]*?min-height:\s*0;/,
  );
  assert.match(
    styles,
    /\.cleanup-rule-form fieldset > \.cleanup-edit-field\s*\{[\s\S]*?grid-template-columns:\s*minmax\(130px, 0\.34fr\) minmax\(0, 1fr\);/,
  );
});

test("Calibre is limited to display typography", async () => {
  const [head, styles] = await Promise.all([
    readFile(path.resolve("app/views/partials/head.ejs"), "utf8"),
    readFile(path.resolve("app/public/css/money.css"), "utf8"),
  ]);

  assert.match(
    head,
    /<link rel="stylesheet" href="https:\/\/fonts\.yaboiii\.com\/wss\/fonts\?v=3" type="text\/css" as="style">/,
  );
  assert.doesNotMatch(styles, /CalibreWeb-R-(?:Regular|Medium|Semibold)\.woff/);
  assert.match(styles, /--font-display:\s*"Calibre", var\(--font-system\);/);
  assert.match(
    styles,
    /h1,\s*h2,\s*\.display-money\s*\{[^}]*font-family:\s*var\(--font-display\);[^}]*font-weight:\s*700;/,
  );
  assert.match(
    styles,
    /h3,\s*h4\s*\{[^}]*font-family:\s*var\(--font-display\);[^}]*font-weight:\s*600;/,
  );
  assert.match(
    styles,
    /\.eyebrow,\s*\.card-kicker\s*\{[^}]*font-family:\s*var\(--font-display\);[^}]*font-weight:\s*400;/,
  );
  assert.match(
    styles,
    /\.brand\s*\{[^}]*font-family:\s*var\(--font-display\);[^}]*font-weight:\s*600;/,
  );
  assert.match(styles, /body\s*\{[^}]*font-family:\s*var\(--font-system\);/);
});

test("transaction explorer uses real category and merchant links while Other stays aggregate-only", async () => {
  const [view, script, styles] = await Promise.all([
    readFile(path.resolve("app/views/transactions.ejs"), "utf8"),
    readFile(path.resolve("app/public/js/transactions.js"), "utf8"),
    readFile(path.resolve("app/public/css/money.css"), "utf8"),
  ]);

  for (const source of [view, script]) {
    assert.doesNotMatch(source, /Show matching transactions/);
    assert.doesNotMatch(source, /Remaining groups combined/);
  }
  assert.match(view, /filter the chart and transactions/);
  assert.match(script, /groupKey === "merchant" \? "merchant" : "category"/);
  assert.match(script, /"Other groups combined"/);
  assert.doesNotMatch(view, /query\.analytics_segment/);
  assert.match(
    styles,
    /\.spending-detail-category__select\s*\{[\s\S]*?min-height:\s*56px;/,
  );
});

test("dismissible notifications persist for the browser session", async () => {
  const [money, notification] = await Promise.all([
    readFile(path.resolve("app/public/js/money.js"), "utf8"),
    readFile(
      path.resolve("app/views/partials/notification.ejs"),
      "utf8",
    ),
  ]);

  assert.match(notification, /data-dismissible-notification/);
  assert.match(notification, /data-notification-dismiss/);
  assert.match(money, /function dismissibleNotifications\(\)/);
  assert.match(money, /money\.dismissed-notifications\.v1/);
  assert.match(money, /window\.sessionStorage\.setItem/);
  assert.match(money, /notification\.hidden = true/);
});

test("Settings insight controls call the protected toggle, run, and clear endpoints", async () => {
  const money = await readFile(
    path.resolve("app/public/js/money.js"),
    "utf8",
  );
  const start = money.indexOf("const insightAdminStatus");
  const end = money.indexOf("const saveRule", start);
  const controls = money.slice(start, end);

  assert.ok(start >= 0);
  assert.ok(end > start);
  assert.match(controls, /data-insights-toggle/);
  assert.match(controls, /\/api\/v1\/settings\/insights\/status/);
  assert.match(controls, /method: "PUT"/);
  assert.match(controls, /data-insights-run/);
  assert.match(controls, /\/api\/v1\/settings\/insights\/run/);
  assert.match(controls, /data-insights-clear/);
  assert.match(controls, /method: "DELETE"/);
  assert.match(controls, /window\.confirm\(warning\)/);
});

test("manual asset entry accepts formatted money and refreshes saved production data", async () => {
  const [settings, money] = await Promise.all([
    readFile(path.resolve("app/views/settings.ejs"), "utf8"),
    readFile(path.resolve("app/public/js/money.js"), "utf8"),
  ]);

  assert.match(
    settings,
    /name="value" type="text" inputmode="decimal"/,
  );
  assert.doesNotMatch(
    settings,
    /name="value" type="number"/,
  );
  assert.match(money, /\.replaceAll\(",", ""\)/);
  assert.match(
    money,
    /\/settings\?asset=\$\{encodedAssetId\}#asset-\$\{encodedAssetId\}/,
  );
  assert.match(money, /if \(!result\.demo\) window\.location\.reload\(\)/);
});

test("account aliases stay in local storage and never call the backend", async () => {
  const money = await readFile(
    path.resolve("app/public/js/money.js"),
    "utf8",
  );
  const start = money.indexOf("const accountAliasStorageKey");
  const end = money.indexOf("function globalSearch()", start);
  const accountAliasCode = money.slice(start, end);

  assert.ok(start >= 0);
  assert.ok(end > start);
  assert.match(accountAliasCode, /money\.account-aliases\.v1/);
  assert.match(accountAliasCode, /window\.localStorage\.setItem/);
  assert.doesNotMatch(accountAliasCode, /\bfetch\s*\(/);
});

test("account sync times are formatted in the browser timezone", async () => {
  const [accounts, money] = await Promise.all([
    readFile(path.resolve("app/views/accounts.ejs"), "utf8"),
    readFile(path.resolve("app/public/js/money.js"), "utf8"),
  ]);

  assert.match(accounts, /data-local-date-time="<%= institutionAccount\.syncedAt %>"/);
  assert.match(money, /new Intl\.DateTimeFormat\(undefined,/);
  assert.match(money, /new Date\(element\.dataset\.localDateTime\)/);
  assert.doesNotMatch(
    money.slice(
      money.indexOf("function localDateTimes("),
      money.indexOf("function accountAliases("),
    ),
    /timeZone:/,
  );
});

test("page centering reserves a stable scrollbar gutter", async () => {
  const money = await readFile(
    path.resolve("app/public/css/money.css"),
    "utf8",
  );

  assert.match(
    money,
    /html\s*\{[^}]*scrollbar-gutter:\s*stable;/,
  );
});

test("transaction detail links enhance native deep links with modal history", async () => {
  const [money, transactions, transactionRow, transactionsView] =
    await Promise.all([
      readFile(path.resolve("app/public/js/money.js"), "utf8"),
      readFile(path.resolve("app/public/js/transactions.js"), "utf8"),
      readFile(
        path.resolve("app/views/partials/transaction-row.ejs"),
        "utf8",
      ),
      readFile(path.resolve("app/views/transactions.ejs"), "utf8"),
    ]);
  const scripts = `${money}\n${transactions}`;

  assert.match(
    transactionRow,
    /href="\/transactions\?<%= transactionDetailQuery\.toString\(\) %>"[\s\S]*data-detail-dialog-link/,
  );
  assert.match(
    transactionsView,
    /<dialog[\s\S]*data-detail-dialog[\s\S]*data-detail-auto-open[\s\S]*data-detail-query-key="transaction"/,
  );
  assert.match(scripts, /dialog\.showModal\(\)/);
  assert.match(scripts, /\bfetch\s*\(/);
  assert.match(scripts, /history\.pushState\(/);
  assert.match(scripts, /addEventListener\(["']popstate["']/);
  assert.match(scripts, /history\.(?:back|replaceState)\(/);
  assert.match(scripts, /\.focus\(\)/);
});

test("transaction bulk editing sends only selected override fields", async () => {
  const money = await readFile(
    path.resolve("app/public/js/money.js"),
    "utf8",
  );
  const start = money.indexOf("function transactionBulkEdit()");
  const end = money.indexOf("function insightActions()", start);
  const bulkEdit = money.slice(start, end);

  assert.ok(start >= 0);
  assert.ok(end > start);
  assert.match(bulkEdit, /data-bulk-transaction-select/);
  assert.match(bulkEdit, /data-bulk-change/);
  assert.match(bulkEdit, /cash_flow_role/);
  assert.doesNotMatch(bulkEdit, /is_fixed/);
  assert.match(bulkEdit, /\/api\/v1\/transactions\/batch-edit/);
  assert.match(bulkEdit, /transaction_ids: transactionIds/);
  assert.match(bulkEdit, /window\.location\.reload\(\)/);
});

test("transaction detail organization sends one scoped batch edit", async () => {
  const money = await readFile(
    path.resolve("app/public/js/money.js"),
    "utf8",
  );
  const start = money.indexOf("function transactionOrganization(");
  const end = money.indexOf("function insightActions()", start);
  const organization = money.slice(start, end);

  assert.ok(start >= 0);
  assert.ok(end > start);
  assert.match(organization, /data-transaction-organize-form/);
  assert.match(organization, /data-transaction-category-form/);
  assert.match(organization, /data-transaction-category-status/);
  assert.match(
    organization,
    /transaction_ids: \[transactionId\]/,
  );
  assert.match(organization, /changes\.category_primary = category\.value/);
  assert.match(organization, /\/api\/v1\/transactions\/batch-edit/);
});

test("insight bulk selection sends one guarded batch action", async () => {
  const money = await readFile(
    path.resolve("app/public/js/money.js"),
    "utf8",
  );
  const start = money.indexOf("function insightBulkActions()");
  const end = money.indexOf("function insightActions()", start);
  const bulkActions = money.slice(start, end);

  assert.ok(start >= 0);
  assert.ok(end > start);
  assert.match(bulkActions, /data-bulk-insights/);
  assert.match(bulkActions, /data-insight-selection-mode/);
  assert.match(bulkActions, /data-insight-select-all/);
  assert.match(bulkActions, /selectAll\.indeterminate/);
  assert.match(bulkActions, /context\.open = true/);
  assert.match(bulkActions, /finding_ids: findingIds/);
  assert.match(bulkActions, /reason_code: reason\?\.value/);
  assert.match(bulkActions, /\/api\/v1\/insights\/batch-action/);
  assert.match(bulkActions, /"X-CSRF-Token": csrfToken/);
  assert.doesNotMatch(bulkActions, /action === "delete"/);
});

test("transaction notes save with an optimistic version", async () => {
  const money = await readFile(
    path.resolve("app/public/js/money.js"),
    "utf8",
  );
  const start = money.indexOf("function transactionNotes(");
  const end = money.indexOf("function transactionOrganization(", start);
  const notes = money.slice(start, end);

  assert.ok(start >= 0);
  assert.ok(end > start);
  assert.match(notes, /data-transaction-note-form/);
  assert.match(notes, /expected_note_version: expectedVersion/);
  assert.match(notes, /\/note`/);
  assert.match(notes, /transaction-disclosure__preview/);
  assert.match(notes, /"No note"/);
});

test("transaction selection controls stay hidden outside edit mode", async () => {
  const money = await readFile(
    path.resolve("app/public/css/money.css"),
    "utf8",
  );

  assert.match(
    money,
    /\.transaction-select-control\[hidden\]\s*\{\s*display:\s*none;/,
  );
});

test("future equity keeps the standard card spacing", async () => {
  const money = await readFile(
    path.resolve("app/public/css/money.css"),
    "utf8",
  );

  assert.match(
    money,
    /\.future-equity-card\s*\{[^}]*margin-top:\s*18px;/,
  );
});

test("Nomad runs one task and startup orders migrations before worker and HTTP", async () => {
  const [job, startup, publishWorkflow] = await Promise.all([
    readFile(path.resolve("docs/nomad/money.nomad.hcl"), "utf8"),
    readFile(path.resolve("app/index.js"), "utf8"),
    readFile(path.resolve(".github/workflows/publish.yml"), "utf8"),
  ]);
  const tasks = [...job.matchAll(/^\s+task "([^"]+)"/gm)].map(
    (match) => match[1],
  );

  assert.deepEqual(tasks, ["money"]);
  assert.match(
    job,
    /image\s*=\s*"ghcr\.io\/francisschmaltz\/money:latest"/,
  );
  assert.match(job, /username\s*=\s*"francisschmaltz"/);
  assert.match(
    job,
    /password\s*=\s*"\$\{secret\.registry_auth\.ghcr_token\}"/,
  );
  assert.doesNotMatch(job, /variable "image"|var\.image|GHETOKEN/);
  assert.match(publishWorkflow, /type=raw,value=latest/);
  assert.match(publishWorkflow, /type=sha,format=long,prefix=sha-/);
  const migrationIndex = startup.indexOf("await migrate(runtime.pool)");
  const workerIndex = startup.indexOf("await startFinanceWorker");
  const listenIndex = startup.indexOf("server.listen");
  assert.ok(migrationIndex >= 0);
  assert.ok(migrationIndex < workerIndex);
  assert.ok(workerIndex < listenIndex);
});
