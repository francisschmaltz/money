import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import express from "express";
import request from "supertest";

import { createWebRouter } from "../app/routes/web.js";
import { createDemoFinanceService } from "../app/services/demoFinanceService.js";

const viewsRoot = fileURLToPath(new URL("../app/views/", import.meta.url));
const entityTypes = [
  "transaction",
  "account",
  "recurring",
  "manual_asset",
  "insight",
];

function webApp(options = {}) {
  const app = express();
  app.set("views", viewsRoot);
  app.set("view engine", "ejs");
  app.use(createWebRouter(options));
  return app;
}

function searchPayload(query = "Apple") {
  return {
    query,
    groups: [
      {
        label: "Transactions",
        items: [
          {
            title: "Apple Services",
            meta: "Subscriptions · Sapphire card",
            url: "/transactions?transaction=txn_apple_services",
            icon: "ph-device-mobile",
          },
          {
            title: "Apple Store",
            meta: "Shopping · Everyday checking",
            url: "/transactions?transaction=txn_apple_store",
            icon: "ph-receipt",
          },
        ],
      },
      {
        label: "Insights",
        items: [
          {
            title: "Check whether you need both Apple subscriptions",
            meta: "Recurring",
            url: "/insights?finding=insight_apple_overlap",
            icon: "ph-sparkle",
          },
        ],
      },
    ],
  };
}

function duplicateIds(html) {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
}

function tagWithAttribute(html, tag, attribute) {
  return html.match(new RegExp(`<${tag}[^>]*${attribute}[^>]*>`))?.[0] ?? "";
}

test("search page is authenticated", async () => {
  const guardedPaths = [];
  const app = webApp({
    demoMode: true,
    requireAuth(request, response) {
      guardedPaths.push(request.path);
      response.status(401).send("sign in");
    },
  });

  await request(app).get("/search").expect(401, "sign in");
  assert.deepEqual(guardedPaths, ["/search"]);
});

test("empty and one-character search pages render without executing search", async () => {
  const calls = [];
  const app = webApp({
    financeService: {
      search(...args) {
        calls.push(args);
        throw new Error("short queries must not execute");
      },
    },
  });

  const initial = await request(app).get("/search").expect(200);
  const short = await request(app).get("/search?q=a").expect(200);

  assert.equal(calls.length, 0);
  assert.equal((initial.text.match(/<h1\b/g) ?? []).length, 1);
  assert.match(initial.text, /<h1[^>]*>Search<\/h1>/);
  assert.match(initial.text, /<form[^>]*action="\/search"[^>]*method="get"[^>]*data-search-page-form/);
  assert.match(initial.text, /data-search-page-input/);
  assert.match(initial.text, /data-search-page-entity-type/);
  assert.match(initial.text, /data-search-example/);
  assert.match(tagWithAttribute(short.text, "input", "data-search-page-input"), /value="a"/);
  assert.match(short.text, /Type at least two characters/i);
});

test("search page canonicalizes malformed URLs exactly once", async () => {
  const app = webApp({
    financeService: {
      search(query) {
        return { query, groups: [] };
      },
    },
  });

  const redirected = await request(app).get(
    "/search?noise=drop-me&q=%20Apple%20&entity_type=bogus",
  );
  assert.ok(
    [301, 302, 307, 308].includes(redirected.status),
    `expected a redirect, received ${redirected.status}`,
  );
  assert.equal(redirected.headers.location, "/search?q=Apple");

  const canonical = await request(app)
    .get(redirected.headers.location)
    .expect(200);
  assert.equal(canonical.headers.location, undefined);

  const repeated = await request(app).get(
    "/search?q=Apple&entity_type=transaction&entity_type=account",
  );
  assert.ok([301, 302, 307, 308].includes(repeated.status));
  assert.equal(
    new URL(repeated.headers.location, "https://money.test").searchParams.getAll(
      "entity_type",
    ).length,
    1,
  );

  const overlong = "x".repeat(121);
  const capped = await request(app).get(
    `/search?q=${encodeURIComponent(overlong)}`,
  );
  assert.ok([301, 302, 307, 308].includes(capped.status));
  assert.equal(
    new URL(capped.headers.location, "https://money.test").searchParams.get("q"),
    "x".repeat(120),
  );
});

test("deep-linked search renders results and selected controls on the server", async () => {
  const calls = [];
  const app = webApp({
    financeService: {
      search(query, options) {
        calls.push({ query, options });
        return searchPayload(query);
      },
    },
  });

  const response = await request(app)
    .get("/search?q=Apple&entity_type=transaction")
    .expect(200);

  assert.deepEqual(calls, [
    {
      query: "Apple",
      options: {
        entityTypes: ["transaction"],
        limit: 50,
      },
    },
  ]);
  assert.match(response.text, /data-search-page/);
  assert.match(
    tagWithAttribute(response.text, "input", "data-search-page-input"),
    /value="Apple"/,
  );
  assert.match(
    response.text,
    /<option value="transaction"[^>]*selected[^>]*>Transactions<\/option>/,
  );
  assert.match(
    tagWithAttribute(response.text, "div", "data-search-page-results"),
    /aria-busy="false"/,
  );
  assert.match(
    tagWithAttribute(response.text, "p", "data-search-page-status"),
    /aria-live="polite"/,
  );
  assert.match(response.text, /<h2[^>]*>Transactions<\/h2>/);
  assert.match(
    response.text,
    /href="\/transactions\?transaction=txn_apple_services"[^>]*data-search-page-result/,
  );
  assert.match(response.text, /3 results/i);
  assert.doesNotMatch(response.text, /data-search-dialog/);
  assert.doesNotMatch(response.text, /aria-selected=/);
  assert.deepEqual(duplicateIds(response.text), []);
});

