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
  assert.match(head, /\/css\/money\.css\?v=25/);
  assert.match(head, /\/js\/charts\.js\?v=5/);
  assert.match(head, /\/js\/money\.js\?v=21/);
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
      money.indexOf("function localDateTimes()"),
      money.indexOf("function accountAliases()"),
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

test("entity detail dialogs open natively and clear their selection URL on close", async () => {
  const money = await readFile(
    path.resolve("app/public/js/money.js"),
    "utf8",
  );

  assert.match(money, /function detailDialogs\(\)/);
  assert.match(money, /dialog\.showModal\(\)/);
  assert.match(money, /url\.searchParams\.delete\(queryKey\)/);
  assert.match(money, /selectedLink\?\.focus\(\)/);
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
  assert.match(bulkEdit, /excluded_from_spending/);
  assert.doesNotMatch(bulkEdit, /is_fixed/);
  assert.match(bulkEdit, /\/api\/v1\/transactions\/batch-edit/);
  assert.match(bulkEdit, /transaction_ids: transactionIds/);
  assert.match(bulkEdit, /window\.location\.reload\(\)/);
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
