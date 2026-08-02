import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import ejs from "ejs";

import { buildDemoModel } from "../app/demo/webFixtures.js";
import { formatMoney } from "../app/routes/web.js";

const viewsRoot = path.resolve("app/views");
const demo = buildDemoModel();
const recovery = {
  id: "recovery-1",
  state: "open",
  recovered_at: "2026-08-01T18:00:00.000Z",
  source: {
    name: "Wells Fargo Auto",
    account: "Bee & Bee Checking",
    date: "2026-07-16",
    amount: { amount_minor: -100_000, currency: "USD" },
  },
  edited_fields: ["Name", "Cash-flow role", "Note"],
};

async function renderTransactions(viewer) {
  return ejs.renderFile(
    path.join(viewsRoot, "transactions.ejs"),
    {
      ...demo,
      viewer,
      pendingEditRecoveries: [recovery],
      formatMoney,
      activePath: "/transactions",
      currentPath: "/transactions",
      pageTitle: "Transactions",
      query: {},
      csrfToken: "csrf-test-value",
    },
  );
}

test("transactions page lets an admin explicitly attach or dismiss retained pending edits", async () => {
  const html = await renderTransactions({
    id: "admin-1",
    name: "Admin",
    is_admin: true,
  });

  assert.match(html, /Pending edits need a transaction/);
  assert.match(html, /Wells Fargo Auto/);
  assert.match(html, /Saved: Name, Cash-flow role, Note/);
  assert.match(html, /data-pending-edit-recovery="recovery-1"/);
  assert.match(html, /data-pending-edit-recovery-target/);
  assert.match(
    html,
    /\/api\/v1\/pending-edit-recoveries\/recovery-1\/attach/,
  );
  assert.match(
    html,
    /\/api\/v1\/pending-edit-recoveries\/recovery-1\/dismiss/,
  );
  assert.match(html, /Choose posted transaction/);
  assert.match(html, /choose the posted transaction yourself/i);
});

test("pending edit recovery actions stay hidden from non-admin viewers", async () => {
  const html = await renderTransactions({
    id: "member-1",
    name: "Member",
    is_admin: false,
  });

  assert.doesNotMatch(html, /data-pending-edit-recoveries/);
  assert.doesNotMatch(html, /Pending edits need a transaction/);
});

test("pending edit recovery browser code sends CSRF-protected explicit actions", async () => {
  const [javascript, css] = await Promise.all([
    readFile(path.resolve("app/public/js/money.js"), "utf8"),
    readFile(path.resolve("app/public/css/money.css"), "utf8"),
  ]);
  const start = javascript.indexOf("function pendingEditRecoveries()");
  const end = javascript.indexOf("function transactionBulkEdit()", start);
  const recoveryCode = javascript.slice(start, end);

  assert.ok(start >= 0);
  assert.ok(end > start);
  assert.match(recoveryCode, /transaction_id: transactionId/);
  assert.match(recoveryCode, /"X-CSRF-Token": csrfToken/);
  assert.match(recoveryCode, /This cannot be undone/);
  assert.match(recoveryCode, /window\.location\.reload\(\)/);
  assert.match(css, /\.pending-edit-recoveries/);
  assert.match(css, /\.pending-edit-recovery__attach/);
});
