# Transaction cleanup rules

Transaction cleanup has two separate jobs:

- Fuzzy search finds similar existing transactions for a one-time batch edit.
- Persistent rules update existing and future transactions when the normalized
  merchant or normalized transaction name matches exactly.

The distinction is intentional. Similarity is useful while a person is
reviewing candidates; it is not safe enough to run forever without review.

## Rule behavior

A rule stores:

- One matcher: `normalized_merchant` or `normalized_name`.
- The original matcher text and its server-derived normalized value.
- One or more changes: display name, primary category, or tags.
- Enabled state and create/update audit fields.

Capitalization, punctuation, diacritics, and repeated spaces are normalized
before comparison. The remaining value must match exactly. A workspace can
have only one rule for a given matcher field and normalized value.

If both a merchant rule and a transaction-name rule match, the merchant rule
wins. Rules of the same type are ordered by the most recent update and then by
ID for a deterministic result.

## Precedence and reversibility

Effective transaction values use this order:

1. An explicit one-time transaction edit.
2. The winning enabled cleanup rule.
3. Existing merchant/original-transaction overrides.
4. Plaid's stored provider values.

Rule output is applied dynamically. Plaid data is never rewritten, and future
synced transactions inherit a rule as soon as their normalized source field
matches. Disabling, editing, or deleting a rule immediately changes or removes
its automatic output. One-time edits remain in place.

For tags, a missing rule value means “leave tags alone,” while an empty array
means “clear tags.” Explicitly clearing a transaction's tags is also stored as
an override, so a rule cannot silently add them back.

## Admin API

All endpoints require an admin session. Mutations also require CSRF:

- `GET /api/v1/transaction-cleanup-rules`
- `POST /api/v1/transaction-cleanup-rules`
- `PUT /api/v1/transaction-cleanup-rules/:ruleId`
- `DELETE /api/v1/transaction-cleanup-rules/:ruleId`

Create and update use the same full payload:

```json
{
  "matcher": {
    "field": "normalized_name",
    "value": "AAPL SRV"
  },
  "changes": {
    "display_name": "Apple Services",
    "category_primary": "Subscriptions",
    "tags": ["Recurring"]
  },
  "enabled": true
}
```
