import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  bumpWorkspaceReadModelRevision,
  ensureWorkspaceReadModelRevision,
  getWorkspaceReadModelRevision,
} from "../app/db/index.js";
import {
  markWorkspaceReadModelSourceUnstable,
  publishWorkspaceReadModelClock,
  publishStableWorkspaceReadModelRevision,
  ReadModelSourceUnstableError,
} from "../app/db/workspaceReadModelRevision.js";

function fakeDb(results) {
  const calls = [];
  return {
    calls,
    db: {
      async query(sql, params) {
        calls.push({
          sql: String(sql).replace(/\s+/g, " ").trim(),
          params,
        });
        return results.shift() ?? { rows: [] };
      },
    },
  };
}

function fakeActiveSyncDb(initialRevision = "7") {
  const calls = [];
  const activeConnections = new Set();
  let revision = BigInt(initialRevision);
  return {
    calls,
    activeConnections,
    db: {
      async query(sql, params = []) {
        const normalized = String(sql).replace(/\s+/g, " ").trim();
        calls.push({ sql: normalized, params });

        if (/INSERT INTO workspace_read_model_active_syncs/.test(normalized)) {
          activeConnections.add(params[1]);
        }
        const settledOwnedToken =
          /DELETE FROM workspace_read_model_active_syncs/.test(normalized) &&
          activeConnections.delete(params[1]);
        const settlesConnection =
          /DELETE FROM workspace_read_model_active_syncs/.test(normalized);
        const incrementsRevision = settlesConnection
          ? settledOwnedToken
          : /revision = workspace_read_model_revisions\.revision \+ 1/.test(
              normalized,
            );
        if (incrementsRevision) {
          revision += 1n;
        }

        return {
          rows: [
            {
              revision: revision.toString(),
              source_stable: activeConnections.size === 0,
            },
          ],
        };
      },
    },
  };
}

test("read-model revision migration seeds one durable row per workspace", async () => {
  const migration = await readFile(
    new URL(
      "../migrations/039_workspace_read_model_revisions.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    migration,
    /CREATE TABLE workspace_read_model_revisions/,
  );
  assert.match(
    migration,
    /workspace_id text PRIMARY KEY\s+REFERENCES workspaces\(id\) ON DELETE CASCADE/,
  );
  assert.match(
    migration,
    /revision bigint NOT NULL DEFAULT 1\s+CHECK \(revision >= 1\)/,
  );
  assert.match(migration, /clock_token text NOT NULL DEFAULT ''/);
  assert.match(
    migration,
    /CREATE TABLE workspace_read_model_active_syncs/,
  );
  assert.match(
    migration,
    /connection_id text NOT NULL/,
  );
  assert.match(
    migration,
    /PRIMARY KEY \(workspace_id, connection_id\)/,
  );
  assert.match(
    migration,
    /INSERT INTO workspace_read_model_revisions \(workspace_id\)\s+SELECT id\s+FROM workspaces/,
  );
});

test("get returns a lossless decimal string and null for a missing row", async () => {
  const { db, calls } = fakeDb([
    { rows: [{ revision: "9007199254740993" }] },
    { rows: [] },
  ]);

  assert.equal(
    await getWorkspaceReadModelRevision(db, "workspace-1"),
    "9007199254740993",
  );
  assert.equal(
    await getWorkspaceReadModelRevision(db, "workspace-2"),
    null,
  );
  assert.deepEqual(
    calls.map((call) => call.params),
    [["workspace-1"], ["workspace-2"]],
  );
  assert.match(
    calls[0].sql,
    /WHERE revision_row\.workspace_id = \$1/,
  );
  assert.match(calls[0].sql, /NOT EXISTS/);
  assert.match(calls[0].sql, /workspace_read_model_active_syncs/);
});

test("ensure preserves an existing revision without writing", async () => {
  const { db, calls } = fakeDb([
    { rows: [{ revision: "7" }] },
  ]);

  assert.equal(
    await ensureWorkspaceReadModelRevision(db, "workspace-1"),
    "7",
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /^SELECT revision/);
});

test("ensure creates revision one and resolves a concurrent insert", async () => {
  const created = fakeDb([
    { rows: [] },
    { rows: [{ revision: "1" }] },
  ]);
  assert.equal(
    await ensureWorkspaceReadModelRevision(created.db, "new-workspace"),
    "1",
  );
  assert.match(
    created.calls[1].sql,
    /ON CONFLICT \(workspace_id\) DO NOTHING RETURNING revision/,
  );

  const raced = fakeDb([
    { rows: [] },
    { rows: [] },
    { rows: [{ revision: "4" }] },
  ]);
  assert.equal(
    await ensureWorkspaceReadModelRevision(raced.db, "raced-workspace"),
    "4",
  );
  assert.equal(raced.calls.length, 3);
});

test("bump atomically creates or increments the workspace revision", async () => {
  const { db, calls } = fakeDb([
    { rows: [{ revision: "8" }] },
  ]);

  assert.equal(
    await bumpWorkspaceReadModelRevision(db, "workspace-1"),
    "8",
  );
  assert.deepEqual(calls[0].params, ["workspace-1"]);
  assert.match(
    calls[0].sql,
    /ON CONFLICT \(workspace_id\) DO UPDATE SET revision = workspace_read_model_revisions\.revision \+ 1/,
  );
  assert.match(calls[0].sql, /updated_at = now\(\)/);
  assert.match(calls[0].sql, /RETURNING revision/);
});

test("an unstable source rejects revision reads", async () => {
  const { db } = fakeDb([
    { rows: [{ revision: "7", source_stable: false }] },
  ]);

  await assert.rejects(
    getWorkspaceReadModelRevision(db, "workspace-1"),
    ReadModelSourceUnstableError,
  );
});

test("marking the source unstable preserves its revision", async () => {
  const { db, calls, activeConnections } = fakeActiveSyncDb();

  assert.equal(
    await markWorkspaceReadModelSourceUnstable(
      db,
      "workspace-1",
      "connection-a",
    ),
    "7",
  );
  assert.deepEqual([...activeConnections], ["connection-a"]);
  assert.match(
    calls.map((call) => call.sql).join(" "),
    /INSERT INTO workspace_read_model_active_syncs/,
  );
  assert.doesNotMatch(
    calls.map((call) => call.sql).join(" "),
    /revision = workspace_read_model_revisions\.revision \+ 1/,
  );
});

test("generic bumps remain valid while the source is unstable", async () => {
  const { db, calls } = fakeActiveSyncDb();

  await markWorkspaceReadModelSourceUnstable(
    db,
    "workspace-1",
    "connection-a",
  );

  assert.equal(
    await bumpWorkspaceReadModelRevision(db, "workspace-1"),
    "8",
  );
  assert.match(
    calls.map((call) => call.sql).join(" "),
    /revision = workspace_read_model_revisions\.revision \+ 1/,
  );
  await assert.rejects(
    getWorkspaceReadModelRevision(db, "workspace-1"),
    ReadModelSourceUnstableError,
  );
});

test("clock boundaries bump once per UTC and local date token", async () => {
  let revision = 7n;
  let token = "";
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push(String(sql).replace(/\s+/g, " ").trim());
      if (token !== params[1]) {
        revision += 1n;
        token = params[1];
      }
      return { rows: [{ revision: revision.toString() }] };
    },
  };

  assert.equal(
    await publishWorkspaceReadModelClock(
      db,
      "workspace-1",
      "2026-08-03:2026-08-03",
    ),
    "8",
  );
  assert.equal(
    await publishWorkspaceReadModelClock(
      db,
      "workspace-1",
      "2026-08-03:2026-08-03",
    ),
    "8",
  );
  assert.equal(
    await publishWorkspaceReadModelClock(
      db,
      "workspace-1",
      "2026-08-04:2026-08-03",
    ),
    "9",
  );
  assert.match(calls[0], /IS DISTINCT FROM EXCLUDED\.clock_token/);
});

