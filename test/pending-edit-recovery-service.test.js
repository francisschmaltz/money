import assert from "node:assert/strict";
import test from "node:test";

import { createFinanceService } from "../app/services/financeService.js";

const openRecovery = {
  id: "recovery-1",
  pending_transaction_id: "pending-1",
  provider_pending_transaction_id: "provider-pending-1",
  recovered_at: "2026-08-01T18:00:00.000Z",
  attached_transaction_id: null,
  attached_at: null,
  dismissed_at: null,
  provider_facts: {
    merchant_name: "Wells Fargo Auto",
    authorized_on: "2026-07-16",
    account_name: "Bee & Bee Checking",
    amount_minor: -100_000,
    currency_code: "USD",
  },
  user_state: {
    metadata: {
      display_name: "Car payment",
      display_name_overridden: true,
      note: "July payment",
      note_version: 1,
    },
    categorization: {
      cash_flow_role: "obligation",
    },
    splits: [
      { category: "Auto loan", amount_minor: -100_000 },
    ],
  },
};

test("pending edit recoveries map retained provider facts and edits", async () => {
  const calls = [];
  const service = createFinanceService({
    repository: {
      async listPendingEditRecoveries(workspaceId, options) {
        calls.push(["list", workspaceId, options]);
        return { recoveries: [openRecovery] };
      },
      async attachPendingEditRecovery(workspaceId, input) {
        calls.push(["attach", workspaceId, input]);
        return {
          ...openRecovery,
          attached_transaction_id: input.transactionId,
          attached_at: "2026-08-01T18:05:00.000Z",
        };
      },
      async dismissPendingEditRecovery(workspaceId, input) {
        calls.push(["dismiss", workspaceId, input]);
        return {
          ...openRecovery,
          dismissed_at: "2026-08-01T18:06:00.000Z",
        };
      },
    },
  });

  const listed = await service.listPendingEditRecoveries();
  assert.deepEqual(listed.recoveries[0], {
    id: "recovery-1",
    recovered_at: "2026-08-01T18:00:00.000Z",
    state: "open",
    attached_transaction_id: null,
    attached_at: null,
    dismissed_at: null,
    source: {
      pending_transaction_id: "pending-1",
      provider_transaction_id: "provider-pending-1",
      name: "Wells Fargo Auto",
      date: "2026-07-16",
      account: "Bee & Bee Checking",
      amount: { amount_minor: -100_000, currency: "USD" },
    },
    edits: {
      display_name: "Car payment",
      cash_flow_role: "obligation",
      note: "July payment",
      splits: [
        { category: "Auto loan", amount_minor: -100_000 },
      ],
    },
    edited_fields: ["Name", "Cash-flow role", "Note", "Split"],
  });

  const attached = await service.attachPendingEditRecovery(
    {
      recovery_id: "recovery-1",
      transaction_id: "posted-1",
    },
    { id: "admin-1" },
  );
  assert.equal(attached.attached, true);
  assert.equal(attached.recovery.state, "attached");
  assert.equal(
    attached.recovery.attached_transaction_id,
    "posted-1",
  );

  const dismissed = await service.dismissPendingEditRecovery(
    { recovery_id: "recovery-1" },
    { id: "admin-1" },
  );
  assert.equal(dismissed.dismissed, true);
  assert.equal(dismissed.recovery.state, "dismissed");

  assert.deepEqual(calls, [
    ["list", "shared", { includeResolved: false }],
    [
      "attach",
      "shared",
      {
        recoveryId: "recovery-1",
        transactionId: "posted-1",
        userId: "admin-1",
      },
    ],
    [
      "dismiss",
      "shared",
      { recoveryId: "recovery-1", userId: "admin-1" },
    ],
  ]);
});

test("resolved or missing recoveries fail without guessing a target", async () => {
  const missing = createFinanceService({
    repository: {
      async attachPendingEditRecovery() {
        return null;
      },
      async dismissPendingEditRecovery() {
        return { alreadyResolved: true };
      },
    },
  });

  await assert.rejects(
    missing.attachPendingEditRecovery({
      recovery_id: "recovery-1",
      transaction_id: "posted-1",
    }),
    (error) => error.statusCode === 404,
  );
  await assert.rejects(
    missing.dismissPendingEditRecovery({
      recovery_id: "recovery-1",
    }),
    (error) => error.statusCode === 409,
  );
});
