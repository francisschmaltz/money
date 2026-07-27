import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCreditScoreSummary,
  CREDIT_SCORE_PRESETS,
} from "../app/services/creditScoreTracking.js";

const members = [
  { id: "person_1", display_name: "Alex" },
  { id: "person_2", display_name: "Blair" },
];

function source(id, userId, overrides = {}) {
  return {
    id,
    user_id: userId,
    label: id,
    bureau: null,
    model: null,
    archived_on: null,
    ...overrides,
  };
}

function observation(id, sourceId, observedOn, score) {
  return {
    id,
    source_id: sourceId,
    observed_on: observedOn,
    score,
  };
}

test("source averages update over time while household members stay equally weighted", () => {
  const result = buildCreditScoreSummary({
    members,
    sources: [
      source("alex_1", "person_1"),
      source("alex_2", "person_1"),
      source("blair_1", "person_2"),
    ],
    observations: [
      observation("a1_old", "alex_1", "2026-01-01", 700),
      observation("a1_new", "alex_1", "2026-07-20", 800),
      observation("a2", "alex_2", "2026-01-01", 800),
      observation("b1", "blair_1", "2026-01-01", 600),
    ],
    currentOn: "2026-07-27",
    period: "1y",
  });

  assert.equal(result.people[0].average_score, 800);
  assert.equal(result.people[0].latest_observed_on, "2026-07-20");
  assert.equal(result.people[1].average_score, 600);
  assert.equal(result.household.average_score, 700);
  assert.notEqual(result.household.average_score, Math.round(2_200 / 3));
  assert.deepEqual(
    result.history.map((point) => [point.date, point.average_score]),
    [
      ["2026-01-01", 675],
      ["2026-07-20", 700],
      ["2026-07-27", 700],
    ],
  );
  assert.equal(result.household.change, 25);
});

test("stale scores remain included and duplicate bureau-model sources warn", () => {
  const result = buildCreditScoreSummary({
    members,
    sources: [
      source("alex_1", "person_1", {
        bureau: "Experian",
        model: "FICO Score 8",
      }),
      source("alex_2", "person_1", {
        bureau: "Experian",
        model: "FICO Score 8",
      }),
    ],
    observations: [
      observation("a1", "alex_1", "2026-04-27", 710),
      observation("a2", "alex_2", "2026-07-20", 730),
    ],
    currentOn: "2026-07-27",
  });

  assert.equal(result.household.average_score, 720);
  assert.equal(result.household.stale_source_count, 1);
  assert.equal(result.people[0].sources[0].stale, true);
  assert.equal(result.people[0].possible_duplicate_source_count, 2);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ["stale_credit_scores", "possible_duplicate_score_sources"],
  );
});

test("archiving removes a source from current averages without rewriting history", () => {
  const result = buildCreditScoreSummary({
    members: [members[0]],
    sources: [
      source("kept", "person_1"),
      source("archived", "person_1", {
        archived_on: "2026-07-01",
      }),
    ],
    observations: [
      observation("kept_score", "kept", "2026-01-01", 700),
      observation("archived_score", "archived", "2026-01-01", 800),
    ],
    currentOn: "2026-07-27",
    period: "1y",
  });

  assert.equal(result.household.average_score, 700);
  assert.deepEqual(
    result.history.map((point) => [point.date, point.average_score]),
    [
      ["2026-01-01", 750],
      ["2026-07-01", 700],
      ["2026-07-27", 700],
    ],
  );
});

test("history is bounded and MCP output removes names and mutation controls", () => {
  const observations = Array.from({ length: 120 }, (_, index) => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    date.setUTCDate(date.getUTCDate() + index);
    return observation(
      `observation_${index}`,
      "alex_1",
      date.toISOString().slice(0, 10),
      700 + (index % 20),
    );
  });
  const result = buildCreditScoreSummary({
    members,
    sources: [source("alex_1", "person_1")],
    observations,
    currentOn: "2026-07-27",
    period: "all",
    currentUserId: "person_1",
    forMcp: true,
  });

  assert.equal(result.history.length, 80);
  assert.equal(result.people[0].person_label, "Person 1");
  assert.equal(Object.hasOwn(result.people[0], "person_name"), false);
  assert.equal(Object.hasOwn(result.people[0], "can_manage"), false);
  assert.doesNotMatch(JSON.stringify(result), /Alex|Blair/);
});

test("credit score presets include every supported provider and custom", () => {
  assert.deepEqual(
    CREDIT_SCORE_PRESETS.map((preset) => preset.key),
    [
      "american_express",
      "credit_karma_equifax",
      "credit_karma_transunion",
      "equifax",
      "experian",
      "transunion",
      "myfico",
      "custom",
    ],
  );
});
