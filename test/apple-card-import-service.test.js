import assert from "node:assert/strict";
import test from "node:test";

import { APPLE_CARD_CSV_HEADERS } from "../app/providers/appleCardCsv.js";
import { AppleCardImportService } from "../app/services/appleCardImportService.js";

function csv({
  category = "Gas/Tolls",
  type = "Purchase",
  amount = "42.17",
} = {}) {
  return Buffer.from(
    [
      APPLE_CARD_CSV_HEADERS.join(","),
      [
        "07/01/2026",
        "07/02/2026",
        "Synthetic fuel purchase",
        "Example Fuel",
        category,
        type,
        amount,
        "Synthetic User",
      ].join(","),
    ].join("\n"),
  );
}

test("preview performs no writes and reports existing rows before import", async () => {
  const events = [];
  const service = new AppleCardImportService({
    repository: {
      async findExistingTransactionProviderIds(_workspaceId, ids) {
        events.push(["lookup", ids]);
        return ids;
      },
      async importAppleCardTransactions() {
        events.push(["write"]);
      },
    },
  });

  const preview = await service.preview({ fileBuffer: csv() });

  assert.equal(preview.new_row_count, 0);
  assert.equal(preview.existing_row_count, 1);
  assert.equal(preview.rejected_row_count, 0);
  assert.equal(preview.charge_total_minor, 4_217);
  assert.deepEqual(events.map(([event]) => event), ["lookup"]);
});

test("first import requires card values, commits normalized rows, and queues derived work once", async () => {
  const events = [];
  const repository = {
    async findExistingTransactionProviderIds() {
      return [];
    },
    async getAppleCardConnection() {
      return null;
    },
    async importAppleCardTransactions(input) {
      events.push(["commit", input]);
      return {
        new_row_count: input.parsed.accepted_row_count,
        existing_row_count: 0,
      };
    },
  };
  const jobQueue = {
    async enqueue(type, payload, options) {
      events.push(["job", type, payload, options]);
      return { id: "job-1" };
    },
  };
  const service = new AppleCardImportService({
    repository,
    jobQueue,
    now: () => new Date("2026-07-27T12:00:00.000Z"),
  });
  const fileBuffer = csv();
  const preview = await service.preview({ fileBuffer });

  await assert.rejects(
    () =>
      service.import({
        fileBuffer,
        previewDigest: preview.preview_digest,
      }),
    /required for the first import/,
  );

  const result = await service.import(
    {
      fileBuffer,
      previewDigest: preview.preview_digest,
      balance: "-12.34",
      creditLimit: "10000.00",
      balanceAsOf: "2026-07-27",
      lastFour: "4242",
    },
    { id: "user-1" },
  );

  assert.equal(result.new_row_count, 1);
  const committed = events.find(([event]) => event === "commit")[1];
  assert.equal(committed.balanceMinor, -1_234);
  assert.equal(committed.creditLimitMinor, 1_000_000);
  assert.equal(committed.balanceAsOf, "2026-07-27");
  assert.equal(committed.lastFour, "4242");
  assert.equal(committed.actorId, "user-1");
  assert.equal(committed.parsed.transactions[0].amount_minor, -4_217);
  assert.equal(
    committed.parsed.transactions[0].category_primary,
    "Transportation",
  );
  assert.deepEqual(events.at(-1), [
    "job",
    "finance.detect_recurring",
    { workspaceId: "shared" },
    { dedupeKey: "shared" },
  ]);
});

test("commit rejects a file changed after preview", async () => {
  const service = new AppleCardImportService({
    repository: {
      async findExistingTransactionProviderIds() {
        return [];
      },
      async getAppleCardConnection() {
        return null;
      },
      async importAppleCardTransactions() {
        assert.fail("digest mismatch must not write");
      },
    },
  });
  const preview = await service.preview({ fileBuffer: csv() });

  await assert.rejects(
    () =>
      service.import({
        fileBuffer: csv({ amount: "42.18" }),
        previewDigest: preview.preview_digest,
        balance: "1.00",
        creditLimit: "100.00",
        balanceAsOf: "2026-07-27",
      }),
    /no longer matches the preview/,
  );
});

test("identical and category-edited exports remain idempotent across previews", async () => {
  const stored = new Set();
  const repository = {
    async findExistingTransactionProviderIds(_workspaceId, ids) {
      return ids.filter((id) => stored.has(id));
    },
    async getAppleCardConnection() {
      return { id: "connection-1" };
    },
    async importAppleCardTransactions({ parsed }) {
      const existing = parsed.transactions.filter((row) =>
        stored.has(row.provider_transaction_id),
      ).length;
      parsed.transactions.forEach((row) =>
        stored.add(row.provider_transaction_id),
      );
      return {
        new_row_count: parsed.accepted_row_count - existing,
        existing_row_count: existing,
      };
    },
  };
  const service = new AppleCardImportService({ repository });
  const original = csv();
  const firstPreview = await service.preview({ fileBuffer: original });
  const firstImport = await service.import({
    fileBuffer: original,
    previewDigest: firstPreview.preview_digest,
  });
  const identicalPreview = await service.preview({ fileBuffer: original });
  const edited = csv({ category: "Other" });
  const editedPreview = await service.preview({ fileBuffer: edited });

  assert.equal(firstImport.new_row_count, 1);
  assert.equal(identicalPreview.new_row_count, 0);
  assert.equal(identicalPreview.existing_row_count, 1);
  assert.equal(editedPreview.new_row_count, 0);
  assert.equal(editedPreview.existing_row_count, 1);
});

test("manual card updates allow overpayments and reject negative limits", async () => {
  const calls = [];
  const service = new AppleCardImportService({
    repository: {
      async updateAppleCardAccount(input) {
        calls.push(input);
        return { account_id: "apple-card-account" };
      },
    },
  });

  await service.updateAccount({
    balance: "-5.00",
    creditLimit: "5000.00",
    balanceAsOf: "2026-07-27",
  });
  assert.equal(calls[0].balanceMinor, -500);
  assert.equal(calls[0].creditLimitMinor, 500_000);

  await assert.rejects(
    () =>
      service.updateAccount({
        balance: "0",
        creditLimit: "-1",
        balanceAsOf: "2026-07-27",
      }),
    /cannot be negative/,
  );
});

test("Apple Card removal supports retained history and purge", async () => {
  const calls = [];
  const repository = {
    async getAppleCardConnection() {
      return { id: "connection-1" };
    },
    async removeFinanceConnection(id, options) {
      calls.push([id, options]);
      return true;
    },
  };
  const service = new AppleCardImportService({ repository });

  assert.equal(await service.remove({ retainHistory: true }), true);
  assert.equal(await service.remove({ retainHistory: false }), true);
  assert.deepEqual(calls, [
    ["connection-1", { retainHistory: true }],
    ["connection-1", { retainHistory: false }],
  ]);
});
