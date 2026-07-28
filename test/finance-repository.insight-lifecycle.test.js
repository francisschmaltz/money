import test from "node:test";
import assert from "node:assert/strict";

import { PgFinanceRepository } from "../app/db/financeRepository.js";

function fakePool(handler = async () => ({ rows: [] })) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const compact = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: compact, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(compact)) {
        return { rows: [], rowCount: 0 };
      }
      return (await handler(compact, params)) ?? {
        rows: [],
        rowCount: 0,
      };
    },
    release() {},
  };
  return {
    calls,
    pool: {
      async connect() {
        return client;
      },
      query: client.query.bind(client),
    },
  };
}

function storedFinding(overrides = {}) {
  return {
    id: "finding-1",
    workspace_id: "shared",
    finding_key: "pattern-dining",
    family: "weekly",
    finding_type: "spend_less",
    severity: "attention",
    title: "Spend less on dining",
    explanation: "Dining is higher than the comparison period.",
    period_start: "2026-07-20",
    period_end: "2026-07-27",
    metrics: {},
    rule: { key: "spend_less" },
    confidence_basis_points: 9_000,
    evidence: [],
    actions: [],
    state: "active",
    is_current: true,
    retired_at: null,
    state_changed_at: null,
    state_changed_by: null,
    generated_at: "2026-07-27T12:00:00.000Z",
    data_as_of: "2026-07-27T11:00:00.000Z",
    ...overrides,
  };
}

function generatedFinding(overrides = {}) {
  return {
    id: "finding-new",
    finding_key: "pattern-dining",
    type: "spend_less",
    severity: "attention",
    title: "Spend less on dining",
    explanation: "Dining is higher than the comparison period.",
    period_start: "2026-07-20",
    period_end: "2026-07-27",
    metrics: {},
    rule: { key: "spend_less" },
    confidence_basis_points: 9_000,
    evidence: [],
    actions: [],
    generated_at: "2026-07-27T12:00:00.000Z",
    data_as_of: "2026-07-27T11:00:00.000Z",
    ...overrides,
  };
}

