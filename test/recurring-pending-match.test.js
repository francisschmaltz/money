import assert from "node:assert/strict";
import test from "node:test";

import { PgFinanceRepository } from "../app/db/financeRepository.js";

test("recurring streams expose one exact pending occurrence match", async () => {
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      const compact = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: compact, params });
      return {
        rows: [
          {
            id: "stream-1",
            service_family: "wells fargo auto",
            display_name: "Wells Fargo Auto",
            current_display_name: "Wells Fargo Auto",
            current_category_primary: "Loan Payments",
            current_cash_flow_role: "obligation",
            stream_type: "bill",
            cadence: "monthly",
            account_id: "checking-1",
            account_name: "Checking",
            expected_amount_minor: 100_000,
            min_amount_minor: 100_000,
            max_amount_minor: 100_000,
            monthly_equivalent_minor: 100_000,
            currency_code: "USD",
            first_seen_on: "2026-05-16",
            last_seen_on: "2026-07-16",
            next_expected_on: "2026-08-16",
            confidence_basis_points: 10_000,
            status: "active",
            duplicate_state: "unknown",
            transaction_ids: ["posted-1"],
            last_transaction_id: "posted-1",
            last_transaction_posted_on: "2026-07-16",
            last_transaction_amount_minor: -100_000,
            last_transaction_currency_code: "USD",
            pending_transaction_id: "pending-1",
            pending_transaction_posted_on: "2026-08-15",
            pending_transaction_authorized_at:
              "2026-08-14T18:00:00.000Z",
            pending_transaction_amount_minor: -100_025,
            pending_transaction_currency_code: "USD",
          },
        ],
      };
    },
  };
  const repository = new PgFinanceRepository(pool);

  const [stream] = await repository.listRecurringStreams("shared");

  assert.deepEqual(stream.pending_transaction, {
    id: "pending-1",
    posted_on: "2026-08-15",
    authorized_at: "2026-08-14T18:00:00.000Z",
    amount_minor: -100_025,
    currency_code: "USD",
  });
  const query = calls[0].sql;
  assert.match(query, /pending_occurrence\.transaction_id AS pending_transaction_id/);
  assert.match(query, /pending_candidate\.pending = true/);
  assert.match(query, /pending_candidate\.account_id = r\.account_id/);
  assert.match(query, /pending_candidate\.currency_code = r\.currency_code/);
  assert.match(query, /pattern\.normalized_match_value/);
  assert.match(query, /recurring_stream_transactions identity_occurrence/);
  assert.match(
    query,
    /COALESCE\( pending_treatment\.effective_cash_flow_role, pending_candidate\.cash_flow_role \) <> 'transfer'/,
  );
  assert.match(query, /LIMIT 1/);
});
