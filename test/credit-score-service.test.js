import assert from "node:assert/strict";
import test from "node:test";

import { createFinanceService } from "../app/services/financeService.js";

function repository(overrides = {}) {
  return {
    async getDataFreshness() {
      return {
        data_as_of: "2026-07-27T00:00:00.000Z",
        partial: false,
        warnings: [],
      };
    },
    async listWorkspaceMembers() {
      return [
        { id: "person_1", display_name: "Alex" },
        { id: "person_2", display_name: "Blair" },
      ];
    },
    async listCreditScoreSources() {
      return [];
    },
    async listCreditScoreObservations() {
      return [];
    },
    ...overrides,
  };
}

test("credit score service exposes shared reads without MCP PII", async () => {
  const service = createFinanceService({
    repository: repository({
      async listCreditScoreSources() {
        return [
          {
            id: "source_1",
            user_id: "person_1",
            label: "Experian",
            bureau: "Experian",
            model: "FICO Score 8",
          },
        ];
      },
      async listCreditScoreObservations() {
        return [
          {
            id: "observation_1",
            source_id: "source_1",
            observed_on: "2026-07-20",
            score: 740,
          },
        ];
      },
    }),
    now: () => new Date("2026-07-27T12:00:00.000Z"),
  });

  const web = await service.getCreditScoreSummary({
    current_user_id: "person_1",
  });
  assert.equal(web.data.people[0].person_name, "Alex");
  assert.equal(web.data.people[0].can_manage, true);

  const mcp = await service.getCreditScoreSummary({
    audience: "mcp",
  });
  assert.equal(mcp.data.people[0].person_label, "Person 1");
  assert.equal(Object.hasOwn(mcp.data.people[0], "person_name"), false);
  assert.doesNotMatch(JSON.stringify(mcp.data), /Alex|Blair/);
});

test("credit score mutations enforce ownership and reject future observations", async () => {
  let observationWrites = 0;
  const service = createFinanceService({
    repository: repository({
      async updateCreditScoreSource() {
        return null;
      },
      async getCreditScoreSource() {
        return {
          id: "source_2",
          user_id: "person_2",
          label: "TransUnion",
        };
      },
      async upsertCreditScoreObservation() {
        observationWrites += 1;
        return {};
      },
    }),
    now: () => new Date("2026-07-27T12:00:00.000Z"),
  });

  await assert.rejects(
    service.updateCreditScoreSource(
      { source_id: "source_2", label: "Nope" },
      { id: "person_1" },
    ),
    (error) => error.statusCode === 403,
  );
  await assert.rejects(
    service.upsertCreditScoreObservation(
      {
        source_id: "source_2",
        observed_on: "2026-07-28",
        score: 700,
      },
      { id: "person_1" },
    ),
    (error) => error.statusCode === 400,
  );
  assert.equal(observationWrites, 0);
});

test("same-day score corrections use the repository upsert path", async () => {
  const writes = [];
  const service = createFinanceService({
    repository: repository({
      async upsertCreditScoreObservation(_workspaceId, input) {
        writes.push(input);
        return {
          id: "observation_1",
          source_id: input.sourceId,
          observed_on: input.observedOn,
          score: input.score,
        };
      },
    }),
    now: () => new Date("2026-07-27T12:00:00.000Z"),
  });

  await service.upsertCreditScoreObservation(
    {
      source_id: "source_1",
      observed_on: "2026-07-20",
      score: 740,
    },
    { id: "person_1" },
  );
  await service.upsertCreditScoreObservation(
    {
      source_id: "source_1",
      observed_on: "2026-07-20",
      score: 745,
    },
    { id: "person_1" },
  );

  assert.equal(writes.length, 2);
  assert.deepEqual(
    writes.map((write) => write.score),
    [740, 745],
  );
});