test("publishing a stable boundary bumps the revision and restores reads", async () => {
  const { db, calls } = fakeActiveSyncDb();

  await markWorkspaceReadModelSourceUnstable(
    db,
    "workspace-1",
    "connection-a",
  );

  assert.equal(
    await publishStableWorkspaceReadModelRevision(
      db,
      "workspace-1",
      "connection-a",
    ),
    "8",
  );
  assert.match(
    calls.map((call) => call.sql).join(" "),
    /UPDATE workspace_read_model_revisions SET revision = workspace_read_model_revisions\.revision \+ 1/,
  );
  assert.match(
    calls.map((call) => call.sql).join(" "),
    /EXISTS \(SELECT 1 FROM settled_sync\)/,
  );
  assert.match(
    calls.map((call) => call.sql).join(" "),
    /DELETE FROM workspace_read_model_active_syncs/,
  );
  assert.equal(
    await getWorkspaceReadModelRevision(db, "workspace-1"),
    "8",
  );
});

test("settling the same connection twice does not bump twice", async () => {
  const { db, calls } = fakeActiveSyncDb();

  await markWorkspaceReadModelSourceUnstable(
    db,
    "workspace-1",
    "connection-a",
  );
  assert.equal(
    await publishStableWorkspaceReadModelRevision(
      db,
      "workspace-1",
      "connection-a",
    ),
    "8",
  );
  assert.equal(
    await publishStableWorkspaceReadModelRevision(
      db,
      "workspace-1",
      "connection-a",
    ),
    "8",
  );
  assert.equal(
    await getWorkspaceReadModelRevision(db, "workspace-1"),
    "8",
  );

  const settlements = calls.filter((call) =>
    /DELETE FROM workspace_read_model_active_syncs/.test(call.sql),
  );
  assert.equal(settlements.length, 2);
  assert.deepEqual(
    settlements.map((call) => call.params),
    [
      ["workspace-1", "connection-a"],
      ["workspace-1", "connection-a"],
    ],
  );
});

test("one Plaid completion cannot clear another active connection", async () => {
  const { db, activeConnections } = fakeActiveSyncDb();

  await markWorkspaceReadModelSourceUnstable(
    db,
    "workspace-1",
    "connection-a",
  );
  await markWorkspaceReadModelSourceUnstable(
    db,
    "workspace-1",
    "connection-b",
  );
  assert.deepEqual(
    [...activeConnections].sort(),
    ["connection-a", "connection-b"],
  );

  await publishStableWorkspaceReadModelRevision(
    db,
    "workspace-1",
    "connection-a",
  );
  assert.deepEqual([...activeConnections], ["connection-b"]);
  await assert.rejects(
    getWorkspaceReadModelRevision(db, "workspace-1"),
    ReadModelSourceUnstableError,
  );

  await publishStableWorkspaceReadModelRevision(
    db,
    "workspace-1",
    "connection-b",
  );
  assert.deepEqual([...activeConnections], []);
  assert.equal(
    await getWorkspaceReadModelRevision(db, "workspace-1"),
    "9",
  );
});
