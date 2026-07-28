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
  assert.match(head, /\/css\/money\.css\?v=18/);
  assert.match(head, /\/js\/charts\.js\?v=5/);
  assert.match(head, /\/js\/money\.js\?v=13/);
});
