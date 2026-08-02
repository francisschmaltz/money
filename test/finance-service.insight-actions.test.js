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
    recompute_queued: false,
  });
});

test("transfer streams cannot be reclassified into bills", async () => {
  let writes = 0;
  const service = createFinanceService({
    repository: {
      async listRecurringStreams() {
        return [{ id: "card-payment", cash_flow_role: "transfer" }];
      },
      async updateRecurringClassification() {
        writes += 1;
        return { stream_type: "bill" };
      },
    },
  });

  await assert.rejects(
    service.updateRecurringClassification({
      stream_id: "card-payment",
      type: "bill",
    }),
    (error) =>
      error.statusCode === 400 &&
      error.expose === true &&
      /Transfers cannot be classified as bills or subscriptions/.test(
        error.message,
      ),
  );
  assert.equal(writes, 0);
});

test("an active manual pattern blocks changing its transaction to Transfer", async () => {
  const service = createFinanceService({
    repository: {
      async batchEditTransactions() {
        return {
          conflict: "active_recurring_pattern",
          transactionIds: ["transaction-1"],
        };
      },
    },
  });

  await assert.rejects(
    service.batchEditTransactions({
      transaction_ids: ["transaction-1"],
      changes: { cash_flow_role: "transfer" },
    }),
    (error) =>
      error.statusCode === 400 &&
      error.expose === true &&
      /Remove the active Bill or Subscription pattern/.test(
        error.message,
      ),
  );
});

test("transaction recurring patterns validate spending, persist actor intent, and queue recomputation", async () => {
  const calls = [];
  const repository = {
    async getTransaction() {
      return {
        id: "transaction-1",
        pending: false,
        amount_minor: -8_500,
        excluded_from_spending: false,
        normalized_name: "utility bill",
      };
    },
    async getTransactionRecurringContext() {
      return { account_active: true };
    },
    async upsertRecurringPatternRule(
      workspaceId,
      transactionId,
      options,
    ) {
      calls.push(["upsert", workspaceId, transactionId, options]);
      return {
        id: "pattern-1",
        stream_id: "stream-1",
        stream_type: options.type,
        cadence: options.cadence,
      };
    },
    async deactivateRecurringPatternRule(
      workspaceId,
      transactionId,
      options,
    ) {
      calls.push(["remove", workspaceId, transactionId, options]);
      return { id: "pattern-1" };
    },
  };
  const jobQueue = {
    async enqueue(type, payload, options) {
      calls.push(["queue", type, payload, options]);
      return { id: "job-1" };
    },
  };
  const service = createFinanceService({ repository, jobQueue });

  const saved = await service.upsertTransactionRecurringPattern(
    {
      transaction_id: "transaction-1",
      type: "bill",
      cadence: "monthly",
    },
    { id: "user-1" },
  );
  const removed = await service.removeTransactionRecurringPattern(
    { transaction_id: "transaction-1" },
    { id: "user-1" },
  );

  assert.deepEqual(saved, {
    updated: true,
    pattern: {
      id: "pattern-1",
      stream_id: "stream-1",
      type: "bill",
      cadence: "monthly",
      source: "manual",
    },
    recompute_queued: true,
  });
  assert.deepEqual(removed, {
    updated: true,
    removed: true,
    pattern_id: "pattern-1",
    recompute_queued: true,
  });
  assert.deepEqual(calls, [
    [
      "upsert",
      "shared",
      "transaction-1",
      {
        type: "bill",
        cadence: "monthly",
        actorId: "user-1",
      },
    ],
    [
      "queue",
      "finance.detect_recurring",
      { workspaceId: "shared" },
      { dedupeKey: "shared" },
    ],
    [
      "remove",
      "shared",
      "transaction-1",
      { actorId: "user-1" },
    ],
    [
      "queue",
      "finance.detect_recurring",
      { workspaceId: "shared" },
      { dedupeKey: "shared" },
    ],
  ]);
});

