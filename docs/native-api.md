# Native Money REST API

The native client uses the existing `/api/v1` REST contract. Money remains
`{ "amount_minor": 521, "currency": "USD" }`, with percentages expressed as
integer basis points. The separate MCP v2 contract converts these to decimal
major units and percentages; do not use its DTOs for REST.

Finance reads retain `{ data, data_as_of, partial, warnings }` and optional
`display`/`summary`. Preserve missing money values as unknown. Follow
`page_info.next_cursor` while `has_more` is true. Aggregates describe the full
filtered set, not just the returned page.

## Added reads

All reads require an authenticated member. `/connections` additionally
requires admin access. Existing mutation permissions remain in force.

| GET path under `/api/v1` | `data` contents | Query |
| --- | --- | --- |
| `/transactions/:id` (also `/:id/detail`) | `transaction`, `recurring_context`, `splits: { transaction_id, split_version, lines }`, `goal_spending` | None |
| `/plan/overview` | `safe_to_spend`, `obligations`, `goals`, `archived_goals`, `history_insights`, `budget`, `previous_budget`, `schedule_runs`, `audit_events`, `alerts` | `month_on` |
| `/plan/goals/:id` | `goal`, `history_insights`, `alerts` | None |
| `/credit` | Canonical credit summary, card breakdown, local utilization history | `period=1w\|1m\|1y\|all` |
| `/recurring/:id` | `recurring_payment`, recent `transactions` | None |
| `/connections` | `connections` containing only allowlisted provider/status/freshness/import/account metadata | None |
| `/manual-assets` | `manual_assets`, `page_info` | `limit` (1–100), `cursor`, `include_inactive` |
| `/insight-feed` | `findings`, `section`, `view`, `page_info` | `section=all\|weekly\|investments\|subscriptions`, `view=active\|archive`, `limit` (1–100), `cursor` |
| `/insight-feed/:id` (also `/insights/:id`) | `finding`, including evidence, metrics, actions, and lifecycle state | None |

`GET /search?q=&entity_type=&limit=` preserves the existing search response
without a finance envelope: `{ query, entity_types, groups, returned_count,
group_count }`. Native result items include `entity_type` and `entity_id` so
navigation does not require parsing web URLs. Supported entities are
`transaction`, `account`, `recurring`, `insight`, and `manual_asset`.

## Extended reads

- `/transactions` accepts `merchant`, `currency_code`, and `sort` alongside
  existing account/category/date/search/status/amount filters. Maximum page
  size is 100. The `merchant` filter matches the effective display name.
- `/spending` and `/cash-flow` accept both `search` and `merchant`, using the
  same canonical split-aware calculations as other finance consumers.
- `/recurring` accepts `include_frequent_spending=true`; default remains
  subscriptions/bills. Native detail reads also support inactive streams.
- `/net-worth?include_components=true` includes Cash Balance, Short-Term Worth,
  and Retirement in the historical series. Demo fixtures have only the current
  component snapshot; earlier components remain null with a partial warning.
- `/portfolio` accepts `holdings_cursor` with `holdings_limit` (maximum 100)
  and returns `page_info`. Total value, allocation, and performance continue to
  cover the entire selected portfolio. Cursors are scoped to retirement scope
  and account; reset them whenever those filters change.
- `/plan/budget?include_available_categories=true` supplies category choices and
  budget write versions. `/categories` is member-readable; category mutations
  remain admin-only.

## Native Plaid Link

Initial/update link-token requests may send `{ "platform": "ios" }`.
The server chooses the fixed `PUBLIC_BASE_URL/plaid/ios/callback` URL;
client-supplied redirect URLs are ignored. The default platform is `web`.
Reject unsupported platforms and reject native requests if the fixed native
callback is not configured. Register the HTTPS callback with Plaid and enable
the app's Associated Domains before validating production Link OAuth.

## Write contracts

Reuse existing writes. Planning writes require an `idempotency_key` for every
user operation; retain the same key when retrying an uncertain response.
Goals/budgets/splits/goal spending use their current expected versions. Notes
use `expected_note_version`. Preserve edits on HTTP 409 and require review
against refreshed state before submitting a new write. Never infer success
from a timeout or replay non-idempotent writes automatically.

Apple Card CSV preview/confirmation uses the existing vendor media type
`application/vnd.money.apple-card-import`, `file_base64`, and the preview
digest. It does not require FinanceKit entitlement. Provider credentials and
raw financial files must never be logged or returned by connection inventory.
