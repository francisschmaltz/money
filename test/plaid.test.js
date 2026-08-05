import test from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PlaidApiError,
  PlaidProvider,
} from "../app/providers/plaidProvider.js";
import {
  normalizePlaidTransaction,
  normalizeTransactionName,
  amountToMinor,
} from "../app/providers/plaidNormalizer.js";
import { PlaidSyncService } from "../app/services/plaidSyncService.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Plaid Link initial mode requests consent and update mode omits products", async () => {
  const requests = [];
  const provider = new PlaidProvider({
    clientId: "client-id",
    secret: "secret",
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return jsonResponse({
        link_token: `link-${requests.length}`,
        expiration: "2026-08-01T00:00:00Z",
      });
    },
  });
  await provider.createLinkToken({
    userId: "user",
    redirectUri: "https://money.example.com/plaid/oauth",
  });
  await provider.createLinkToken({
    userId: "user",
    accessToken: "access-update-token",
    redirectUri: "https://money.example.com/plaid/oauth",
  });
  assert.deepEqual(requests[0].products, ["transactions"]);
  assert.deepEqual(requests[0].additional_consented_products, [
    "investments",
    "liabilities",
  ]);
  assert.deepEqual(requests[0].transactions, { days_requested: 365 });
  assert.equal(
    requests[0].redirect_uri,
    "https://money.example.com/plaid/oauth",
  );
  assert.equal(requests[0].access_token, undefined);
  assert.equal(requests[1].access_token, "access-update-token");
  assert.equal(requests[1].products, undefined);
  assert.equal(requests[1].additional_consented_products, undefined);
  assert.equal(requests[1].transactions, undefined);
  assert.equal(
    requests[1].redirect_uri,
    "https://money.example.com/plaid/oauth",
  );
});

test("Plaid OAuth return resumes the original Link token", async () => {
  const script = await readFile(
    fileURLToPath(new URL("../app/public/js/money.js", import.meta.url)),
    "utf8",
  );

  assert.match(script, /money\.plaid\.oauth/);
  assert.match(script, /receivedRedirectUri: receivedUrl\.href/);
  assert.match(script, /session\.item_id/);
  assert.match(script, /claimOauthSession\(token\)/);
});

test("transaction sync restarts from the original cursor after pagination mutation", async () => {
  let call = 0;
  const cursors = [];
  const provider = new PlaidProvider({
    clientId: "client-id",
    secret: "secret",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      cursors.push(body.cursor);
      call += 1;
      if (call === 1) {
        return jsonResponse({
          added: [{ transaction_id: "discarded" }],
          modified: [],
          removed: [],
          has_more: true,
          next_cursor: "mutated-cursor",
        });
      }
      if (call === 2) {
        return jsonResponse(
          {
            error_code:
              "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
            error_message: "restart",
          },
          400,
        );
      }
      return jsonResponse({
        added: [{ transaction_id: "kept" }],
        modified: [],
        removed: [],
        has_more: false,
        next_cursor: "final-cursor",
      });
    },
  });
  const result = await provider.syncTransactions("access", "original");
  assert.deepEqual(cursors, ["original", "mutated-cursor", "original"]);
  assert.deepEqual(
    result.added.map((item) => item.transaction_id),
    ["kept"],
  );
});

test("Plaid holdings can be fetched without waiting for investment history", async () => {
  const paths = [];
  const provider = new PlaidProvider({
    clientId: "client-id",
    secret: "secret",
    fetchImpl: async (url) => {
      paths.push(new URL(url).pathname);
      return jsonResponse({
        accounts: [],
        holdings: [{ account_id: "retirement" }],
        securities: [],
      });
    },
  });

  const result = await provider.getInvestmentHoldings("access-token");

  assert.equal(result.holdings.length, 1);
  assert.deepEqual(paths, ["/investments/holdings/get"]);
});

test("Plaid investment history initializes asynchronously on its first page", async () => {
  const requests = [];
  const provider = new PlaidProvider({
    clientId: "client-id",
    secret: "secret",
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      const offset = request.options.offset;
      return jsonResponse({
        accounts: [],
        securities: [],
        investment_transactions: [
          { investment_transaction_id: `transaction-${offset}` },
        ],
        total_investment_transactions: 2,
      });
    },
  });

  const result = await provider.getInvestmentTransactions("access-token", {
    startDate: "2024-08-05",
    endDate: "2026-08-05",
  });

  assert.equal(result.investmentTransactions.length, 2);
  assert.deepEqual(requests.map((request) => request.options), [
    { count: 500, offset: 0, async_update: true },
    { count: 500, offset: 1 },
  ]);
});

test("Plaid fetch aborts expose a stable retryable timeout error", async () => {
  for (const name of ["TimeoutError", "AbortError"]) {
    for (const phase of ["fetch", "response body"]) {
      const transportError = new Error(
        "transport details must not escape",
      );
      transportError.name = name;
      const provider = new PlaidProvider({
        clientId: "client-id",
        secret: "secret",
        fetchImpl: async () => {
          if (phase === "fetch") throw transportError;
          return {
            ok: true,
            status: 200,
            async json() {
              throw transportError;
            },
          };
        },
      });

      await assert.rejects(
        provider.getAccounts("access-token"),
        (error) =>
          error instanceof PlaidApiError &&
          error.message === "Plaid request timed out" &&
          error.errorType === "API_ERROR" &&
          error.code === "PLAID_REQUEST_TIMEOUT" &&
          error.requiresReauth === false &&
          error.retryable === true,
        `${name} during ${phase}`,
      );
    }
  }
});

