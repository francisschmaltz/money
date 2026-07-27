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
  assert.equal(duplicate.lifecycleLabel, "Marked bad");
  assert.equal(lifecycleLabel("archived"), "Archived");
});
