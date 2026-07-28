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
import { PlaidProvider } from "../app/providers/plaidProvider.js";
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
  assert.equal(JSON.stringify(stats).includes("runtime-access-token"), false);
  assert.ok(states.some((state) => state.status === "active"));
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