test("normalizer uses signed minor units and pending replacement IDs", () => {
  assert.equal(amountToMinor(12.345, "USD"), 1_235);
  assert.equal(amountToMinor(1_234, "JPY"), 1_234);
  assert.equal(amountToMinor(1.234, "BHD"), 1_234);
  const normalized = normalizePlaidTransaction({
    transaction_id: "posted",
    pending_transaction_id: "pending",
    account_id: "account",
    amount: 12.34,
    iso_currency_code: "USD",
    name: "Store",
    date: "2026-07-26",
    pending: false,
    personal_finance_category: {
      primary: "GENERAL_MERCHANDISE",
      detailed: "GENERAL_MERCHANDISE_OTHER",
    },
  });
  assert.equal(normalized.amount_minor, -1_234);
  assert.equal(normalized.provider_pending_transaction_id, "pending");
  assert.equal(normalized.normalized_name, "store");
  assert.equal(normalized.cash_flow_role, "spending");
  assert.equal(normalized.excluded_from_spending, false);
});

test("normalizer assigns cash-flow roles from specific Plaid categories", () => {
  const cases = [
    ["TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER", "transfer"],
    ["TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER", "transfer"],
    [
      "LOAN_PAYMENTS",
      "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
      "transfer",
    ],
    ["LOAN_PAYMENTS", "LOAN_PAYMENTS_CAR_PAYMENT", "obligation"],
    [
      "LOAN_PAYMENTS",
      "LOAN_PAYMENTS_MORTGAGE_PAYMENT",
      "obligation",
    ],
    [
      "LOAN_PAYMENTS",
      "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT",
      "obligation",
    ],
    [
      "LOAN_PAYMENTS",
      "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT",
      "obligation",
    ],
    ["RENT_AND_UTILITIES", "RENT_AND_UTILITIES_RENT", "obligation"],
    [
      "LOAN_PAYMENTS",
      "LOAN_PAYMENTS_OTHER_PAYMENT",
      "spending",
    ],
    [
      "RENT_AND_UTILITIES",
      "RENT_AND_UTILITIES_TELEPHONE",
      "spending",
    ],
    ["GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_OTHER", "spending"],
  ];

  for (const [primary, detailed, expectedRole] of cases) {
    const normalized = normalizePlaidTransaction({
      transaction_id: `${primary}:${detailed}`,
      account_id: "account",
      amount: 10,
      iso_currency_code: "USD",
      name: detailed,
      date: "2026-08-01",
      personal_finance_category: { primary, detailed },
    });
    assert.equal(
      normalized.cash_flow_role,
      expectedRole,
      `${primary}/${detailed}`,
    );
    assert.equal(
      normalized.excluded_from_spending,
      expectedRole !== "spending",
      `${primary}/${detailed} compatibility exclusion`,
    );
  }
});

test("normalizer treats only clearly named extra-principal loan payments as transfers", () => {
  for (const name of [
    "Extra principal payment",
    "Additional principal paydown",
    "Principal-only payment",
  ]) {
    const normalized = normalizePlaidTransaction({
      transaction_id: name,
      account_id: "account",
      amount: 250,
      iso_currency_code: "USD",
      name,
      date: "2026-08-01",
      personal_finance_category: {
        primary: "LOAN_PAYMENTS",
        detailed: "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT",
      },
    });
    assert.equal(normalized.cash_flow_role, "transfer", name);
    assert.equal(normalized.excluded_from_spending, true, name);
  }

  const ambiguous = normalizePlaidTransaction({
    transaction_id: "ambiguous-loan-payment",
    account_id: "account",
    amount: 250,
    iso_currency_code: "USD",
    name: "Loan payment",
    date: "2026-08-01",
    personal_finance_category: {
      primary: "LOAN_PAYMENTS",
      detailed: "LOAN_PAYMENTS_OTHER_PAYMENT",
    },
  });
  assert.equal(ambiguous.cash_flow_role, "spending");
  assert.equal(ambiguous.excluded_from_spending, false);
});

test("normalizer preserves real transaction precision without inventing midnight", () => {
  const precise = normalizePlaidTransaction({
    transaction_id: "precise",
    account_id: "account",
    amount: 12.34,
    iso_currency_code: "USD",
    name: "Store",
    authorized_date: "2026-07-26",
    authorized_datetime: "2026-07-26T20:34:00Z",
    date: "2026-07-27",
    datetime: "2026-07-27T15:10:09Z",
  });
  const dateOnly = normalizePlaidTransaction({
    transaction_id: "date-only",
    account_id: "account",
    amount: 5,
    iso_currency_code: "USD",
    name: "Date only",
    authorized_date: "2026-07-26",
    date: "2026-07-27",
  });

  assert.equal(precise.authorized_on, "2026-07-26");
  assert.equal(precise.authorized_at, "2026-07-26T20:34:00Z");
  assert.equal(precise.posted_at, "2026-07-27T15:10:09Z");
  assert.equal(dateOnly.authorized_on, "2026-07-26");
  assert.equal(dateOnly.authorized_at, null);
  assert.equal(dateOnly.posted_at, null);
});