test("transaction recurring patterns reject ineligible rows before persistence", async () => {
  let wrote = false;
  const service = createFinanceService({
    repository: {
      async getTransaction() {
        return {
          id: "income-1",
          pending: false,
          amount_minor: 5_000,
          excluded_from_spending: false,
        };
      },
      async getTransactionRecurringContext() {
        return { account_active: true };
      },
      async upsertRecurringPatternRule() {
        wrote = true;
      },
    },
  });

  await assert.rejects(
    service.upsertTransactionRecurringPattern({
      transaction_id: "income-1",
      type: "subscription",
      cadence: "monthly",
    }),
    /require an outflow transaction/,
  );
  assert.equal(wrote, false);
});

test("bulk insight actions transition once and rebuild search once", async () => {
  const calls = [];
  const service = createFinanceService({
    repository: {
      async batchTransitionInsightFindings(
        workspaceId,
        findingIds,
        transition,
      ) {
        calls.push([
          "transition",
          workspaceId,
          findingIds,
          transition,
        ]);
        return {
          updatedFindings: findingIds.map((id) => ({ id })),
        };
      },
      async rebuildSearchDocuments(workspaceId) {
        calls.push(["search", workspaceId]);
      },
    },
  });

  const result = await service.batchActOnFindings(
    {
      finding_ids: ["finding-1", "finding-2"],
      action: "report_incorrect",
      reason_code: "wrong_interpretation",
    },
    { id: "user-1" },
  );

  assert.deepEqual(calls, [
    [
      "transition",
      "shared",
      ["finding-1", "finding-2"],
      {
        action: "report_incorrect",
        actorId: "user-1",
        reasonCode: "wrong_interpretation",
      },
    ],
    ["search", "shared"],
  ]);
  assert.deepEqual(result, {
    updated: true,
    action: "report_incorrect",
    state: "bad",
    updated_count: 2,
    finding_ids: ["finding-1", "finding-2"],
    reason_code: "wrong_interpretation",
  });
});

test("bulk aliases normalize and invalid selections never rebuild search", async () => {
  const calls = [];
  const service = createFinanceService({
    repository: {
      async batchTransitionInsightFindings(
        _workspaceId,
        _findingIds,
        transition,
      ) {
        calls.push(transition);
        if (transition.reasonCode === "not_subscription") {
          return { incompatibleFindingIds: ["finding-1"] };
        }
        return {
          updatedFindings: [{ id: "finding-1" }],
        };
      },
      async rebuildSearchDocuments() {
        calls.push("search");
      },
    },
  });

  const alias = await service.batchActOnFindings(
    {
      finding_ids: ["finding-1"],
      action: "mark_bad",
    },
    { id: "user-1" },
  );
  assert.equal(alias.action, "report_incorrect");
  assert.equal(alias.reason_code, "other_false_positive");
  assert.deepEqual(calls, [
    {
      action: "report_incorrect",
      actorId: "user-1",
      reasonCode: "other_false_positive",
    },
    "search",
  ]);

  calls.length = 0;
  await assert.rejects(
    service.batchActOnFindings({
      finding_ids: ["finding-1"],
      action: "report_incorrect",
      reason_code: "not_subscription",
    }),
    /only applies to subscription insights/,
  );
  assert.deepEqual(calls, [
    {
      action: "report_incorrect",
      actorId: null,
      reasonCode: "not_subscription",
    },
  ]);
});

test("bulk insight validation rejects malformed requests before storage", async () => {
  let called = false;
  const service = createFinanceService({
    repository: {
      async batchTransitionInsightFindings() {
        called = true;
      },
    },
  });

  for (const input of [
    { finding_ids: [], action: "archive" },
    {
      finding_ids: ["finding-1", "finding-1"],
      action: "archive",
    },
    { finding_ids: ["finding-1"], action: "delete" },
    {
      finding_ids: ["finding-1"],
      action: "archive",
      reason_code: "wrong_data",
    },
    {
      finding_ids: ["finding-1"],
      action: "report_incorrect",
    },
  ]) {
    await assert.rejects(
      service.batchActOnFindings(input),
      (error) => error.statusCode === 400,
    );
  }
  assert.equal(called, false);
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
