import test from "node:test";
import assert from "node:assert/strict";
import {
  detectRecurringStreams,
  RecurringService,
} from "../app/services/recurringDetector.js";
import { detectSubscriptionInsights } from "../app/services/insightDetectors.js";

function charge({
  id,
  date,
  amount = -1_999,
  merchant = "Disney Plus",
  displayName,
  account = "account_card",
  category = "ENTERTAINMENT",
  detailed = "ENTERTAINMENT_TV",
}) {
  return {
    id,
    posted_on: date,
    amount_minor: amount,
    currency_code: "USD",
    merchant_name: merchant,
    normalized_merchant: merchant.toLowerCase(),
    name: merchant,
    ...(displayName === undefined
      ? {}
      : { display_name: displayName }),
    account_id: account,
    account_name: account,
    category_primary: category,
    category_detailed: detailed,
    pending: false,
    excluded_from_spending: false,
  };
}

test("classifies repeated discretionary merchants as frequent spending", () => {
  const merchants = [
    ["IHOP", "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"],
    ["Shell Oil", "TRANSPORTATION", "TRANSPORTATION_GAS"],
    ["DoorDash", "FOOD_AND_DRINK", "FOOD_AND_DRINK_DELIVERY_SERVICES"],
    ["Harbor Hotel", "TRAVEL", "TRAVEL_LODGING"],
    ["Target", "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_DEPARTMENT_STORES"],
  ];
  const transactions = merchants.flatMap(
    ([merchant, category, detailed], merchantIndex) =>
      ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"].map(
        (date, index) =>
          charge({
            id: `${merchantIndex}-${index}`,
            date,
            merchant,
            category,
            detailed,
          }),
      ),
  );
  const streams = detectRecurringStreams(transactions, {
    now: new Date("2026-04-05T00:00:00Z"),
  });

  assert.equal(streams.length, merchants.length);
  assert.ok(
    streams.every(
      (stream) => stream.stream_type === "frequent_spending",
    ),
  );
  assert.deepEqual(
    detectSubscriptionInsights(streams, transactions, {
      asOf: new Date("2026-04-05T00:00:00Z"),
    }),
    [],
  );
});

test("recurring detection reads exactly 400 local calendar days", async () => {
  let query;
  const service = new RecurringService({
    repository: {
      async getTransactionsForPeriod(_workspaceId, options) {
        query = options;
        return [];
      },
      async replaceRecurringStreams() {},
      async rebuildSearchDocuments() {},
    },
    now: () => new Date("2026-07-26T12:00:00Z"),
  });

  await service.detectAndStore();

  assert.deepEqual(query, {
    startOn: "2025-06-22",
    endOn: "2026-07-27",
    activeAccountsOnly: true,
  });
});