test("Plaid locations keep useful address data and only valid coordinate pairs", () => {
  const normalizeLocation = (location) =>
    normalizePlaidTransaction({
      transaction_id: "location-test",
      account_id: "account",
      amount: 1,
      name: "Store",
      date: "2026-07-27",
      location,
    }).provider_location;
  assert.deepEqual(
    normalizeLocation({
      address: " 123 Main St ",
      city: "New York",
      region: "NY",
      postal_code: "10001",
      country: "US",
      lat: 40.7505,
      lon: -73.9934,
      store_number: " 42 ",
    }),
    {
      address: "123 Main St",
      city: "New York",
      region: "NY",
      postal_code: "10001",
      country: "US",
      lat: 40.7505,
      lon: -73.9934,
      store_number: "42",
    },
  );
  assert.deepEqual(
    normalizeLocation({
      address: "123 Main St",
      lat: 40.7,
    }),
    {
      address: "123 Main St",
      city: null,
      region: null,
      postal_code: null,
      country: null,
      lat: null,
      lon: null,
      store_number: null,
    },
  );
  assert.deepEqual(
    normalizeLocation({
      city: "New York",
      lat: 91,
      lon: -73.9,
    }),
    {
      address: null,
      city: "New York",
      region: null,
      postal_code: null,
      country: null,
      lat: null,
      lon: null,
      store_number: null,
    },
  );
  assert.equal(normalizeLocation({}), null);
  assert.equal(normalizeLocation(null), null);

  const cleared = normalizePlaidTransaction({
    transaction_id: "no-location",
    account_id: "account",
    amount: 1,
    name: "Store",
    date: "2026-07-27",
    location: null,
  });
  assert.equal(cleared.provider_location, null);
});

test("transaction names normalize for stable fuzzy matching", () => {
  assert.equal(
    normalizeTransactionName("  Café Nørth #482910  "),
    "cafe n rth",
  );
  assert.equal(normalizeTransactionName("APPLE.COM/BILL 0042"), "apple com bill");
});

test("normalizer promotes Plaid bank fees without treating earned interest as spending fees", () => {
  const fee = normalizePlaidTransaction({
    transaction_id: "fee",
    account_id: "account",
    amount: 35,
    iso_currency_code: "USD",
    name: "Overdraft fee",
    date: "2026-07-26",
    personal_finance_category: {
      primary: "BANK_FEES",
      detailed: "BANK_FEES_OVERDRAFT",
    },
  });
  const earnedInterest = normalizePlaidTransaction({
    transaction_id: "interest",
    account_id: "account",
    amount: -2.5,
    iso_currency_code: "USD",
    name: "Interest earned",
    date: "2026-07-26",
    personal_finance_category: {
      primary: "INCOME",
      detailed: "INCOME_INTEREST_EARNED",
    },
  });

  assert.equal(fee.category_primary, "Fees & Interest");
  assert.equal(fee.category_detailed, "BANK_FEES_OVERDRAFT");
  assert.equal(earnedInterest.category_primary, "INCOME");
});

test("sync service keeps credentials at the secret boundary and preserves pending replacement", async () => {
  let applied;
  const states = [];
  const repository = {
    async getPlaidItem() {
      return {
        id: "local-item",
        workspace_id: "shared",
        institution_name: "Bank",
        transactions_cursor: "cursor-old",
        status: "active",
      };
    },
    async startSyncRun() {
      return "run";
    },
    async updatePlaidItemState(_id, state) {
      states.push(state);
    },
    async upsertAccounts() {},
    async deactivateMissingAccounts() {},
    async applyTransactionSync(value) {
      applied = value;
    },
    async takeDailySnapshots() {},
    async rebuildSearchDocuments() {},
    async finishSyncRun() {},
  };
  const provider = {
    async getAccounts() {
      return {
        accounts: [
          {
            account_id: "provider-account",
            name: "Checking",
            type: "depository",
            subtype: "checking",
            balances: {
              current: 100,
              available: 90,
              iso_currency_code: "USD",
            },
          },
        ],
      };
    },
    async syncTransactions(accessToken, cursor) {
      assert.equal(accessToken, "runtime-access-token");
      assert.equal(cursor, "cursor-old");
      return {
        added: [
          {
            transaction_id: "posted",
            pending_transaction_id: "pending",
            account_id: "provider-account",
            amount: 12.34,
            iso_currency_code: "USD",
            name: "Store",
            date: "2026-07-26",
            pending: false,
          },
        ],
        modified: [],
        removed: [],
        nextCursor: "cursor-new",
      };
    },
  };
  const secretRepository = {
    async get() {
      return "runtime-access-token";
    },
  };
  const service = new PlaidSyncService({
    provider,
    repository,
    secretRepository,
    now: () => new Date("2026-07-26T12:00:00Z"),
  });
  const stats = await service.syncItem("local-item");
  assert.equal(applied.added[0].amount_minor, -1_234);
  assert.equal(
    applied.added[0].provider_pending_transaction_id,
    "pending",
  );
  assert.equal(applied.cursor, "cursor-new");
  assert.equal(Object.hasOwn(applied, "syncedAt"), false);
  assert.equal(JSON.stringify(stats).includes("runtime-access-token"), false);
  assert.ok(states.some((state) => state.status === "active"));
});