test("API search clamps limits and reports displayed counts", async () => {
  const calls = [];
  const app = webApp({
    financeService: {
      search(query, options) {
        calls.push({ query, options });
        return searchPayload(query);
      },
    },
  });

  const defaultLimit = await request(app)
    .get("/api/search?q=Apple")
    .expect(200);
  await request(app).get("/api/search?q=Apple&limit=7").expect(200);
  await request(app).get("/api/search?q=Apple&limit=0").expect(200);
  const maximum = await request(app)
    .get("/api/search?q=Apple&limit=999")
    .expect(200);

  assert.deepEqual(
    calls.map((call) => call.options.limit),
    [30, 7, 1, 50],
  );
  assert.equal(defaultLimit.body.returned_count, 3);
  assert.equal(defaultLimit.body.group_count, 2);
  assert.deepEqual(
    defaultLimit.body.groups.map((group) => group.returned_count),
    [2, 1],
  );
  assert.equal(maximum.body.returned_count, 3);
  assert.equal(maximum.body.group_count, 2);
});

test("API search preserves short queries without calling the service", async () => {
  let called = false;
  const app = webApp({
    financeService: {
      search() {
        called = true;
      },
    },
  });

  const response = await request(app).get("/api/search?q=%20a%20").expect(200);
  assert.equal(called, false);
  assert.equal(response.body.query, "a");
  assert.equal(response.body.returned_count, 0);
  assert.equal(response.body.group_count, 0);
  assert.deepEqual(response.body.groups, []);
});

test("API search supports every entity filter", async () => {
  const calls = [];
  const app = webApp({
    financeService: {
      search(query, options) {
        calls.push({ query, options });
        return { query, groups: [] };
      },
    },
  });

  for (const entityType of entityTypes) {
    const response = await request(app)
      .get(`/api/search?q=needle&entity_type=${entityType}`)
      .expect(200);
    assert.deepEqual(response.body.entity_types, [entityType]);
  }

  assert.deepEqual(
    calls.map((call) => call.options.entityTypes),
    entityTypes.map((entityType) => [entityType]),
  );
});

test("demo fallback and demo service both return insight search results", async () => {
  const fallback = await request(webApp({ demoMode: true }))
    .get("/api/search?q=Dining&entity_type=insight")
    .expect(200);
  const service = await request(
    webApp({
      demoMode: true,
      financeService: createDemoFinanceService(),
    }),
  )
    .get("/api/search?q=Dining&entity_type=insight")
    .expect(200);

  assert.ok(fallback.body.returned_count > 0);
  assert.ok(service.body.returned_count > 0);
  assert.deepEqual(
    service.body.groups.map((group) => group.label),
    ["Insights"],
  );
  assert.deepEqual(
    fallback.body.groups.map((group) => group.label),
    ["Insights"],
  );
  assert.ok(service.body.returned_count <= 50);
  assert.ok(fallback.body.returned_count <= 50);
});

test("server-rendered search escapes hostile values and rejects off-origin paths", async () => {
  const app = webApp({
    financeService: {
      search(query) {
        return {
          query,
          groups: [
            {
              label: "<img src=x onerror=alert(1)>",
              items: [
                {
                  title: "<script>alert('title')</script>",
                  meta: "\"><img src=x onerror=alert('meta')>",
                  url: "//evil.example/steal",
                  icon: "ph-receipt",
                },
                {
                  title: "Safe result",
                  meta: "Safe metadata",
                  url: "/transactions?transaction=txn_1&note=%22bad%22",
                  icon: "ph-receipt",
                },
              ],
            },
          ],
        };
      },
    },
  });

  const response = await request(app).get("/search?q=hostile").expect(200);
  assert.doesNotMatch(response.text, /<script>alert\('title'\)<\/script>/);
  assert.doesNotMatch(response.text, /<img src=x onerror=/);
  assert.doesNotMatch(response.text, /href="\/\/evil\.example/);
  assert.doesNotMatch(response.text, /href="https?:\/\/evil\.example/);
  assert.match(response.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(response.text, /&lt;script&gt;alert/);
  assert.match(
    response.text,
    /href="\/transactions\?transaction=txn_1&amp;note=%22bad%22"/,
  );
});

test("shared navigation points to full search while non-search pages keep the modal", async () => {
  const app = webApp({ demoMode: true });
  const dashboard = await request(app).get("/").expect(200);
  const transactions = await request(app).get("/transactions").expect(200);
  const search = await request(app).get("/search").expect(200);

  assert.match(
    dashboard.text,
    /<a[^>]*href="\/search"[^>]*aria-label="Search"/,
  );
  assert.match(dashboard.text, /data-search-dialog/);
  assert.match(
    dashboard.text,
    /href="\/search"[^>]*data-search-full-link/,
  );
  assert.match(
    transactions.text,
    /href="\/search"[^>]*>[\s\S]*?Search[\s\S]*?<\/a>/,
  );
  assert.doesNotMatch(search.text, /data-search-dialog/);
  assert.deepEqual(duplicateIds(dashboard.text), []);
  assert.deepEqual(duplicateIds(search.text), []);
});

test("search page script includes URL history, stale-request, and safe-link guards", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(
      fileURLToPath(new URL("../app/public/js/money.js", import.meta.url)),
      "utf8",
    ),
  );

  assert.match(source, /data-search-page/);
  assert.match(source, /history\.replaceState/);
  assert.match(source, /history\.pushState/);
  assert.match(source, /addEventListener\(["']popstate["']/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /generation|requestGeneration|requestId|searchVersion/);
  assert.match(source, /textContent/);
  assert.match(
    source,
    /(?:url\.origin|candidate\.origin|parsed\.origin)[\s\S]{0,160}(?:location\.origin|window\.location\.origin)/,
  );
});