test("manual patterns claim matching history and suppress overlapping automatic streams", () => {
  const matching = [
    "2026-01-01",
    "2026-02-01",
    "2026-03-01",
    "2026-04-01",
  ].map((date, index) =>
    charge({
      id: `manual-${index}`,
      date,
      merchant: "Disney Plus",
      amount: index === 3 ? -2_099 : -1_999,
    }),
  );
  const transactions = [
    ...matching,
    charge({
      id: "different-account",
      date: "2026-04-01",
      merchant: "Disney Plus",
      account: "account_other",
    }),
    charge({
      id: "different-amount",
      date: "2026-04-01",
      merchant: "Disney Plus",
      amount: -4_999,
    }),
    {
      ...charge({
        id: "pending",
        date: "2026-04-01",
        merchant: "Disney Plus",
      }),
      pending: true,
    },
    {
      ...charge({
        id: "excluded",
        date: "2026-04-01",
        merchant: "Disney Plus",
      }),
      excluded_from_spending: true,
    },
    charge({
      id: "income",
      date: "2026-04-01",
      merchant: "Disney Plus",
      amount: 1_999,
    }),
  ];
  const streams = detectRecurringStreams(transactions, {
    manualPatterns: [
      {
        id: "pattern-1",
        stream_id: "manual-stream-1",
        account_id: "account_card",
        match_field: "normalized_merchant",
        normalized_match_value: "disney plus",
        anchor_amount_minor: 1_999,
        currency_code: "USD",
        stream_type: "bill",
        cadence: "monthly",
        active: true,
      },
    ],
    now: new Date("2026-04-05T00:00:00Z"),
  });

  const manual = streams.find(
    (stream) => stream.id === "manual-stream-1",
  );
  assert.ok(manual);
  assert.equal(manual.stream_type, "bill");
  assert.equal(manual.cadence, "monthly");
  assert.deepEqual(
    manual.transaction_ids,
    matching.map((transaction) => transaction.id),
  );
  assert.equal(
    manual.classification_signals.manual_pattern_rule_id,
    "pattern-1",
  );
  assert.equal(
    streams.filter(
      (stream) =>
        stream.account_id === "account_card" &&
        stream.service_family === "disney+",
    ).length,
    1,
  );
  const fallback = detectRecurringStreams(matching, {
    now: new Date("2026-04-05T00:00:00Z"),
  });
  assert.equal(fallback.length, 1);
  assert.notEqual(fallback[0].id, manual.id);
  assert.equal(fallback[0].stream_type, "subscription");
});

test("recurring service loads active manual patterns before replacement", async () => {
  let stored;
  const service = new RecurringService({
    repository: {
      async getTransactionsForPeriod() {
        return [
          charge({
            id: "source-1",
            date: "2026-07-01",
            merchant: "Apartment Rent",
            amount: -150_000,
          }),
        ];
      },
      async listRecurringPatternRules(_workspaceId, options) {
        assert.deepEqual(options, { activeOnly: true });
        return [
          {
            id: "pattern-rent",
            stream_id: "stream-rent",
            account_id: "account_card",
            match_field: "normalized_merchant",
            normalized_match_value: "apartment rent",
            anchor_amount_minor: 150_000,
            currency_code: "USD",
            stream_type: "bill",
            cadence: "monthly",
            active: true,
          },
        ];
      },
      async replaceRecurringStreams(_workspaceId, streams) {
        stored = streams;
      },
      async rebuildSearchDocuments() {},
    },
    now: () => new Date("2026-07-05T00:00:00Z"),
  });

  await service.detectAndStore();

  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, "stream-rent");
  assert.equal(stored[0].stream_type, "bill");
  assert.deepEqual(stored[0].transaction_ids, ["source-1"]);
});

test("keeps strong subscription and bill signals conservative but useful", () => {
  const netflix = ["2026-01-01", "2026-02-01", "2026-03-01"].map(
    (date, index) =>
      charge({
        id: `netflix-${index}`,
        date,
        merchant: "Netflix",
      }),
  );
  const rent = ["2026-01-02", "2026-02-02", "2026-03-02"].map(
    (date, index) =>
      charge({
        id: `rent-${index}`,
        date,
        merchant: "Apartment Rent",
        amount: -150_000,
        category: "RENT_AND_UTILITIES",
        detailed: "RENT_AND_UTILITIES_RENT",
      }),
  );
  const annual = ["2025-03-15", "2026-03-15"].map((date, index) =>
    charge({
      id: `annual-${index}`,
      date,
      merchant: "Squarespace",
      amount: -20_000,
      category: "GENERAL_SERVICES",
      detailed: "GENERAL_SERVICES_OTHER_GENERAL_SERVICES",
    }),
  );
  const streams = detectRecurringStreams([...netflix, ...rent, ...annual], {
    now: new Date("2026-03-20T00:00:00Z"),
  });

  assert.equal(
    streams.find((stream) => stream.service_family === "netflix")
      .stream_type,
    "subscription",
  );
  assert.equal(
    streams.find((stream) => stream.service_family === "apartment rent")
      .stream_type,
    "bill",
  );
  assert.equal(
    streams.find((stream) => stream.service_family === "squarespace")
      .cadence,
    "annual",
  );
});