test("investment holdings persist before a later history failure", async () => {
  const replacements = [];
  const states = [];
  const repository = {
    async getPlaidItem() {
      return {
        id: "local-item",
        workspace_id: "shared",
        institution_name: "Fidelity",
        transactions_cursor: null,
        status: "active",
      };
    },
    async startSyncRun() {
      return "run";
    },
    async updatePlaidItemState(_id, state) {
      states.push(state);
    },
    async upsertAccounts() {},
    async deactivateMissingAccounts() {},
    async applyTransactionSync() {},
    async replaceInvestments(_itemId, values) {
      replacements.push(values);
    },
    async takeDailySnapshots() {},
    async rebuildSearchDocuments() {},
    async finishSyncRun() {},
  };
  const provider = {
    async getAccounts() {
      return {
        accounts: [
          {
            account_id: "fidelity-401k",
            name: "401(k)",
            type: "investment",
            subtype: "401k",
            balances: {
              current: 141_279.23,
              iso_currency_code: "USD",
            },
          },
        ],
      };
    },
    async syncTransactions() {
      return {
        added: [],
        modified: [],
        removed: [],
        nextCursor: "cursor",
      };
    },
    async getInvestmentHoldings() {
      return {
        holdings: [
          {
            account_id: "fidelity-401k",
            security_id: "target-fund",
            quantity: 100,
            institution_value: 141_279.23,
            iso_currency_code: "USD",
          },
        ],
        securities: [
          {
            security_id: "target-fund",
            name: "Target fund",
            ticker_symbol: "TARGET",
            type: "mutual fund",
            iso_currency_code: "USD",
          },
        ],
      };
    },
    async getInvestmentTransactions() {
      throw new PlaidApiError("history unavailable", {
        status: 503,
        errorType: "API_ERROR",
        errorCode: "INSTITUTION_NOT_RESPONDING",
      });
    },
  };
  const service = new PlaidSyncService({
    provider,
    repository,
    secretRepository: {
      async get() {
        return "access-token";
      },
    },
    now: () => new Date("2026-08-03T18:47:16Z"),
  });

  await assert.rejects(
    service.syncItem("local-item"),
    /history unavailable/,
  );

  assert.equal(replacements.length, 1);
  assert.equal(replacements[0].holdings.length, 1);
  assert.equal(replacements[0].holdings[0].institution_value_minor, 14_127_923);
  assert.equal(replacements[0].transactions, undefined);
  assert.equal(states.some((state) => state.status === "active"), false);
  assert.equal(states.at(-1).status, "error");
  assert.equal(
    states.at(-1).errorCode,
    "INSTITUTION_NOT_RESPONDING",
  );
});

test("investment history initialization is non-fatal while Plaid prepares it", async () => {
  const replacements = [];
  const states = [];
  let finished;
  const repository = investmentSyncRepository({
    async updatePlaidItemState(_itemId, state) {
      states.push(state);
    },
    async replaceInvestments(_itemId, values) {
      replacements.push(values);
    },
    async finishSyncRun(_runId, result) {
      finished = result;
    },
  });
  const account = plaidInvestmentAccount({
    accountId: "fidelity-401k",
    name: "Cisco 401(k)",
    subtype: "401k",
    balance: 141_279.23,
  });
  const provider = {
    ...investmentSyncProvider({
      accounts: [account],
      holdingsResult: {
        accounts: [account],
        holdings: [
          plaidHolding({
            accountId: "fidelity-401k",
            securityId: "target-fund",
            value: 141_279.23,
          }),
        ],
        securities: [plaidSecurity("target-fund", "Target fund")],
      },
    }),
    async getInvestmentTransactions() {
      throw new PlaidApiError("Investment history is preparing", {
        status: 400,
        errorType: "ITEM_ERROR",
        errorCode: "PRODUCT_NOT_READY",
      });
    },
  };
  const service = new PlaidSyncService({
    provider,
    repository,
    secretRepository: { async get() { return "access-token"; } },
    now: () => new Date("2026-08-05T18:00:00Z"),
  });

  const stats = await service.syncItem("local-item");

  const warning = {
    product: "investment_transactions",
    code: "PRODUCT_NOT_READY",
  };
  assert.equal(replacements.length, 1);
  assert.equal(replacements[0].holdings.length, 1);
  assert.deepEqual(stats.optional_product_warnings, [warning]);
  assert.deepEqual(states.at(-1), {
    status: "active",
    errorCode: null,
    lastSyncedAt: new Date("2026-08-05T18:00:00Z"),
    coverageWarnings: [warning],
  });
  assert.equal(finished.status, "succeeded");
  assert.deepEqual(finished.stats.optional_product_warnings, [warning]);
});

