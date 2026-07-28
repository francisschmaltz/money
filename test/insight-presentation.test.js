import test from "node:test";
import assert from "node:assert/strict";

import {
  insightBucket,
  lifecycleLabel,
  presentInsightForWeb,
} from "../app/services/insightPresentation.js";

test("weekly presentation leads with an action and keeps the supplied comparison", () => {
  const insight = presentInsightForWeb(
    {
      id: "finding_dining",
      family: "weekly",
      type: "spend_less",
      title: "Spending rose in Dining",
      explanation: "Dining increased week over week.",
      metrics: {
        current: { amount_minor: 75_000, currency: "USD" },
        previous: { amount_minor: 50_000, currency: "USD" },
        change: { amount_minor: 25_000, currency: "USD" },
      },
      actions: [
        {
          type: "review",
          label: "Review",
          web_url: "https://money.example.com/transactions?category=Dining",
        },
      ],
    },
    {
      timeframe: "Jul 20–26 vs Jul 13–19",
    },
  );

  assert.equal(insight.actionTitle, "Spend less on Dining");
  assert.equal(insight.timeframe, "Jul 20–26 vs Jul 13–19");
  assert.equal(
    insight.detail,
    "You spent $250.00 more in this area than in the prior period: $750.00 versus $500.00.",
  );
  assert.deepEqual(insight.solveAction, {
    type: "link",
    label: "Review spending",
    webUrl: "/transactions?category=Dining",
  });
  assert.equal(insight.bucket, "spend_less");
});

test("stored insight evidence repairs stale review links at presentation time", () => {
  const oneCharge = presentInsightForWeb({
    id: "finding_ohgane_once",
    family: "weekly",
    type: "needs_review",
    title: "Ohgane charge needs a look",
    evidence: [
      {
        entity_type: "transaction",
        entity_id: "txn_ohgane_1",
        label: "Ohgane",
        web_url: "/transactions",
      },
    ],
    actions: [
      {
        type: "review",
        label: "Review",
        web_url: "/transactions",
      },
    ],
  });

  assert.equal(
    oneCharge.solveAction.webUrl,
    "/transactions?transaction=txn_ohgane_1",
  );
  assert.equal(
    oneCharge.evidence[0].web_url,
    "/transactions?transaction=txn_ohgane_1",
  );

  const merchantSpending = presentInsightForWeb({
    id: "finding_ohgane_spending",
    family: "weekly",
    type: "spend_less",
    title: "Spending rose at Ohgane",
    period_start: "2026-07-20",
    period_end: "2026-07-27",
    evidence: [
      {
        entity_type: "transaction",
        entity_id: "txn_ohgane_1",
        label: "Ohgane",
      },
      {
        entity_type: "transaction",
        entity_id: "txn_ohgane_2",
        label: "Ohgane",
      },
    ],
    actions: [
      {
        type: "review",
        label: "Review",
        web_url: "/transactions",
      },
    ],
  });

  assert.equal(merchantSpending.actionTitle, "Spend less at Ohgane");
  assert.equal(
    merchantSpending.solveAction.webUrl,
    "/transactions?q=Ohgane&start=2026-07-20&end=2026-07-27",
  );
});

test("multi-object evidence stays on the insight detail instead of choosing an arbitrary item", () => {
  const insight = presentInsightForWeb({
    id: "finding_two_merchants",
    family: "weekly",
    type: "better_habits",
    title: "Similar dining purchases clustered",
    evidence: [
      {
        entity_type: "transaction",
        entity_id: "txn_ohgane",
        label: "Ohgane",
      },
      {
        entity_type: "transaction",
        entity_id: "txn_ihop",
        label: "IHOP",
      },
    ],
    actions: [
      {
        type: "review",
        label: "Review",
        web_url: "/transactions",
      },
    ],
  });

  assert.equal(
    insight.solveAction.webUrl,
    "/insights?finding=finding_two_merchants",
  );
  assert.deepEqual(
    insight.evidence.map((entry) => entry.web_url),
    [
      "/transactions?transaction=txn_ohgane",
      "/transactions?transaction=txn_ihop",
    ],
  );
});

test("recurring and holding evidence use their canonical object dialogs", () => {
  const recurring = presentInsightForWeb({
    id: "finding_subscription",
    family: "subscriptions",
    type: "expensive",
    title: "Example is an expensive subscription",
    evidence: [
      {
        entity_type: "recurring_stream",
        entity_id: "stream_example",
        label: "Example",
        web_url: "/recurring?stream=stream_example",
      },
      {
        entity_type: "transaction",
        entity_id: "txn_example",
        label: "Example",
      },
    ],
  });
  const holding = presentInsightForWeb({
    id: "finding_holding",
    family: "investments",
    type: "concentration",
    title: "VTI is a concentrated position",
    evidence: [
      {
        entity_type: "holding",
        entity_id: "security_vti",
        label: "VTI",
        web_url: "/portfolio",
      },
    ],
  });

  assert.equal(recurring.solveAction.webUrl, "/recurring?item=stream_example");
  assert.equal(holding.solveAction.webUrl, "/portfolio?holding=VTI");
});

test("investment statistics become context while real risks stay actionable", () => {
  assert.equal(
    insightBucket({ family: "investments", type: "performance" }),
    "context",
  );
  const concentration = presentInsightForWeb({
    family: "investments",
    type: "concentration",
    title: "VTI is a concentrated position",
    metrics: { allocation_basis_points: 3_100 },
    rule: { threshold_basis_points: 2_500 },
  });

  assert.equal(concentration.actionTitle, "Review VTI concentration");
  assert.equal(concentration.bucket, "investment_risk");
  assert.match(concentration.detail, /31\.0%/);
  assert.match(concentration.detail, /not a trade recommendation/);
});

test("subscription and lifecycle language stays direct", () => {
  const duplicate = presentInsightForWeb({
    family: "subscriptions",
    type: "possible_duplicate",
    title: "Possible duplicate Apple subscriptions",
    state: "bad",
    metrics: {
      service: "Apple",
      combined_monthly: { amount_minor: 3_800, currency: "USD" },
      combined_annual: { amount_minor: 45_600, currency: "USD" },
    },
  });

  assert.equal(
    duplicate.actionTitle,
    "Check whether you need both Apple subscriptions",
  );
  assert.equal(duplicate.bucket, "review_now");
  assert.equal(duplicate.lifecycleLabel, "Incorrect");
  assert.equal(lifecycleLabel("archived"), "Archived");
});
