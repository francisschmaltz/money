import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PgFinanceRepository } from "../app/db/financeRepository.js";

function fakePool(handler) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const compact = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: compact, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(compact)) {
        return { rows: [], rowCount: 0 };
      }
      return (await handler(compact, params, calls)) ?? {
        rows: [],
        rowCount: 0,
      };
    },
    release() {},
  };
  return {
    calls,
    pool: {
      connect: async () => client,
      query: client.query.bind(client),
    },
  };
}

function settingsRow(overrides = {}) {
  return {
    workspace_id: "shared",
    revision: "2",
    base_guidance: "Prefer findings with a clear next action.",
    family_guidance: {
      weekly: "Prefer recent changes.",
      investments: "",
      subscriptions: "",
    },
    candidate_limit: 5,
    result_limit: 3,
    feedback_mode: "bad_and_archived",
    feedback_limit: 12,
    context_length: null,
    updated_by: "admin-1",
    updated_at: "2026-07-28T20:00:00.000Z",
    ...overrides,
  };
}

test("LLM ranking migration bounds settings and stores telemetry without payloads", async () => {
  const migration = await readFile(
    new URL("../migrations/026_insight_llm_ranking.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE insight_llm_settings/);
  assert.match(migration, /length\(base_guidance\) <= 4000/);
  assert.match(migration, /candidate_limit BETWEEN 1 AND 5/);
  assert.match(migration, /result_limit BETWEEN 1 AND 3/);
  assert.match(
    migration,
    /feedback_mode IN \('none', 'bad', 'bad_and_archived'\)/,
  );
  assert.match(migration, /feedback_limit BETWEEN 0 AND 12/);
  assert.match(
    migration,
    /context_length BETWEEN 256 AND 1048576/,
  );
  assert.match(migration, /CREATE TABLE insight_llm_call_status/);
  assert.match(migration, /'timeout'/);
  assert.match(
    migration,
    /insight_narratives_cache_identity_key UNIQUE/,
  );
  assert.doesNotMatch(
    migration,
    /\b(request_body|raw_response|request_payload|response_payload)\b/,
  );
});

test("repository maps saved settings and nullable authoritative usage", async () => {
  const db = fakePool(async (sql) => {
    if (sql.includes("FROM insight_llm_settings")) {
      return { rows: [settingsRow()] };
    }
    if (sql.includes("FROM insight_llm_call_status")) {
      return {
        rows: [
          {
            workspace_id: "shared",
            family: "weekly",
            run_id: "run-1",
            guidance_revision: "2",
            model: "qwen",
            status: "timeout",
            estimated_input_tokens: "812",
            prompt_tokens: null,
            completion_tokens: null,
            total_tokens: null,
            context_length: "8192",
            finish_reason: null,
            latency_ms: "15000",
            called_at: "2026-07-28T20:01:00.000Z",
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const settings = await repository.getInsightLlmSettings("shared");
  const statuses =
    await repository.listInsightLlmCallStatuses("shared");

  assert.equal(settings.revision, 2);
  assert.equal(settings.family_guidance.weekly, "Prefer recent changes.");
  assert.equal(settings.context_length, null);
  assert.deepEqual(statuses, [
    {
      family: "weekly",
      run_id: "run-1",
      guidance_revision: 2,
      model: "qwen",
      status: "timeout",
      estimated_input_tokens: 812,
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      context_length: 8192,
      finish_reason: null,
      latency_ms: 15000,
      called_at: "2026-07-28T20:01:00.000Z",
    },
  ]);
});

test("first-save races become an optimistic conflict instead of a unique error", async () => {
  let settingsSelects = 0;
  const db = fakePool(async (sql) => {
    if (
      sql.startsWith("SELECT * FROM insight_llm_settings")
    ) {
      settingsSelects += 1;
      return settingsSelects === 1
        ? { rows: [] }
        : { rows: [settingsRow({ revision: "1" })] };
    }
    if (sql.includes("INSERT INTO insight_llm_settings")) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const result = await repository.upsertInsightLlmSettings(
    "shared",
    {
      expectedRevision: 0,
      baseGuidance: "Rank useful findings.",
      familyGuidance: {
        weekly: "",
        investments: "",
        subscriptions: "",
      },
      candidateLimit: 5,
      resultLimit: 3,
      feedbackMode: "bad_and_archived",
      feedbackLimit: 12,
      contextLength: null,
      updatedBy: "admin-1",
    },
  );

  assert.equal(result.conflict, true);
  assert.equal(result.current.revision, 1);
  const insert = db.calls.find((call) =>
    call.sql.includes("INSERT INTO insight_llm_settings"),
  );
  assert.match(insert.sql, /ON CONFLICT \(workspace_id\) DO NOTHING/);
});

test("updates compare the expected revision in the write statement", async () => {
  let settingsSelects = 0;
  const db = fakePool(async (sql) => {
    if (
      sql.startsWith("SELECT * FROM insight_llm_settings")
    ) {
      settingsSelects += 1;
      return {
        rows: [
          settingsRow({
            revision: settingsSelects === 1 ? "2" : "3",
          }),
        ],
      };
    }
    if (sql.startsWith("UPDATE insight_llm_settings")) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const result = await repository.upsertInsightLlmSettings(
    "shared",
    {
      expectedRevision: 2,
      baseGuidance: "Rank useful findings.",
      familyGuidance: {
        weekly: "",
        investments: "",
        subscriptions: "",
      },
      candidateLimit: 5,
      resultLimit: 3,
      feedbackMode: "bad",
      feedbackLimit: 4,
      contextLength: 16_384,
      updatedBy: "admin-1",
    },
  );

  assert.equal(result.conflict, true);
  assert.equal(result.current.revision, 3);
  const update = db.calls.find((call) =>
    call.sql.startsWith("UPDATE insight_llm_settings"),
  );
  assert.match(update.sql, /context_length = \$8/);
  assert.match(update.sql, /AND revision = \$10/);
  assert.equal(update.params[7], 16_384);
  assert.equal(update.params[9], 2);
});

test("late-finishing calls cannot overwrite newer family telemetry", async () => {
  const newest = {
    workspace_id: "shared",
    family: "weekly",
    run_id: "newer-run",
    guidance_revision: "3",
    model: "qwen",
    status: "succeeded",
    estimated_input_tokens: "500",
    prompt_tokens: "490",
    completion_tokens: "20",
    total_tokens: "510",
    context_length: "8192",
    finish_reason: "stop",
    latency_ms: "100",
    called_at: "2026-07-28T20:02:00.000Z",
  };
  const db = fakePool(async (sql) => {
    if (sql.includes("INSERT INTO insight_llm_call_status")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM insight_llm_call_status")) {
      return { rows: [newest] };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  const status = await repository.upsertInsightLlmCallStatus(
    "shared",
    {
      family: "weekly",
      run_id: "older-run",
      guidance_revision: 2,
      model: "qwen",
      status: "timeout",
      estimated_input_tokens: 400,
      called_at: "2026-07-28T20:01:00.000Z",
    },
  );

  const insert = db.calls.find((call) =>
    call.sql.includes("INSERT INTO insight_llm_call_status"),
  );
  assert.match(
    insert.sql,
    /WHERE insight_llm_call_status\.called_at <= EXCLUDED\.called_at/,
  );
  assert.equal(status.run_id, "newer-run");
});

test("narrative persistence includes guidance provenance in its cache identity", async () => {
  const db = fakePool(async (sql) => {
    if (sql.includes("INSERT INTO insight_narratives")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM insight_narratives")) {
      return {
        rows: [
          {
            family: "weekly",
            headline: "Review dining",
            bullets: ["Check the recent change"],
            finding_ids: ["finding-1"],
            guidance_revision: "4",
            prompt_hash: "prompt-hash",
            model: "qwen",
            generated_at: "2026-07-28T20:00:00.000Z",
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = new PgFinanceRepository(db.pool);

  await repository.saveNarrative("shared", {
    family: "weekly",
    findingsHash: "findings-hash",
    guidanceRevision: 4,
    promptHash: "prompt-hash",
    model: "qwen",
    presentation: {
      headline: "Review dining",
      bullets: ["Check the recent change"],
      findingIds: ["finding-1"],
    },
  });
  const narrative = await repository.getLatestNarrative(
    "shared",
    "weekly",
  );

  const insert = db.calls.find((call) =>
    call.sql.includes("INSERT INTO insight_narratives"),
  );
  assert.match(
    insert.sql,
    /findings_hash, guidance_revision, prompt_hash, model/,
  );
  assert.match(
    insert.sql,
    /findings_hash, guidance_revision, prompt_hash, model \) DO UPDATE/,
  );
  assert.equal(narrative.guidance_revision, 4);
  assert.equal(narrative.prompt_hash, "prompt-hash");
  assert.equal(narrative.model, "qwen");
});