test("investment response accounts are stored before their holdings", async () => {
  const accountBatches = [];
  const replacements = [];
  const deactivations = [];
  const repository = investmentSyncRepository({
    async upsertAccounts(_itemId, accounts) {
      accountBatches.push(
        accounts.map((account) => account.provider_account_id),
      );
    },
    async deactivateMissingAccounts(_itemId, providerAccountIds) {
      deactivations.push(providerAccountIds);
    },
    async replaceInvestments(_itemId, values) {
      replacements.push(values);
    },
  });
  const provider = investmentSyncProvider({
    accounts: [
      plaidInvestmentAccount({
        accountId: "fidelity-plan",
        name: "Cisco 401(k)",
        subtype: "401k",
        balance: 141_279.23,
      }),
    ],
    holdingsResult: {
      accounts: [
        plaidInvestmentAccount({
          accountId: "fidelity-plan",
          name: "Cisco 401(k) pre-tax",
          subtype: "401k",
          balance: 100_000,
        }),
        plaidInvestmentAccount({
          accountId: "fidelity-roth",
          name: "Cisco Roth 401(k)",
          subtype: "roth 401k",
          balance: 41_279.23,
        }),
      ],
      holdings: [
        plaidHolding({
          accountId: "fidelity-plan",
          securityId: "target-2045",
          value: 100_000,
        }),
        plaidHolding({
          accountId: "fidelity-roth",
          securityId: "target-2050",
          value: 41_279.23,
        }),
      ],
      securities: [
        plaidSecurity("target-2045", "Target 2045"),
        plaidSecurity("target-2050", "Target 2050"),
      ],
    },
    transactionAccounts: [
      plaidInvestmentAccount({
        accountId: "fidelity-plan",
        name: "Cisco 401(k) pre-tax",
        subtype: "401k",
        balance: 100_000,
      }),
      plaidInvestmentAccount({
        accountId: "fidelity-roth",
        name: "Cisco Roth 401(k)",
        subtype: "roth 401k",
        balance: 41_279.23,
      }),
    ],
  });
  const service = new PlaidSyncService({
    provider,
    repository,
    secretRepository: { async get() { return "access-token"; } },
    now: () => new Date("2026-08-04T18:00:00Z"),
  });

  const stats = await service.syncItem("local-item");

  assert.deepEqual(accountBatches, [
    ["fidelity-plan"],
    ["fidelity-plan", "fidelity-roth"],
    ["fidelity-plan", "fidelity-roth"],
  ]);
  assert.deepEqual(deactivations, [
    ["fidelity-plan", "fidelity-roth"],
  ]);
  assert.deepEqual(
    replacements[0].holdings.map(
      (holding) => holding.provider_account_id,
    ),
    ["fidelity-plan", "fidelity-roth"],
  );
  assert.equal(stats.accounts, 2);
  assert.equal(stats.holdings, 2);
});

test("a funded investment account with an empty holdings response preserves positions and warns", async () => {
  const knownHoldings = [{ id: "known-position" }];
  const states = [];
  let finished;
  const repository = investmentSyncRepository({
    async replaceInvestments(_itemId, values) {
      if (Object.hasOwn(values, "holdings")) {
        knownHoldings.splice(0, knownHoldings.length, ...values.holdings);
      }
    },
    async updatePlaidItemState(_itemId, state) {
      states.push(state);
    },
    async finishSyncRun(_runId, result) {
      finished = result;
    },
  });
  const account = plaidInvestmentAccount({
    accountId: "fidelity-401k",
    name: "Cisco 401(k)",
    subtype: "401k",
    balance: 141_279.23,
  });
  const provider = investmentSyncProvider({
    accounts: [account],
    holdingsResult: {
      accounts: [account],
      holdings: [],
      securities: [],
    },
    transactionAccounts: [account],
  });
  const service = new PlaidSyncService({
    provider,
    repository,
    secretRepository: { async get() { return "access-token"; } },
    now: () => new Date("2026-08-04T18:00:00Z"),
  });

  const stats = await service.syncItem("local-item");

  assert.deepEqual(knownHoldings, [{ id: "known-position" }]);
  assert.deepEqual(stats.optional_product_warnings, [
    {
      product: "investment_holdings",
      code: "EMPTY_HOLDINGS_WITH_POSITIVE_BALANCE",
    },
  ]);
  assert.deepEqual(finished.stats, stats);
  assert.deepEqual(
    states.find((state) => state.status === "active").coverageWarnings,
    stats.optional_product_warnings,
  );
});

test("a later sync failure retains an empty holdings coverage warning", async () => {
  const states = [];
  let finished;
  const repository = investmentSyncRepository({
    async updatePlaidItemState(_itemId, state) {
      states.push(state);
    },
    async finishSyncRun(_runId, result) {
      finished = result;
    },
  });
  const account = plaidInvestmentAccount({
    accountId: "fidelity-401k",
    name: "Cisco 401(k)",
    subtype: "401k",
    balance: 141_279.23,
  });
  const provider = {
    ...investmentSyncProvider({
      accounts: [account],
      holdingsResult: {
        accounts: [account],
        holdings: [],
        securities: [],
      },
    }),
    async getInvestmentTransactions() {
      throw new PlaidApiError("Plaid request timed out", {
        errorType: "API_ERROR",
        errorCode: "PLAID_REQUEST_TIMEOUT",
      });
    },
  };
  const service = new PlaidSyncService({
    provider,
    repository,
    secretRepository: { async get() { return "access-token"; } },
    now: () => new Date("2026-08-05T18:00:00Z"),
  });

  await assert.rejects(
    service.syncItem("local-item"),
    /Plaid request timed out/,
  );

  const warning = {
    product: "investment_holdings",
    code: "EMPTY_HOLDINGS_WITH_POSITIVE_BALANCE",
  };
  assert.deepEqual(states.at(-1), {
    status: "error",
    errorCode: "PLAID_REQUEST_TIMEOUT",
    coverageWarnings: [warning],
  });
  assert.equal(finished.status, "failed");
  assert.equal(finished.errorCode, "PLAID_REQUEST_TIMEOUT");
  assert.deepEqual(finished.stats.optional_product_warnings, [warning]);
});

