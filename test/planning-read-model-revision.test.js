import assert from "node:assert/strict";
import test from "node:test";

import { PgPlanningRepository } from "../app/db/planningRepository.js";

const WRITE_INPUT = {
  actor: { type: "openwebui", id: "openwebui" },
  operation: "create_finance_goal",
  idempotencyKey: "request-1",
  requestHash: "hash-1",
};

function transactionalPool(queryResult) {
  const queries = [];
  const client = {
    async query(sql, params) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      queries.push({ sql: normalized, params });
      return queryResult(normalized, params);
    },
    release() {},
  };
  return {
    queries,
    client,
    pool: {
      async connect() {
        return client;
      },
    },
  };
}

test("a completed atomic planning write bumps the workspace revision before commit", async () => {
  const { pool, queries, client } = transactionalPool(async (sql) => {
    if (sql.startsWith("INSERT INTO plan_idempotency_keys")) {
      return { rows: [{ request_hash: WRITE_INPUT.requestHash }] };
    }
    if (sql.startsWith("UPDATE plan_idempotency_keys")) {
      return { rows: [{ idempotency_key: WRITE_INPUT.idempotencyKey }] };
    }
    if (sql.startsWith("INSERT INTO workspace_read_model_revisions")) {
      return { rows: [{ revision: "9" }] };
    }
    return { rows: [] };
  });
  const publications = [];
  const repository = new PgPlanningRepository(pool, {
    async publishReadModelRevision(publication) {
      assert.equal(publication.client, client);
      publications.push(publication);
    },
  });

  const result = await repository.executePlanWrite(
    "shared",
    WRITE_INPUT,
    async (client) => {
      await client.query("SELECT planning_mutation");
      return { goal_id: "goal-1" };
    },
  );

  assert.deepEqual(result, {
    executed: true,
    response: { goal_id: "goal-1" },
  });
  const statements = queries.map(({ sql }) => sql);
  const completion = statements.findIndex((sql) =>
    sql.startsWith("UPDATE plan_idempotency_keys"),
  );
  const revision = statements.findIndex((sql) =>
    sql.startsWith("INSERT INTO workspace_read_model_revisions"),
  );
  assert.equal(revision > completion, true);
  assert.equal(statements.at(-1), "COMMIT");
  assert.deepEqual(queries[revision].params, ["shared"]);
  assert.deepEqual(publications, [{
    client,
    workspaceId: "shared",
    revision: "9",
    reason: "planning.write",
  }]);
});

test("planning idempotency replays and mismatches do not bump the workspace revision", async () => {
  for (const existing of [
    {
      request_hash: WRITE_INPUT.requestHash,
      response_value: { goal_id: "goal-1" },
    },
    {
      request_hash: "different-hash",
      response_value: { goal_id: "goal-1" },
    },
  ]) {
    const { pool, queries } = transactionalPool(async (sql) => {
      if (sql.startsWith("INSERT INTO plan_idempotency_keys")) {
        return { rows: [] };
      }
      if (sql.startsWith("SELECT request_hash, response_value")) {
        return { rows: [existing] };
      }
      return { rows: [] };
    });
    const repository = new PgPlanningRepository(pool);
    let mutationCalled = false;

    const result = await repository.executePlanWrite(
      "shared",
      WRITE_INPUT,
      async () => {
        mutationCalled = true;
      },
    );

    assert.equal(mutationCalled, false);
    assert.equal(
      queries.some(({ sql }) =>
        sql.startsWith("INSERT INTO workspace_read_model_revisions"),
      ),
      false,
    );
    assert.equal(queries.at(-1).sql, "COMMIT");
    assert.deepEqual(
      result,
      existing.request_hash === WRITE_INPUT.requestHash
        ? { replay: true, response: existing.response_value }
        : { mismatch: true },
    );
  }
});

test("failed planning writes roll back without bumping the workspace revision", async () => {
  const { pool, queries } = transactionalPool(async (sql) => {
    if (sql.startsWith("INSERT INTO plan_idempotency_keys")) {
      return { rows: [{ request_hash: WRITE_INPUT.requestHash }] };
    }
    return { rows: [] };
  });
  const repository = new PgPlanningRepository(pool);

  await assert.rejects(
    repository.executePlanWrite("shared", WRITE_INPUT, async () => {
      throw new Error("mutation failed");
    }),
    /mutation failed/,
  );

  assert.equal(
    queries.some(({ sql }) =>
      sql.startsWith("INSERT INTO workspace_read_model_revisions"),
    ),
    false,
  );
  assert.equal(queries.at(-1).sql, "ROLLBACK");
});

test("a revision bump failure rolls the planning mutation and receipt back together", async () => {
  const { pool, queries } = transactionalPool(async (sql) => {
    if (sql.startsWith("INSERT INTO plan_idempotency_keys")) {
      return { rows: [{ request_hash: WRITE_INPUT.requestHash }] };
    }
    if (sql.startsWith("UPDATE plan_idempotency_keys")) {
      return { rows: [{ idempotency_key: WRITE_INPUT.idempotencyKey }] };
    }
    if (sql.startsWith("INSERT INTO workspace_read_model_revisions")) {
      return { rows: [] };
    }
    return { rows: [] };
  });
  const repository = new PgPlanningRepository(pool);

  await assert.rejects(
    repository.executePlanWrite(
      "shared",
      WRITE_INPUT,
      async (client) => {
        await client.query("SELECT planning_mutation");
        return { goal_id: "goal-1" };
      },
    ),
    /Failed to bump read-model revision/,
  );

  assert.equal(
    queries.some(({ sql }) => sql === "SELECT planning_mutation"),
    true,
  );
  assert.equal(queries.at(-1).sql, "ROLLBACK");
  assert.equal(
    queries.some(({ sql }) => sql === "COMMIT"),
    false,
  );
});

test("a warm enqueue failure rolls the planning mutation and revision back", async () => {
  const { pool, queries, client } = transactionalPool(async (sql) => {
    if (sql.startsWith("INSERT INTO plan_idempotency_keys")) {
      return { rows: [{ request_hash: WRITE_INPUT.requestHash }] };
    }
    if (sql.startsWith("UPDATE plan_idempotency_keys")) {
      return { rows: [{ idempotency_key: WRITE_INPUT.idempotencyKey }] };
    }
    if (sql.startsWith("INSERT INTO workspace_read_model_revisions")) {
      return { rows: [{ revision: "9" }] };
    }
    return { rows: [] };
  });
  const repository = new PgPlanningRepository(pool, {
    async publishReadModelRevision(publication) {
      assert.equal(publication.client, client);
      throw new Error("warm enqueue failed");
    },
  });

  await assert.rejects(
    repository.executePlanWrite(
      "shared",
      WRITE_INPUT,
      async (transactionClient) => {
        await transactionClient.query("SELECT planning_mutation");
        return { goal_id: "goal-1" };
      },
    ),
    /warm enqueue failed/,
  );

  assert.equal(queries.at(-1).sql, "ROLLBACK");
  assert.equal(queries.some(({ sql }) => sql === "COMMIT"), false);
  assert.equal(
    queries.some(({ sql }) =>
      sql.startsWith("INSERT INTO workspace_read_model_revisions"),
    ),
    true,
  );
});