test("detects recurrence separately while six biweekly charges are required for subscription classification", () => {
  const monthly = [
    charge({ id: "m1", date: "2026-01-31" }),
    charge({ id: "m2", date: "2026-02-28" }),
    charge({ id: "m3", date: "2026-03-31" }),
  ];
  const biweekly = [
    charge({
      id: "b1",
      date: "2026-01-01",
      merchant: "Gym",
      amount: -2_500,
    }),
    charge({
      id: "b2",
      date: "2026-01-15",
      merchant: "Gym",
      amount: -2_500,
    }),
    charge({
      id: "b3",
      date: "2026-01-29",
      merchant: "Gym",
      amount: -2_500,
    }),
  ];
  const streams = detectRecurringStreams([...monthly, ...biweekly], {
    now: new Date("2026-04-01T00:00:00Z"),
  });
  assert.equal(streams.length, 2);
  assert.equal(new Set(streams.map((stream) => stream.id)).size, 2);
  assert.equal(
    streams.find((stream) => stream.service_family === "disney+").cadence,
    "monthly",
  );
  const gym = streams.find((stream) => stream.service_family === "gym");
  assert.equal(gym.cadence, "biweekly");
  assert.equal(gym.monthly_equivalent_minor, 5_417);
  assert.equal(gym.stream_type, "frequent_spending");

  const qualifiedGym = detectRecurringStreams(
    [
      "2026-01-01",
      "2026-01-15",
      "2026-01-29",
      "2026-02-12",
      "2026-02-26",
      "2026-03-12",
    ].map((date, index) =>
      charge({
        id: `qualified-gym-${index}`,
        date,
        merchant: "Gym",
        amount: -2_500,
      }),
    ),
    { now: new Date("2026-03-20T00:00:00Z") },
  )[0];
  assert.equal(qualifiedGym.stream_type, "subscription");
});

test("unknown merchants need four stable monthly-or-slower occurrences and 75 percent interval fit", () => {
  const stable = detectRecurringStreams(
    ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"].map(
      (date, index) =>
        charge({
          id: `stable-${index}`,
          date,
          merchant: "Acme Service",
          category: "OTHER",
          detailed: "OTHER",
        }),
    ),
    { now: new Date("2026-04-05T00:00:00Z") },
  )[0];
  const poorFit = detectRecurringStreams(
    ["2026-01-01", "2026-01-31", "2026-03-02", "2026-04-11"].map(
      (date, index) =>
        charge({
          id: `poor-fit-${index}`,
          date,
          merchant: "Mystery Service",
          category: "OTHER",
          detailed: "OTHER",
        }),
    ),
    { now: new Date("2026-04-15T00:00:00Z") },
  )[0];

  assert.equal(stable.stream_type, "subscription");
  assert.ok(stable.confidence_basis_points >= 8_500);
  assert.equal(poorFit.cadence, "monthly");
  assert.ok(
    poorFit.classification_signals.interval_fit_basis_points < 7_500,
  );
  assert.equal(poorFit.stream_type, "frequent_spending");
});

test("separates same-merchant amount clusters instead of merging Apple charges", () => {
  const rows = [
    ...["2026-01-01", "2026-02-01", "2026-03-01"].map((date, index) =>
      charge({
        id: `large-${index}`,
        date,
        merchant: "Apple.com/bill",
        amount: -2_803,
      }),
    ),
    ...["2026-01-14", "2026-02-14", "2026-03-14"].map((date, index) =>
      charge({
        id: `small-${index}`,
        date,
        merchant: "Apple Services",
        amount: -999,
      }),
    ),
  ];
  const streams = detectRecurringStreams(rows, {
    now: new Date("2026-03-20T00:00:00Z"),
  });
  assert.equal(streams.length, 2);
  assert.equal(new Set(streams.map((stream) => stream.id)).size, 2);
  assert.deepEqual(
    streams.map((stream) => stream.expected_amount_minor).sort((a, b) => a - b),
    [999, 2_803],
  );
});