test("sync fences read models before its first write and publishes after success", async () => {
  const { service, events } = readModelFenceSyncHarness();

  await service.syncItem("local-item", { enqueueDerived: false });

  const markIndex = events.indexOf("mark:shared:local-item:1");
  assert.ok(markIndex > events.indexOf("tx:start:1"));
  assert.ok(markIndex < events.indexOf("run:start:1"));
  assert.ok(markIndex < events.indexOf("item:syncing:1"));
  assert.ok(markIndex < events.indexOf("provider:accounts:none"));
  assert.ok(markIndex < events.indexOf("accounts:upsert:none"));
  assert.equal(events[0], "lock:acquire:local-item");
  assert.equal(events.at(-1), "lock:release:local-item");
  assert.deepEqual(
    events.filter((event) => event.startsWith("publish:")),
    ["publish:shared:local-item:plaid.sync-finished:2"],
  );
  assert.ok(
    events.indexOf("run:finish:succeeded:2") <
      events.indexOf(
        "publish:shared:local-item:plaid.sync-finished:2",
      ),
  );
  assert.ok(
    events.indexOf(
      "publish:shared:local-item:plaid.sync-finished:2",
    ) <
      events.indexOf("tx:commit:2"),
  );
});

test("a partially applied sync publishes its failure boundary", async () => {
  const syncError = new Error("transaction page failed");
  const { service, events } = readModelFenceSyncHarness({ syncError });

  await assert.rejects(
    service.syncItem("local-item", { enqueueDerived: false }),
    syncError,
  );

  assert.ok(events.includes("accounts:upsert:none"));
  assert.deepEqual(
    events.filter((event) => event.startsWith("mark:")),
    ["mark:shared:local-item:1"],
  );
  assert.deepEqual(
    events.filter((event) => event.startsWith("publish:")),
    ["publish:shared:local-item:plaid.sync-partial-failure:2"],
  );
  assert.ok(
    events.indexOf("run:finish:failed:2") <
      events.indexOf(
        "publish:shared:local-item:plaid.sync-partial-failure:2",
      ),
  );
  assert.ok(
    events.indexOf(
      "publish:shared:local-item:plaid.sync-partial-failure:2",
    ) <
      events.indexOf("tx:commit:2"),
  );
});

test("missing Plaid Items and credentials do not touch the read-model fence", async () => {
  for (const scenario of [
    {
      options: { item: null },
      message: "Item not found",
    },
    {
      options: { accessToken: null },
      message: "credential not found",
    },
  ]) {
    const { service, events } = readModelFenceSyncHarness(
      scenario.options,
    );

    await assert.rejects(
      service.syncItem("local-item", { enqueueDerived: false }),
      new RegExp(scenario.message, "i"),
    );
    assert.equal(
      events.some(
        (event) =>
          event.startsWith("mark:") ||
          event.startsWith("publish:") ||
          event.startsWith("tx:start:"),
      ),
      false,
    );
  }
});

test("sync service does not request unsupported liability details for auto loans", async () => {
  let liabilityRequests = 0;
  const { service, states } = liabilitySyncHarness({
    account: {
      account_id: "auto-loan",
      name: "Auto loan",
      type: "loan",
      subtype: "auto",
      balances: { current: 25_000, iso_currency_code: "USD" },
    },
    getLiabilities: async () => {
      liabilityRequests += 1;
      throw new Error("auto loans must not request Plaid Liabilities");
    },
  });

  const stats = await service.syncItem("local-item");

  assert.equal(liabilityRequests, 0);
  assert.deepEqual(stats.optional_product_warnings, []);
  assert.ok(states.some((state) => state.status === "active"));
});

test("unsupported Plaid Liabilities products remain non-fatal", async () => {
  const { service, states } = liabilitySyncHarness({
    account: {
      account_id: "mortgage",
      name: "Mortgage",
      type: "loan",
      subtype: "mortgage",
      balances: { current: 250_000, iso_currency_code: "USD" },
    },
    getLiabilities: async () => {
      throw new PlaidApiError("liabilities unsupported", {
        status: 400,
        errorType: "ITEM_ERROR",
        errorCode: "PRODUCTS_NOT_SUPPORTED",
      });
    },
  });

  const stats = await service.syncItem("local-item");

  assert.deepEqual(stats.optional_product_warnings, [
    { product: "liabilities", code: "PRODUCTS_NOT_SUPPORTED" },
  ]);
  assert.ok(states.some((state) => state.status === "active"));
  assert.equal(states.some((state) => state.status === "error"), false);
});

