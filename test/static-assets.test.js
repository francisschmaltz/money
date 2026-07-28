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
  assert.match(head, /\/css\/money\.css\?v=19/);
  assert.match(head, /\/js\/charts\.js\?v=5/);
  assert.match(head, /\/js\/money\.js\?v=13/);
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
