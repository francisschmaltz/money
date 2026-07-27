import test from "node:test";
import assert from "node:assert/strict";

import { createFinanceService } from "../app/services/financeService.js";

function finding(overrides = {}) {
  return {
    id: "finding-1",
    finding_key: "pattern-duplicate",
    family: "subscriptions",
    type: "possible_duplicate",
    state: "active",
    evidence: [
      {
        entity_type: "recurring",
        entity_id: "stream-1",
      },
      {
        entity_type: "recurring_stream",
        entity_id: "stream-2",
      },
    ],
    actions: [],
    ...overrides,
  };
}

test("dismissing a duplicate preserves its detector side effect and lifecycle event", async () => {
  const calls = [];
  const service = createFinanceService({
    repository: {
      async getInsightFinding() {
        return finding();
      },
      async updateRecurringDuplicateState(workspaceId, streamIds, state) {
        calls.push(["duplicates", workspaceId, streamIds, state]);
      },
      async transitionInsightFinding(workspaceId, findingId, transition) {
        calls.push(["transition", workspaceId, findingId, transition]);
        return { ...finding(), state: "dismissed" };
      },
      async rebuildSearchDocuments(workspaceId) {
        calls.push(["search", workspaceId]);
      },
    },
  });

  const result = await service.actOnFinding(
    { finding_id: "finding-1", action: "dismiss" },
    { id: "user-1" },
  );

  assert.deepEqual(calls, [
    [
      "duplicates",
      "shared",
      ["stream-1", "stream-2"],
      "not_duplicate",
    ],
    [
      "transition",
      "shared",
      "finding-1",
      { action: "dismiss", actorId: "user-1" },
    ],
    ["search", "shared"],
  ]);
  assert.deepEqual(result, {
    updated: true,
    deleted: false,
    finding_id: "finding-1",
    finding_key: "pattern-duplicate",
    state: "dismissed",
    action: "dismiss",
  });
});

test("confirming a duplicate records confirmation before resolving it", async () => {
  const calls = [];
  const service = createFinanceService({
    repository: {
      async getInsightFinding() {
        return finding();
      },
      async updateRecurringDuplicateState(_workspaceId, streamIds, state) {
        calls.push(["duplicates", streamIds, state]);
      },
      async transitionInsightFinding(_workspaceId, _findingId, transition) {
        calls.push(["transition", transition]);
        return { ...finding(), state: "resolved" };
      },
      async rebuildSearchDocuments() {},
    },
  });

  await service.actOnFinding(
    { finding_id: "finding-1", action: "confirm" },
    { id: "user-1" },
  );

  assert.deepEqual(calls, [
    ["duplicates", ["stream-1", "stream-2"], "confirmed"],
    ["transition", { action: "confirm", actorId: "user-1" }],
  ]);
});

test("archive, bad, restore, and delete actions use deterministic transitions", async () => {
  const transitions = [];
  const service = createFinanceService({
    repository: {
      async getInsightFinding() {
        return finding({
          family: "weekly",
          type: "spend_less",
          evidence: [],
        });
      },
      async transitionInsightFinding(_workspaceId, _findingId, transition) {
        transitions.push(transition);
        return {
          ...finding(),
          state: {
            archive: "archived",
            mark_bad: "bad",
            restore: "active",
            delete: "active",
          }[transition.action],
          deleted: transition.action === "delete",
        };
      },
      async rebuildSearchDocuments() {},
    },
  });

  const results = [];
  for (const action of ["archive", "mark_bad", "restore", "delete"]) {
    results.push(
      await service.actOnFinding(
        { finding_id: "finding-1", action },
        { id: "user-1" },
      ),
    );
  }

  assert.deepEqual(
    transitions,
    ["archive", "mark_bad", "restore", "delete"].map((action) => ({
      action,
      actorId: "user-1",
    })),
  );
  assert.deepEqual(
    results.map((result) => result.state),
    ["archived", "bad", "active", "deleted"],
  );
  assert.deepEqual(
    results.map((result) => result.deleted),
    [false, false, false, true],
  );
});

test("unknown and missing insight actions fail before mutation", async () => {
  let transitions = 0;
  const missing = createFinanceService({
    repository: {
      async getInsightFinding() {
        return null;
      },
      async transitionInsightFinding() {
        transitions += 1;
      },
    },
  });
  await assert.rejects(
    missing.actOnFinding({
      finding_id: "missing",
      action: "archive",
    }),
    /Insight finding not found/,
  );

  const invalid = createFinanceService({
    repository: {
      async getInsightFinding() {
        return finding();
      },
      async transitionInsightFinding() {
        transitions += 1;
      },
    },
  });
  await assert.rejects(
    invalid.actOnFinding({
      finding_id: "finding-1",
      action: "buy_more",
    }),
    /Unsupported insight action/,
  );
  assert.equal(transitions, 0);
});
