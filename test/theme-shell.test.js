import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import ejs from "ejs";

const viewsRoot = path.resolve("app/views");

async function renderPartial(name, locals = {}) {
  return ejs.renderFile(
    path.join(viewsRoot, "partials", `${name}.ejs`),
    {
      pageTitle: "Theme test",
      activePath: "/",
      csrfToken: "csrf-theme-test",
      viewer: {
        id: "member-1",
        name: "Member",
        email: "member@example.com",
        initials: "MM",
        is_admin: false,
      },
      ...locals,
    },
  );
}

test("head validates server appearance and paints it before themed assets", async () => {
  const system = await renderPartial("head", {
    appearancePreference: "system",
  });
  assert.match(system, /<html lang="en" data-appearance="system">/);
  assert.match(system, /name="color-scheme" content="light dark"/);
  assert.match(
    system,
    /name="theme-color" content="#f7f7f7" media="\(prefers-color-scheme: light\)"/,
  );
  assert.match(
    system,
    /name="theme-color" content="#111111" media="\(prefers-color-scheme: dark\)"/,
  );
  assert.ok(
    system.indexOf('/js/theme.js?v=1') <
      system.indexOf('/vendor/chart/chart.umd.js'),
  );
  assert.match(system, /\/css\/money\.css\?v=37/);
  assert.match(system, /\/js\/charts\.js\?v=7/);
  assert.match(system, /\/js\/money\.js\?v=34/);
  const transactions = await renderPartial("head", {
    appearancePreference: "system",
    pageTitle: "Transactions",
  });
  assert.match(transactions, /\/js\/transactions\.js\?v=4/);

  const dark = await renderPartial("head", {
    appearancePreference: "dark",
  });
  assert.match(dark, /<html lang="en" data-appearance="dark">/);
  assert.match(dark, /name="color-scheme" content="dark"/);
  assert.match(dark, /name="theme-color" content="#111111">/);
  assert.doesNotMatch(dark, /theme-color[^>]+prefers-color-scheme/);

  const invalid = await renderPartial("head", {
    appearancePreference: "sepia",
  });
  assert.match(invalid, /<html lang="en" data-appearance="system">/);
});

test("user menu exposes the appearance radio group to every member", async () => {
  const html = await renderPartial("site-header", {
    appearancePreference: "dark",
  });

  assert.match(html, /<fieldset class="account-menu__appearance" data-appearance-picker>/);
  assert.match(html, /role="radiogroup" aria-label="Appearance"/);
  assert.match(
    html,
    /value="dark"[\s\S]*data-appearance-option[\s\S]*checked/,
  );
  assert.equal((html.match(/data-appearance-option/g) || []).length, 3);
  assert.match(
    html,
    /role="status" aria-live="polite" data-appearance-status/,
  );
  assert.doesNotMatch(html, /href="\/settings"/);
});

test("signed-out navigation does not expose an account appearance picker", async () => {
  const html = await renderPartial("site-header", {
    appearancePreference: "dark",
    viewer: null,
  });

  assert.doesNotMatch(html, /data-appearance-picker/);
  assert.doesNotMatch(html, /data-appearance-option/);
});

test("theme tokens preserve light values and define the charcoal dark palette", async () => {
  const css = await readFile(path.resolve("app/public/css/money.css"), "utf8");

  assert.match(css, /--canvas:\s*light-dark\(#f7f7f7, #111111\)/);
  assert.match(css, /--surface:\s*light-dark\(#ffffff, #191919\)/);
  assert.match(css, /--surface-muted:\s*light-dark\(#f1f1f1, #232323\)/);
  assert.match(css, /--ink:\s*light-dark\(#171717, #f4f4f4\)/);
  assert.match(css, /--ink-soft:\s*light-dark\(#626262, #b8b8b8\)/);
  assert.match(css, /--line:\s*light-dark\(#e3e3e3, #303030\)/);
  for (const token of [
    "chart-axis",
    "chart-grid",
    "chart-tooltip-bg",
    "chart-tooltip-text",
    "chart-separator",
  ]) {
    assert.match(css, new RegExp(`--${token}:`));
  }
  assert.match(
    css,
    /@media print\s*\{[\s\S]*?color-scheme:\s*light !important/,
  );
});