test("recurring presentation uses the verbatim effective name without changing raw identity", () => {
  const rows = ["2026-01-01", "2026-02-01", "2026-03-01"].map(
    (date, index) =>
      charge({
        id: `apple-${index}`,
        date,
        merchant: "APPLE.COM/BILL 0042",
        displayName: "apple one+",
      }),
  );

  const stream = detectRecurringStreams(rows, {
    now: new Date("2026-03-20T00:00:00Z"),
  })[0];

  assert.equal(stream.display_name, "apple one+");
  assert.equal(stream.service_family, "apple services");
  assert.deepEqual(stream.transaction_ids, rows.map((row) => row.id));
});

test("possible duplicates require overlapping windows and respect intentional overrides", () => {
  const base = {
    service_family: "streaming",
    display_name: "Streaming",
    stream_type: "subscription",
    cadence: "monthly",
    expected_amount_minor: 2_000,
    monthly_equivalent_minor: 2_000,
    currency_code: "USD",
    confidence_basis_points: 9_000,
    status: "active",
    duplicate_state: "unknown",
    first_seen_on: "2026-01-01",
    last_seen_on: "2026-07-01",
    transaction_ids: [],
  };
  const overlapping = [
    { ...base, id: "one", account_id: "account_one" },
    {
      ...base,
      id: "two",
      account_id: "account_two",
      display_name: "Streaming Plus",
      last_seen_on: "2026-07-15",
    },
  ];
  let findings = detectSubscriptionInsights(overlapping, [], {
    asOf: new Date("2026-07-26T00:00:00Z"),
  });
  assert.ok(
    findings.some((finding) => finding.type === "possible_duplicate"),
  );

  findings = detectSubscriptionInsights(
    [
      overlapping[0],
      {
        ...overlapping[1],
        last_seen_on: "2026-04-01",
      },
    ],
    [],
    { asOf: new Date("2026-07-26T00:00:00Z") },
  );
  assert.ok(
    !findings.some((finding) => finding.type === "possible_duplicate"),
  );

  findings = detectSubscriptionInsights(
    [
      overlapping[0],
      { ...overlapping[1], duplicate_state: "not_duplicate" },
    ],
    [],
    { asOf: new Date("2026-07-26T00:00:00Z") },
  );
  assert.ok(
    !findings.some((finding) => finding.type === "possible_duplicate"),
  );
});

test("duplicate evidence includes charged accounts, recent amounts, annual cost, and transaction IDs", () => {
  const transactions = [
    charge({
      id: "one-charge",
      date: "2026-07-01",
      account: "account_one",
    }),
    charge({
      id: "two-charge",
      date: "2026-07-15",
      account: "account_two",
    }),
  ];
  const stream = {
    service_family: "disney+",
    display_name: "Disney+",
    stream_type: "subscription",
    cadence: "monthly",
    expected_amount_minor: 1_999,
    monthly_equivalent_minor: 1_999,
    currency_code: "USD",
    confidence_basis_points: 9_000,
    status: "active",
    duplicate_state: "unknown",
    first_seen_on: "2026-01-01",
  };
  const findings = detectSubscriptionInsights(
    [
      {
        ...stream,
        id: "one",
        account_id: "account_one",
        last_seen_on: "2026-07-01",
        transaction_ids: ["one-charge"],
      },
      {
        ...stream,
        id: "two",
        display_name: "Disney Plus",
        account_id: "account_two",
        last_seen_on: "2026-07-15",
        transaction_ids: ["two-charge"],
      },
    ],
    transactions,
    { asOf: new Date("2026-07-26T00:00:00Z") },
  );
  const duplicate = findings.find(
    (finding) => finding.type === "possible_duplicate",
  );
  assert.deepEqual(duplicate.metrics.charged_account_ids.sort(), [
    "account_one",
    "account_two",
  ]);
  assert.equal(duplicate.metrics.combined_annual.amount_minor, 47_976);
  assert.equal(duplicate.metrics.recent_amounts.length, 2);
  assert.ok(
    duplicate.evidence.some(
      (entry) =>
        entry.entity_type === "transaction" &&
        entry.entity_id === "one-charge",
    ),
  );
  assert.match(
    duplicate.actions.find((action) => action.type === "confirm")
      .web_url,
    /^https:\/\/money\.example\.com\/insights\?finding=/,
  );
});