test("Plaid webhook verifier checks ES256 signature, age, and raw body hash", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const key = publicKey.export({ format: "jwk" });
  const now = new Date("2026-07-26T12:00:00Z");
  const body = Buffer.from('{"webhook_type":"TRANSACTIONS"}');
  const header = { alg: "ES256", kid: "key-id" };
  const claims = {
    iat: Math.floor(now.getTime() / 1_000),
    request_body_sha256: createHash("sha256").update(body).digest("hex"),
  };
  const first = Buffer.from(JSON.stringify(header)).toString("base64url");
  const second = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign(
    "sha256",
    Buffer.from(`${first}.${second}`),
    { key: privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("base64url");
  const token = `${first}.${second}.${signature}`;
  const provider = new PlaidProvider({
    clientId: "client-id",
    secret: "secret",
    now: () => now,
    fetchImpl: async () => jsonResponse({ key }),
  });
  assert.equal(await provider.verifyWebhook(body, token), true);
  assert.equal(
    await provider.verifyWebhook(Buffer.from('{"tampered":true}'), token),
    false,
  );
});

test("standalone Plaid reauthentication webhooks update Item state", async () => {
  const states = [];
  const service = new PlaidSyncService({
    provider: {
      async verifyWebhook() {
        return true;
      },
    },
    repository: {
      async getPlaidItemByProviderId() {
        return { id: "local-item" };
      },
      async updatePlaidItemState(_itemId, state) {
        states.push(state);
      },
    },
    secretRepository: {},
  });

  for (const webhookCode of [
    "PENDING_EXPIRATION",
    "PENDING_DISCONNECT",
    "USER_PERMISSION_REVOKED",
    "USER_ACCOUNT_REVOKED",
  ]) {
    const result = await service.handleWebhook({
      rawBody: Buffer.from(
        JSON.stringify({
          webhook_type: "ITEM",
          webhook_code: webhookCode,
          item_id: "provider-item",
        }),
      ),
      verificationHeader: "verified",
    });
    assert.deepEqual(result, { accepted: true, queued: false });
  }

  assert.deepEqual(
    states.map((state) => state.status),
    Array(4).fill("reauth_required"),
  );
  assert.deepEqual(
    states.map((state) => state.errorCode),
    [
      "PENDING_EXPIRATION",
      "PENDING_DISCONNECT",
      "USER_PERMISSION_REVOKED",
      "USER_ACCOUNT_REVOKED",
    ],
  );
});

test("investment history completion webhooks queue an Item sync", async () => {
  const jobs = [];
  const service = new PlaidSyncService({
    provider: {
      async verifyWebhook() {
        return true;
      },
    },
    repository: {
      async getPlaidItemByProviderId() {
        return { id: "local-item" };
      },
    },
    secretRepository: {},
    jobQueue: {
      async enqueue(type, payload, options) {
        jobs.push({ type, payload, options });
        return { id: "job" };
      },
    },
  });

  const result = await service.handleWebhook({
    rawBody: Buffer.from(
      JSON.stringify({
        webhook_type: "INVESTMENTS_TRANSACTIONS",
        webhook_code: "HISTORICAL_UPDATE",
        item_id: "provider-item",
      }),
    ),
    verificationHeader: "verified",
  });

  assert.deepEqual(result, { accepted: true, queued: true });
  assert.deepEqual(jobs, [
    {
      type: "plaid.sync_item",
      payload: { itemId: "local-item" },
      options: { dedupeKey: "local-item" },
    },
  ]);
});

test("job dedupe only coalesces work that is still queued", async () => {
  const migration = await readFile(
    fileURLToPath(new URL("../migrations/001_initial.sql", import.meta.url)),
    "utf8",
  );
  const queueSource = await readFile(
    fileURLToPath(new URL("../app/db/jobQueue.js", import.meta.url)),
    "utf8",
  );
  assert.match(
    migration,
    /WHERE dedupe_key IS NOT NULL AND status = 'queued'/,
  );
  assert.match(
    queueSource,
    /WHERE dedupe_key IS NOT NULL AND status = 'queued'/,
  );
  assert.doesNotMatch(
    `${migration}\n${queueSource}`,
    /status IN \('queued', 'running'\)/,
  );
});

test("Plaid secret table name stays isolated from ordinary source modules", async () => {
  const root = fileURLToPath(new URL("../app/", import.meta.url));
  const files = await sourceFiles(root);
  const violations = [];
  for (const filename of files) {
    if (filename.endsWith("plaidSecretRepository.js")) continue;
    const content = await readFile(filename, "utf8");
    if (content.includes("plaid_item_secrets")) {
      violations.push(path.relative(root, filename));
    }
  }
  assert.deepEqual(violations, []);
});

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(target)));
    else if (entry.name.endsWith(".js")) files.push(target);
  }
  return files;
}

function investmentSyncRepository(overrides = {}) {
  return {
    async getPlaidItem() {
      return {
        id: "local-item",
        workspace_id: "shared",
        institution_name: "Fidelity",
        transactions_cursor: null,
        status: "active",
      };
    },
    async startSyncRun() {
      return "run";
    },
    async updatePlaidItemState() {},
    async upsertAccounts() {},
    async deactivateMissingAccounts() {},
    async applyTransactionSync() {},
    async replaceInvestments() {},
    async takeDailySnapshots() {},
    async rebuildSearchDocuments() {},
    async finishSyncRun() {},
    ...overrides,
  };
}

