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
get_budget_status
model_finance_plan
create_finance_goal
update_finance_goal
allocate_finance_goal
set_goal_funding_schedule
archive_finance_goal
set_category_budget
split_transaction
```

Attach **`server:mcp:money`** to the Open WebUI model used by compatible clients.
Depending on the Open WebUI call-output path, tool names may arrive as either
`get_finance_overview` or `money_get_finance_overview`; the native decoder
accepts both.

After changing tool names or schemas:

1. Verify/refresh the `money` external tool connection.
2. Confirm the read credential discovers 14 tools and the planning credential
   discovers all 21.
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

Credit-score calls accept `1m`, `1y`, or `all` and default to `1y`:

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
  version: 1,
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
