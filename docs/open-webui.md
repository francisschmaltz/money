# Open WebUI MCP setup

Money uses native Streamable HTTP MCP. Do not register it as OpenAPI and do not
paste desktop-style `mcpServers` JSON into an OpenAPI connection. That is how
you get an infinite spinner and a bad evening.

Open WebUI native MCP requires version 0.6.31 or newer. Follow the current
[Open WebUI MCP guide](https://docs.openwebui.com/features/extensibility/mcp/)
if its labels differ from the table below.

## Connection

An Open WebUI administrator adds one server under **Admin Settings → External
Tools**:

| Field | Value |
| --- | --- |
| Connection ID / name | `money` |
| Type | MCP (Streamable HTTP) |
| URL | `https://money.example.com/mcp` |
| Authentication | Bearer |
| Key | The exact `MCP_PLAN_WRITE_TOKEN` value for the authorized planning connection |
| Function filter | Empty |

Verify the connection before saving, then restrict access to the intended users
or groups. This credential can read the whole shared workspace and change the
family plan. `MCP_BEARER_TOKEN` remains read-only for clients that should never
discover write tools.

Expected discovery:

```text
get_finance_overview
get_finance_insights
list_accounts
list_transactions
get_spending_summary
get_cash_flow
list_recurring_payments
get_net_worth_history
get_portfolio_summary
get_credit_score_summary
get_safe_to_spend
list_finance_goals
get_finance_goal
get_budget_status
model_finance_plan
get_transaction_goal_spending
create_finance_goal
update_finance_goal
allocate_finance_goal
set_goal_funding_schedule
finish_finance_goal
set_category_budget
clear_category_budget
set_budget_income_categories
split_transaction
spend_from_finance_goal
reverse_goal_spend
```

`get_safe_to_spend` returns liquid USD cash after positive current card
balances, active USD bills expected from today through 30 days ahead, and
cash-backed goal earmarks. Its card deliberately contains only the final
amount, status, formula, factor names and counts, alerts, and bounded IDs for
goals with positive cash earmarks. Call `get_finance_goal` with one of those
IDs for dollar details. The bill projection includes only recurring streams
classified as bills; subscriptions are deliberately excluded. Preserve the
calculation window and occurrence/exclusion counts, and surface warnings
instead of implying the estimate is complete.

Money MCP v2 uses decimal currency values and ordinary percentages. Send
`{amount: 5.21, currency: "USD"}` in card data, decimal `amount` inputs on
writes, and fields such as `progress_percentage: 42.5`. Never send legacy
`*_minor` or `*_basis_points` fields.

Planning writes use optimistic versions in addition to idempotency keys.
Pass each budget line's `version` to `set_category_budget` and each
transaction's `split_version` to `split_transaction`. Use `0` only for a new
budget category or a transaction whose split version is zero. A stale version
returns a conflict; retry the same completed request with the same
idempotency key to replay its original receipt.

Before calling `spend_from_finance_goal` or `reverse_goal_spend`, call
`get_transaction_goal_spending` for the exact transaction and
`get_finance_goal` for the exact goal ID discovered through
`list_finance_goals`. Pass their current values as
`expected_transaction_version` (from `goal_spend_version`) and
`expected_goal_version`. Reversals also use the returned goal-spend record
`id` as `goal_spend_id`; never guess it from the merchant or amount.
These writes only change virtual earmarks and transaction attribution. They do
not move cash, pay a card, sell brokerage assets, or place a trade.

Eligibility follows the transaction's effective spending treatment. A posted
USD outflow explicitly marked **Include in spending** can be attributed to a
goal even when its provider labels it a transfer. Untouched excluded transfers,
pending transactions, inflows, and non-USD transactions remain ineligible.

Goal spending may exceed the selected source's remaining earmark or the goal
target. Usage may exceed 100%, but `plan_remaining` stops at zero and
`over_by` reports the positive overage. A source overrun consumes the goal's
other funding before it becomes `unfunded_spend`; it never creates a negative
earmark or fake Safe to Spend. Reverse the exact goal-spend record to correct
an attribution. The attributed portion no longer counts against that month's
Plan actuals, but the original transaction and goal-spending history remain
visible. Reversing or invalidating the link restores the portion to Plan
actuals.

Create goals with a stable `purpose`:
`vacation`, `home`, `vehicle`, `education`, `emergency`, `event`, `purchase`,
or `other`. Finish one with `finish_finance_goal` and an `outcome` of
`completed` or `cancelled`. Finishing freezes the plan, pauses schedules,
removes leftover earmarks from active planning, and preserves the goal,
funding history, and transaction links. Query it later with
`list_finance_goals({status:"archived"})` and follow `next_cursor` while
`has_more` is true, then pass its ID to `get_finance_goal`. Purpose insights use completed
goals with attributed actual spending only and appear only when enough
comparable history exists. The catch-all `other` purpose is never treated as a
meaningful spending pattern. Finished cards report active earmarks as zero;
`recorded_funding` and `unused_funding` preserve what was funded and released.

Explicit goal attribution is durable evidence. A later cleanup or category
rule does not silently rewrite it; reverse the exact goal-spend record when the
attribution itself is wrong. Provider corrections to amount, status, currency,
or exclusion still invalidate affected goal spending and reactivate a finished
goal for review.

Attach **`server:mcp:money`** to the Open WebUI model used by compatible clients.
Depending on the Open WebUI call-output path, tool names may arrive as either
`get_finance_overview` or `money_get_finance_overview`; the native decoder
accepts both.

After changing tool names or schemas:

1. Verify/refresh the `money` external tool connection.
2. Confirm the read credential discovers 16 tools and the planning credential
   discovers all 27.
3. Start a fresh chat. Existing chats may retain stale tool metadata.
4. Call every card kind before declaring the deploy done.

## Reverse proxy requirements

- Terminate TLS for `money.example.com`.
- Forward `POST /mcp` without changing the body.
- Preserve `Authorization`, `Host`, `Accept`, and `Content-Type`.
- Do not redirect `/mcp` to a trailing-slash URL.
- Permit `application/json` and `text/event-stream` response negotiation.

Money is stateless at this boundary. `GET /mcp` and `DELETE /mcp` deliberately
return `405`.

## Curl smoke test

Use a client-side environment variable with a different name so nobody confuses
it with server configuration:

```bash
export MONEY_MCP_TOKEN='REPLACE_WITH_THE_PLAN_WRITE_NOMAD_VALUE'
```

Discover tools:

```bash
curl --fail-with-body --silent --show-error \
  'https://money.example.com/mcp' \
  --header "Authorization: Bearer ${MONEY_MCP_TOKEN}" \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Call a card-producing tool:

```bash
curl --fail-with-body --silent --show-error \
  'https://money.example.com/mcp' \
  --header "Authorization: Bearer ${MONEY_MCP_TOKEN}" \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_finance_insights","arguments":{"section":"weekly"}}}'
```

Portfolio calls can choose whether retirement accounts are included:

```json
{"name":"get_portfolio_summary","arguments":{"period":"1m","retirement_scope":"include"}}
```

Use `include` for the complete portfolio, `exclude` for the app's **Trading**
view (taxable/personal brokerage accounts), and `only` for retirement
accounts.

Credit-score calls accept `1w`, `1m`, `1y`, or `all` and default to `1y`:

```json
{"name":"get_credit_score_summary","arguments":{"period":"1y"}}
```

The returned household average is manually supplied planning data. Never
present it as a lender or underwriting score, approval prediction, or quoted
interest rate.

The result must contain:

- `content[0].text`: readable weekly findings and `data_as_of`.
- `content[1].text`: one minified JSON object.
- `structuredContent`: the same object represented by `content[1].text`.
- `structuredContent.schema`: `com.yaboiii.finance-card`.
- `structuredContent.version`: `1`.
- `structuredContent.kind`: `insights`.

Do not paste real responses into tickets or chat. They contain financial data
even though secrets are excluded.

## SDK smoke test

Run from this repository after `npm ci`:

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const token = process.env.MONEY_MCP_TOKEN;
if (!token) throw new Error("MONEY_MCP_TOKEN is required");

const client = new Client({ name: "money-smoke", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(
  new URL("https://money.example.com/mcp"),
  {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
    },
  },
);

try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(tools.tools.map(({ name }) => name));

  const result = await client.callTool({
    name: "get_finance_overview",
    arguments: {},
  });
  console.log(result.content[0].text);
  console.log(result.structuredContent);
} finally {
  await client.close();
}
```

Save it outside the repository as `money-mcp-smoke.mjs`, then run:

```bash
MONEY_MCP_TOKEN='REPLACE_ME' node money-mcp-smoke.mjs
```

## Dual-output contract

Every successful result has exactly two text blocks plus `structuredContent`.
In pseudocode:

```js
const envelope = {
  schema: "com.yaboiii.finance-card",
  version: 2,
  kind: "overview",
  generated_at: "ISO-8601",
  data_as_of: "ISO-8601",
  partial: false,
  warnings: [],
  display: {
    title: "Finance overview",
    web_url: "https://money.example.com/",
  },
  data: {},
};

return {
  content: [
    { type: "text", text: "Readable finance summary." },
    { type: "text", text: canonicalStringify(envelope) },
  ],
  structuredContent: envelope,
};
```

The actual compatibility JSON is canonical and minified; the formatted sample
above is explanatory. The envelope is capped at 20,000 UTF-8 bytes.

Insight MCP output is deterministic. It removes optional LM Studio narratives,
scopes findings to the requested section, and generates prose from the
structured findings. Native clients should reject malformed schema versions,
oversized payloads, invalid money/dates/IDs, off-host links, and mismatched
tool/kind pairs.

The overview envelope exposes Cash Balance, Short-Term Worth, and Net Worth
alongside their component totals. `list_accounts` keeps manual assets separate
from connected bank accounts and labels each account with its effective
balance group.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `401` | Bearer is missing or differs from the Nomad value. |
| `421` | Add the exact public/internal host to `MCP_ALLOWED_HOSTS`. |
| `405` | Use `POST`; this is a stateless endpoint. |
| Connection verifies but tools are stale | Refresh discovery and open a fresh chat. |
| Cards do not render but prose does | Inspect completed tool output and its JSON compatibility block; do not scrape assistant Markdown. |
| Open WebUI runs in Docker locally | Use `http://host.docker.internal:3000/mcp` and allow that host instead of `localhost`. |