function investmentSyncProvider({
  accounts,
  holdingsResult,
  transactionAccounts = [],
}) {
  return {
    async getAccounts() {
      return { accounts };
    },
    async syncTransactions() {
      return {
        added: [],
        modified: [],
        removed: [],
        nextCursor: "cursor",
      };
    },
    async getInvestmentHoldings() {
      return holdingsResult;
    },
    async getInvestmentTransactions() {
      return {
        accounts: transactionAccounts,
        securities: [],
        investmentTransactions: [],
      };
    },
  };
}

function plaidInvestmentAccount({
  accountId,
  name,
  subtype,
  balance,
}) {
  return {
    account_id: accountId,
    name,
    type: "investment",
    subtype,
    balances: {
      current: balance,
      iso_currency_code: "USD",
    },
  };
}

function plaidHolding({ accountId, securityId, value }) {
  return {
    account_id: accountId,
    security_id: securityId,
    quantity: 100,
    institution_value: value,
    iso_currency_code: "USD",
  };
}

function plaidSecurity(securityId, name) {
  return {
    security_id: securityId,
    name,
    type: "mutual fund",
    iso_currency_code: "USD",
  };
}

function liabilitySyncHarness({ account, getLiabilities }) {
  const states = [];
  const repository = {
    async getPlaidItem() {
      return {
        id: "local-item",
        workspace_id: "shared",
        institution_name: "Bank",
        transactions_cursor: null,
        status: "active",
      };
    },
    async startSyncRun() {
      return "run";
    },
    async updatePlaidItemState(_id, state) {
      states.push(state);
    },
    async upsertAccounts() {},
    async deactivateMissingAccounts() {},
    async applyTransactionSync() {},
    async replaceLiabilities() {},
    async takeDailySnapshots() {},
    async rebuildSearchDocuments() {},
    async finishSyncRun() {},
  };
  const provider = {
    async getAccounts() {
      return { accounts: [account] };
    },
    async syncTransactions() {
      return {
        added: [],
        modified: [],
        removed: [],
        nextCursor: "cursor",
      };
    },
    getLiabilities,
  };
  const service = new PlaidSyncService({
    provider,
    repository,
    secretRepository: {
      async get() {
        return "access-token";
      },
    },
    now: () => new Date("2026-08-01T12:00:00Z"),
  });
  return { service, states };
}

function readModelFenceSyncHarness({
  item = {
    id: "local-item",
    workspace_id: "shared",
    institution_name: "Bank",
    transactions_cursor: null,
    status: "active",
  },
  accessToken = "access-token",
  syncError = null,
} = {}) {
  const events = [];
  let currentClient = null;
  let transactionNumber = 0;
  const record = (label) => {
    events.push(`${label}:${currentClient?.number ?? "none"}`);
  };
  const repository = {
    async withPlaidSyncLock(itemId, operation) {
      events.push(`lock:acquire:${itemId}`);
      try {
        return await operation();
      } finally {
        events.push(`lock:release:${itemId}`);
      }
    },
    async transaction(operation) {
      const previousClient = currentClient;
      const client = { number: ++transactionNumber };
      currentClient = client;
      record("tx:start");
      try {
        const result = await operation(client);
        record("tx:commit");
        return result;
      } catch (error) {
        record("tx:rollback");
        throw error;
      } finally {
        currentClient = previousClient;
      }
    },
    async getPlaidItem() {
      record("item:get");
      return item;
    },
    async startSyncRun() {
      record("run:start");
      return "run";
    },
    async updatePlaidItemState(_itemId, state) {
      record(`item:${state.status}`);
    },
    async upsertAccounts() {
      record("accounts:upsert");
    },
    async deactivateMissingAccounts() {
      record("accounts:deactivate");
    },
    async applyTransactionSync() {
      record("transactions:apply");
    },
    async takeDailySnapshots() {
      record("snapshots:take");
    },
    async rebuildSearchDocuments() {
      record("search:rebuild");
    },
    async finishSyncRun(_runId, result) {
      record(`run:finish:${result.status}`);
    },
  };
  const provider = {
    async getAccounts() {
      record("provider:accounts");
      return {
        accounts: [
          {
            account_id: "provider-account",
            name: "Checking",
            type: "depository",
            subtype: "checking",
            balances: {
              current: 100,
              available: 90,
              iso_currency_code: "USD",
            },
          },
        ],
      };
    },
    async syncTransactions() {
      record("provider:transactions");
      if (syncError) throw syncError;
      return {
        added: [],
        modified: [],
        removed: [],
        nextCursor: "cursor",
      };
    },
  };
  const service = new PlaidSyncService({
    provider,
    repository,
    secretRepository: {
      async get() {
        record("secret:get");
        return accessToken;
      },
    },
    now: () => new Date("2026-08-01T12:00:00Z"),
    async markReadModelSourceUnstable(client, workspaceId, itemId) {
      assert.equal(client, currentClient);
      events.push(
        `mark:${workspaceId}:${itemId}:${client.number}`,
      );
    },
    async publishReadModelBoundary(
      client,
      workspaceId,
      itemId,
      reason,
    ) {
      assert.equal(client, currentClient);
      events.push(
        `publish:${workspaceId}:${itemId}:${reason}:${client.number}`,
      );
    },
  });
  return { service, events };
}
