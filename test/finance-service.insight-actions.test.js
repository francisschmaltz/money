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

test("dismiss remains an ignore-similar alias without claiming a false duplicate", async () => {
  const calls = [];
  const service = createFinanceService({
    repository: {
      async getInsightFinding() {
        return finding();
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

test("mark_bad remains an incorrect alias and corrects a false duplicate", async () => {
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
        return { ...finding(), state: "bad" };
      },
      async rebuildSearchDocuments() {},
    },
  });

  await service.actOnFinding(
    { finding_id: "finding-1", action: "mark_bad" },
    { id: "user-1" },
  );

  assert.deepEqual(calls, [
    ["duplicates", ["stream-1", "stream-2"], "not_duplicate"],
    ["transition", { action: "mark_bad", actorId: "user-1" }],
  ]);
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

test("incorrect subscription feedback corrects the stream and remains safely restorable", async () => {
  const calls = [];
  const service = createFinanceService({
    repository: {
      async getInsightFinding() {
        return finding({
          type: "expensive",
          evidence: [
            {
              entity_type: "recurring",
              entity_id: "stream-1",
            },
          ],
        });
      },
      async updateRecurringClassification(
        workspaceId,
        streamId,
        options,
      ) {
        calls.push([
          "classification",
          workspaceId,
          streamId,
          options,
        ]);
        return { stream_type: options.type };
      },
      async transitionInsightFinding(
        _workspaceId,
        _findingId,
        transition,
      ) {
        calls.push(["transition", transition]);
        return {
          ...finding(),
          state:
            transition.action === "restore" ? "active" : "bad",
        };
      },
      async clearRecurringClassificationFromFinding(
        workspaceId,
        findingId,
      ) {
        calls.push(["clear", workspaceId, findingId]);
        return ["stream-1"];
      },
      async rebuildSearchDocuments() {},
    },
  });

  await service.actOnFinding(
    {
      finding_id: "finding-1",
      action: "report_incorrect",
      reason_code: "not_subscription",
    },
    { id: "user-1" },
  );
  await service.actOnFinding(
    { finding_id: "finding-1", action: "restore" },
    { id: "user-1" },
  );

  assert.deepEqual(calls, [
    [
      "classification",
      "shared",
      "stream-1",
      {
        type: "frequent_spending",
        actorId: "user-1",
        sourceFindingId: "finding-1",
      },
    ],
    [
      "transition",
      {
        action: "report_incorrect",
        actorId: "user-1",
        reasonCode: "not_subscription",
      },
    ],
    ["transition", { action: "restore", actorId: "user-1" }],
    ["clear", "shared", "finding-1"],
  ]);
});

test("manual recurring classification clears automatic source ownership", async () => {
  const calls = [];
  const service = createFinanceService({
    repository: {
      async updateRecurringClassification(
        workspaceId,
        streamId,
        options,
      ) {
        calls.push([workspaceId, streamId, options]);
        return { stream_type: options.type };
      },
      async rebuildSearchDocuments() {},
    },
  });

  const result = await service.updateRecurringClassification(
    { stream_id: "stream-1", type: "bill" },
    { id: "user-1" },
  );

  assert.deepEqual(calls, [
    [
      "shared",
      "stream-1",
      {
        type: "bill",
        actorId: "user-1",
        sourceFindingId: null,
      },
    ],
  ]);
  assert.deepEqual(result, {
    updated: true,
    stream_id: "stream-1",
    type: "bill",
  });
});

test("frequent spending stays visible on the web without inflating payment totals or MCP results", async () => {
  const stream = {
    cadence: "monthly",
    account_id: "account-1",
    account_name: "Card",
    expected_amount_minor: 1_000,
    min_amount_minor: 1_000,
    max_amount_minor: 1_000,
    currency_code: "USD",
    first_seen_on: "2026-01-01",
    last_seen_on: "2026-07-01",
    next_expected_on: "2026-08-01",
    confidence_basis_points: 9_000,
    status: "active",
    duplicate_state: "unknown",
    transaction_ids: [],
  };
  const service = createFinanceService({
    repository: {
      async listRecurringStreams() {
        return [
          {
            ...stream,
            id: "subscription-1",
            service_family: "netflix",
            display_name: "Netflix",
            stream_type: "subscription",
            detected_stream_type: "subscription",
            monthly_equivalent_minor: 1_000,
          },
          {
            ...stream,
            id: "frequent-1",
            service_family: "shell oil",
            display_name: "Shell Oil",
            stream_type: "frequent_spending",
            detected_stream_type: "frequent_spending",
            monthly_equivalent_minor: 9_000,
          },
        ];
      },
      async getDataFreshness() {
        return {
          data_as_of: "2026-07-27T12:00:00.000Z",
          partial: false,
          warnings: [],
        };
      },
    },
  });

  const web = await service.listRecurringPayments({
    status: "all",
    includeFrequentSpending: true,
  });
  const mcp = await service.listRecurringPayments({ status: "all" });

  assert.equal(web.data.recurring_payments.length, 2);
  assert.equal(web.data.monthly_equivalent.amount_minor, 1_000);
  assert.deepEqual(
    mcp.data.recurring_payments.map((item) => item.type),
    ["subscription"],
  );
});