test("subscription price increase triggers only at both $5 and 10 percent", () => {
  const transactions = [
    charge({ id: "t1", date: "2026-04-01", amount: -5_000 }),
    charge({ id: "t2", date: "2026-05-01", amount: -5_000 }),
    charge({ id: "t3", date: "2026-06-01", amount: -5_000 }),
    charge({ id: "t4", date: "2026-07-01", amount: -5_500 }),
  ];
  const stream = {
    id: "stream",
    service_family: "disney+",
    display_name: "Disney+",
    stream_type: "subscription",
    cadence: "monthly",
    account_id: "account",
    expected_amount_minor: 5_500,
    monthly_equivalent_minor: 5_500,
    currency_code: "USD",
    confidence_basis_points: 9_500,
    status: "active",
    duplicate_state: "unknown",
    first_seen_on: "2026-04-01",
    last_seen_on: "2026-07-01",
    transaction_ids: transactions.map((item) => item.id),
  };
  const findings = detectSubscriptionInsights([stream], transactions, {
    asOf: new Date("2026-07-26T00:00:00Z"),
  });
  const increase = findings.find(
    (finding) => finding.type === "price_increase",
  );
  assert.ok(increase);
  assert.equal(increase.metrics.change.amount_minor, 500);
  assert.equal(
    increase.actions.find((action) => action.type === "review").web_url,
    "https://money.example.com/recurring?item=stream",
  );
  assert.equal(
    increase.evidence.find((entry) => entry.entity_type === "recurring")
      .web_url,
    "https://money.example.com/recurring?item=stream",
  );
});

test("subscription lifecycle ignores bills and non-USD streams", () => {
  const base = {
    display_name: "Fresh stream",
    cadence: "monthly",
    expected_amount_minor: 6_000,
    monthly_equivalent_minor: 6_000,
    confidence_basis_points: 9_000,
    status: "active",
    duplicate_state: "unknown",
    first_seen_on: "2026-07-10",
    last_seen_on: "2026-07-10",
    transaction_ids: [],
  };
  const findings = detectSubscriptionInsights(
    [
      {
        ...base,
        id: "bill",
        service_family: "rent",
        stream_type: "bill",
        currency_code: "USD",
      },
      {
        ...base,
        id: "foreign",
        service_family: "foreign",
        stream_type: "subscription",
        currency_code: "EUR",
      },
    ],
    [],
    { asOf: new Date("2026-07-26T00:00:00Z") },
  );
  assert.deepEqual(findings, []);
});

test("disabled expensive-subscription rule preserves other findings", () => {
  const stream = {
    id: "subscription",
    service_family: "service",
    display_name: "Service",
    stream_type: "subscription",
    cadence: "monthly",
    expected_amount_minor: 8_000,
    monthly_equivalent_minor: 8_000,
    currency_code: "USD",
    confidence_basis_points: 9_000,
    status: "active",
    duplicate_state: "unknown",
    first_seen_on: "2026-07-10",
    last_seen_on: "2026-07-10",
    transaction_ids: [],
  };
  const findings = detectSubscriptionInsights([stream], [], {
    asOf: new Date("2026-07-26T00:00:00Z"),
    expensiveEnabled: false,
  });
  assert.ok(!findings.some((finding) => finding.type === "expensive"));
  assert.ok(findings.some((finding) => finding.type === "new"));
});