test("nightly insight replacement retires history and applies sticky preferences", async () => {
  const db = fakePool(async (sql) => {
    if (sql.includes("FROM insight_finding_preferences")) {
      return {
        rows: [
          {
            finding_key: "pattern-dining",
            disposition: "bad",
            updated_by: "user-1",
            updated_at: "2026-07-26T10:00:00.000Z",
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  await repository.replaceInsightFindings("shared", "weekly", [
    generatedFinding(),
    generatedFinding({
      id: "finding-other",
      finding_key: "pattern-fees",
      type: "better_habits",
    }),
  ]);

  assert.equal(
    db.calls.some((call) =>
      call.sql.startsWith("DELETE FROM insight_findings"),
    ),
    false,
  );
  const retire = db.calls.find((call) =>
    call.sql.startsWith("UPDATE insight_findings SET is_current = false"),
  );
  assert.deepEqual(retire?.params, ["shared", "weekly"]);
  assert.match(retire.sql, /retired_at = COALESCE\(retired_at, now\(\)\)/);

  const inserts = db.calls.filter((call) =>
    call.sql.startsWith("INSERT INTO insight_findings"),
  );
  assert.equal(inserts.length, 2);
  assert.equal(inserts[0].params[2], "pattern-dining");
  assert.equal(inserts[0].params[17], "bad");
  assert.equal(inserts[0].params[19], "user-1");
  assert.equal(inserts[1].params[17], "active");
  assert.match(inserts[0].sql, /is_current = true/);
  assert.match(inserts[0].sql, /retired_at = NULL/);
});

test("recurring replacement refreshes detector signals and inherits an override across stream IDs", async () => {
  const db = fakePool(async (sql) => {
    if (
      sql.startsWith("SELECT r.stream_type_override") &&
      sql.includes("FROM recurring_streams r")
    ) {
      return {
        rows: [
          {
            stream_type_override: "subscription",
            override_source_finding_id: null,
            override_updated_by: "admin-1",
            override_updated_at: "2026-07-26T10:00:00.000Z",
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  await repository.replaceRecurringStreams("shared", [
    {
      id: "stream-1",
      service_family: "shell oil",
      display_name: "Shell Oil",
      stream_type: "frequent_spending",
      cadence: "monthly",
      account_id: "account-1",
      expected_amount_minor: 5_000,
      min_amount_minor: 4_900,
      max_amount_minor: 5_100,
      monthly_equivalent_minor: 5_000,
      currency_code: "USD",
      first_seen_on: "2026-01-01",
      last_seen_on: "2026-04-01",
      next_expected_on: "2026-05-01",
      confidence_basis_points: 9_000,
      status: "active",
      classification_signals: { hard_negative: true },
      transaction_ids: ["txn-1"],
    },
  ]);

  const insert = db.calls.find((call) =>
    call.sql.startsWith("INSERT INTO recurring_streams"),
  );
  assert.equal(insert.params[17], JSON.stringify({ hard_negative: true }));
  assert.deepEqual(insert.params.slice(18), [
    "subscription",
    null,
    "admin-1",
    "2026-07-26T10:00:00.000Z",
  ]);
  assert.match(
    insert.sql,
    /classification_signals = EXCLUDED\.classification_signals/,
  );
  assert.doesNotMatch(
    insert.sql,
    /stream_type_override = EXCLUDED\.stream_type_override/,
  );
  const overrideLookup = db.calls.find((call) =>
    call.sql.startsWith("SELECT r.stream_type_override"),
  );
  assert.deepEqual(overrideLookup.params, [
    "shared",
    "stream-1",
    "account-1",
    ["txn-1"],
  ]);
});

test("nightly replacement keeps a deleted occurrence tombstoned without suppressing a future period", async () => {
  const db = fakePool(async (sql) => {
    if (sql.includes("FROM insight_finding_preferences")) {
      return { rows: [] };
    }
    if (
      sql.startsWith("SELECT DISTINCT finding_id") &&
      sql.includes("action = 'delete'")
    ) {
      return { rows: [{ finding_id: "finding-deleted" }] };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  await repository.replaceInsightFindings("shared", "weekly", [
    generatedFinding({
      id: "finding-deleted",
      finding_key: "pattern-dining",
    }),
    generatedFinding({
      id: "finding-next-period",
      finding_key: "pattern-dining",
      period_start: "2026-07-21",
      period_end: "2026-07-28",
    }),
  ]);

  const tombstones = db.calls.find((call) =>
    call.sql.startsWith("SELECT DISTINCT finding_id"),
  );
  assert.deepEqual(tombstones.params, [
    "shared",
    ["finding-deleted", "finding-next-period"],
  ]);
  const inserts = db.calls.filter((call) =>
    call.sql.startsWith("INSERT INTO insight_findings"),
  );
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].params[0], "finding-next-period");
  assert.equal(inserts[0].params[2], "pattern-dining");
});

test("insight finding reads separate active and archive scopes", async () => {
  const db = fakePool(async (sql, params) => {
    if (sql.startsWith("SELECT * FROM insight_findings")) {
      return {
        rows: [
          storedFinding({
            state: params[2] === "archive" ? "archived" : "active",
            is_current: params[2] !== "archive",
          }),
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const active = await repository.listInsightFindings("shared", {
    scope: "active",
  });
  const archive = await repository.listInsightFindings("shared", {
    scope: "archive",
  });

  const queries = db.calls.filter((call) =>
    call.sql.startsWith("SELECT * FROM insight_findings"),
  );
  assert.equal(queries[0].params[2], "active");
  assert.match(
    queries[0].sql,
    /is_current = true AND state = 'active'/,
  );
  assert.match(
    queries[0].sql,
    /WHEN 'important' THEN 0 WHEN 'attention' THEN 1 WHEN 'info' THEN 2/,
  );
  assert.equal(queries[1].params[2], "archive");
  assert.match(
    queries[1].sql,
    /is_current = false OR state <> 'active'/,
  );
  assert.match(
    queries[1].sql,
    /ELSE 0 END, generated_at DESC, id/,
  );
  assert.equal(active[0].is_current, true);
  assert.equal(archive[0].state, "archived");
  assert.equal(archive[0].is_current, false);

  await assert.rejects(
    repository.listInsightFindings("shared", { scope: "deleted" }),
    /Invalid insight finding scope/,
  );
});

test("insight transitions write sticky feedback and an append-only event", async () => {
  const row = storedFinding();
  const db = fakePool(async (sql, params) => {
    if (sql.includes("FROM insight_findings") && sql.includes("FOR UPDATE")) {
      return { rows: [row] };
    }
    if (sql.startsWith("UPDATE insight_findings SET state")) {
      return {
        rows: [
          {
            ...row,
            state: params[2],
            state_changed_at: "2026-07-27T13:00:00.000Z",
            state_changed_by: params[3],
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const result = await repository.transitionInsightFinding(
    "shared",
    "finding-1",
    { action: "mark_bad", actorId: "user-1" },
  );

  assert.equal(result.state, "bad");
  assert.equal(result.state_changed_by, "user-1");
  const event = db.calls.find((call) =>
    call.sql.startsWith("INSERT INTO insight_finding_events"),
  );
  assert.deepEqual(event.params.slice(1), [
    "shared",
    "finding-1",
    "pattern-dining",
    "weekly",
    "spend_less",
    "mark_bad",
    "active",
    "bad",
    "user-1",
    "other_false_positive",
  ]);
  const preference = db.calls.find((call) =>
    call.sql.startsWith("INSERT INTO insight_finding_preferences"),
  );
  assert.deepEqual(preference.params, [
    "shared",
    "pattern-dining",
    "bad",
    "other_false_positive",
    "user-1",
  ]);
});

test("deleting an insight hard-deletes its body but retains its fingerprint event", async () => {
  const row = storedFinding();
  const db = fakePool(async (sql) => {
    if (sql.includes("FROM insight_findings") && sql.includes("FOR UPDATE")) {
      return { rows: [row] };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const result = await repository.transitionInsightFinding(
    "shared",
    "finding-1",
    { action: "delete", actorId: "user-1" },
  );

  assert.equal(result.deleted, true);
  const eventIndex = db.calls.findIndex((call) =>
    call.sql.startsWith("INSERT INTO insight_finding_events"),
  );
  const deleteIndex = db.calls.findIndex((call) =>
    call.sql.startsWith("DELETE FROM insight_findings"),
  );
  assert.ok(eventIndex > -1);
  assert.ok(deleteIndex > eventIndex);
  assert.deepEqual(db.calls[eventIndex].params.slice(1, 9), [
    "shared",
    "finding-1",
    "pattern-dining",
    "weekly",
    "spend_less",
    "delete",
    "active",
    "deleted",
  ]);
  assert.ok(
    db.calls.some((call) =>
      call.sql.startsWith("DELETE FROM insight_narratives"),
    ),
  );
  assert.ok(
    db.calls.some((call) =>
      call.sql.startsWith("DELETE FROM search_documents"),
    ),
  );
});

test("insight feedback summaries are bounded and contain no financial evidence", async () => {
  const db = fakePool(async (sql) => {
    if (
      sql.includes("FROM insight_finding_events") &&
      sql.includes("action IN")
    ) {
      return {
        rows: [
          {
            feedback_key: "pattern-dining",
            count: "3",
            reason_codes: [
              "other_false_positive",
              "ignored",
              "other_false_positive",
            ],
            last_feedback_at: "2026-07-27T13:00:00.000Z",
          },
        ],
      };
    }
    if (
      sql.includes("FROM insight_finding_events") &&
      sql.includes("action = 'archive'")
    ) {
      return {
        rows: [
          {
            feedback_key: "pattern-fees",
            count: "2",
            last_feedback_at: "2026-07-27T12:00:00.000Z",
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const summary = await repository.getInsightFeedbackSummary("shared", {
    family: "weekly",
    days: 5_000,
    limit: 100,
  });

  const queries = db.calls.filter((call) =>
    call.sql.includes("FROM insight_finding_events"),
  );
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0].params, ["shared", "weekly", 365, 20]);
  assert.deepEqual(queries[1].params, ["shared", "weekly", 365, 20]);
  for (const query of queries) {
    assert.match(query.sql, /WITH latest_restore AS/);
    assert.match(
      query.sql,
      /r\.restored_at IS NULL OR e\.created_at > r\.restored_at/,
    );
  }
  assert.deepEqual(summary, {
    bad: [
      {
        feedback_key: "pattern-dining",
        count: 3,
        reason_codes: ["ignored", "other_false_positive"],
      },
    ],
    archived: [
      {
        feedback_key: "pattern-fees",
        count: 2,
      },
    ],
  });
  assert.equal(JSON.stringify(summary).includes("amount"), false);
  assert.equal(JSON.stringify(summary).includes("evidence"), false);
});
