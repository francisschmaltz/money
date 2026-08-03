# Nomad deployment

The checked-in [job specification](money.nomad.hcl) runs one allocation with
one Money task. That process applies pending migrations, starts the
PostgreSQL-backed finance worker, and then starts the Express web/MCP server.

Static secrets come only from the Nomad Variable path `nomad/jobs/money`.
There is no Vault integration and no application-layer encryption key.

HashiCorp's [Nomad Variables](https://developer.hashicorp.com/nomad/docs/concepts/variables)
and [`template` block](https://developer.hashicorp.com/nomad/docs/job-specification/template)
documentation describe the storage and workload-identity access model used by
the job.

## Prerequisites

- `nomad/jobs/money` contains a GitHub username and package-read token so Nomad
  can pull the private GHCR image.
- The target namespace has an ingress/controller honoring
  `service.meta.public_hostname`.
- DNS and TLS route `money.example.com` to that ingress.
- PostgreSQL is reachable from the allocation and accepts TLS connections.
- Plaid Dashboard has `https://money.example.com/plaid/oauth` under
  **Developers → API → Allowed redirect URIs**.
- Money sends Plaid webhooks to
  `https://money.example.com/webhooks/plaid`.
- Duo is configured as described in the root README.
- The deploying identity can write `nomad/jobs/money` and submit the job.

Do not put a GHCR token directly in the job file. The Docker tasks read it from
the encrypted Nomad Variable through Nomad's secret provider.

## Populate Nomad Variables

Copy [nomad-variable.example.json](nomad-variable.example.json) to a secure
location **outside this repository**, replace every `REPLACE_...` value, and
restrict its filesystem permissions.

```bash
umask 077
cp docs/nomad/nomad-variable.example.json /secure/path/money.nomad-vars.json
```

The command above copies placeholders; edit only the secure copy. Then write
the variable:

```bash
nomad var put -in=json \
  nomad/jobs/money \
  @/secure/path/money.nomad-vars.json
```

Required static values:

| Variable item | Purpose |
| --- | --- |
| `database_url` | The `money` PostgreSQL role connecting to the `money` database |
| `database_ssl` | Set to `true` in production so every database connection requires TLS |
| `database_ssl_reject_unauthorized` | Keep `true` for trusted certificates; use `false` only for a self-signed database certificate |
| `redis_url` | Shared Redis endpoint for bounded financial read models; accepts `redis://` or `rediss://` |
| `ghcr_token` | GitHub personal access token (classic) scoped to `read:packages` |
| `plaid_client_id`, `plaid_secret` | Plaid environment credentials |
| `plaid_webhook_url` | Public signed-webhook endpoint |
| `apple_team_id`, `apple_maps_key_id`, `apple_maps_private_key` | Optional Apple Maps signing credentials used to mint short-lived MapKit JS tokens |
| `duo_oidc_issuer` | Duo Generic OIDC issuer and discovery base |
| `duo_client_id`, `duo_client_secret` | OIDC relying-party credentials |
| `duo_authorization_url`, `duo_token_url` | Optional exact discovery consistency checks; empty is valid |
| `duo_redirect_uri` | Exact Money OIDC callback registered in Duo |
| `duo_admin_emails` | Users allowed to mutate shared finance data |
| `session_secret` | Express session signing; at least 32 random bytes |
| `mcp_bearer_token` | Read access to the full shared workspace |
| `mcp_plan_write_token` | Read plus audited family-plan writes; must differ from the read token |
| `lm_studio_*` | Optional aggregate narrative service |

Leave the optional Apple Maps signing credentials, Duo endpoint checks, and LM
Studio values as empty strings if unused. Do not remove their keys from the
variable document: the job template references them.

MapKit JS is progressive enhancement for transaction locations. Populate
`apple_team_id`, `apple_maps_key_id`, and `apple_maps_private_key` with an Apple
Maps identifier and private key. They may contain the same values already used
by `yb-mcp`, but keep a separate copy under `nomad/jobs/money` so neither job
depends on access to the other's Nomad Variable path.

Money keeps the private key server-side. The authenticated web client fetches a
short-lived JWT from `/api/mapkit-token`; every JWT is limited to the
`mapkit_js` scope and the exact origin in `PUBLIC_BASE_URL`. The private key is
never rendered into HTML or sent to the browser. For local testing, set
`PUBLIC_BASE_URL` to the exact local origin you open in the browser. Missing or
invalid credentials leave the address visible and omit only the map.

## Read-model cache rollout

Dashboard, Plan, and the canonical first Transactions page use bounded JSON
read models in Redis. PostgreSQL remains authoritative: every entry is checked
against a workspace revision stored in PostgreSQL, expires after 12 hours, is
limited to 512 KiB, and comes from a fixed allowlist capped at 24 keys per
workspace. Redis failures never make the application or readiness check fail.

`READ_MODEL_CACHE_MODE` in [money.nomad.hcl](money.nomad.hcl) controls rollout.
The checked-in job uses `serve`, so the configured `redis_url` is used for
reads and proactive warming immediately after deployment.

1. Use `warm` when validating writes without serving cached models. Confirm
   `/health/ready` reports
   `cache: "warming"`, warm jobs complete, entry sizes stay bounded, and logs
   contain no read-model values or Redis keys.
2. Use `serve` for normal operation. Readiness should report `cache: "ready"`; a Redis
   outage may report `degraded` while HTTP continues through PostgreSQL.

The worker force-refreshes canonical models after writes and Plaid/Apple Card
ingestion, at startup, every six hours, after the nightly pipeline, and at UTC
or workspace-local date rollover. Rollback is one edit back to `off`; existing
keys expire without a delete operation.

Both `redis://` and `rediss://` endpoints are supported in production.

For GHCR, create a **personal access token (classic)** with only
`read:packages`, then put it in `ghcr_token`. The job uses the fixed GitHub
username `francisschmaltz`; the token's user must have read access to the private
`ghcr.io/francisschmaltz/money` package. Do not use a GitHub account password or
paste the token into this repository.

The Duo issuer must come from the Generic OIDC Relying Party Metadata tab.
`api-*.duosecurity.com/oauth/v1/*` is the MFA-only Auth API, not this
application's SSO issuer. Money discovers authorization, token, and JWKS
endpoints from
`${DUO_OIDC_ISSUER}/.well-known/openid-configuration`.

`database_ssl_reject_unauthorized=false` keeps the database connection
encrypted but disables certificate identity verification. It is the explicit
escape hatch for a private PostgreSQL server using a self-signed certificate;
do not replace it with the process-wide `NODE_TLS_REJECT_UNAUTHORIZED=0`.

### Rename the existing PostgreSQL role

The application role and database are both named `money`. For an existing
deployment that still uses `money_app`, stop the Money job and connect as a
PostgreSQL administrator:

```sql
ALTER ROLE money_app RENAME TO money;
\password money
ALTER DATABASE money OWNER TO money;
```

The rename preserves the role's grants and object ownership because PostgreSQL
tracks the role internally by ID. `\password` resets it without putting the new
password in shell or SQL history. Then change the Nomad `database_url` username
to `money`, URL-encode the new password, write the variable, and redeploy.

Plaid Item access tokens do **not** belong in Nomad Variables. The application
receives them dynamically and stores them in PostgreSQL's service-only
`plaid_item_secrets` table.

## Configure Plaid OAuth

In Plaid Dashboard, open **Developers → API → Allowed redirect URIs** and add:

```text
https://money.example.com/plaid/oauth
```

Use the exact URL: HTTPS, no wildcard, query string, fragment, or trailing
slash. Money derives it from `PUBLIC_BASE_URL`, sends it on both new and update
Link tokens, and resumes the original Link session there after Schwab,
Fidelity, or another OAuth institution returns.

The callback must be publicly reachable with a valid TLS certificate before
testing Production Link. It is an authenticated browser page, not a webhook;
keep `https://money.example.com/webhooks/plaid` as the separate server-to-server
webhook URL.

## Deploy

Each successful build from `main` publishes both:

```text
ghcr.io/francisschmaltz/money:latest
ghcr.io/francisschmaltz/money:sha-FULL_COMMIT_SHA
```

The Nomad job uses `latest`. Validate and submit the job once:

```bash
nomad job validate docs/nomad/money.nomad.hcl
nomad job plan docs/nomad/money.nomad.hcl
nomad job run docs/nomad/money.nomad.hcl
```

After a later `main` build finishes, use
[`nomad job restart`](https://developer.hashicorp.com/nomad/commands/job/restart)
to launch a new container:

```bash
nomad job restart -yes money
```

Nomad's
[Docker driver](https://developer.hashicorp.com/nomad/docs/job-declare/task-driver/docker)
always pulls an image tagged `latest` when the task starts. Merely publishing a
new image does not restart an unchanged job.

The Money process applies pending migrations before it starts the worker or
listens for HTTP traffic. Applied files are recorded in `schema_migrations`, so
restarts skip them.
Migrations are forward-only; a prior image is a safe rollback only when its
code remains compatible with the migrated schema.

## Verify

```bash
nomad job status money

curl --fail-with-body --silent --show-error \
  'https://money.example.com/health/live'

curl --fail-with-body --silent --show-error \
  'https://money.example.com/health/ready'
```

Then perform the authenticated checks:

1. Duo login with one non-admin and one admin.
2. Plaid Link or update mode from Settings.
3. A manual sync followed by recent transactions.
4. The Money task remains running and consumes queued sync/insight jobs.
5. The read bearer discovers 16 tools and the planning bearer discovers 27
   under connection `money`.
6. A fresh chat receives each of the 15 finance card kinds.

Readiness must fail when production configuration or PostgreSQL is unavailable.
Do not weaken it to make a broken rollout look green.
Redis is deliberately non-gating; inspect the separate `cache` field for
`disabled`, `warming`, `ready`, or `degraded`.

## Rotation

Update the secure variable document, then run `nomad var put` again. The job's
`change_mode = "restart"` templates restart affected tasks.

- Rotating `session_secret` signs everyone out.
- Rotating `mcp_bearer_token` requires updating Open WebUI immediately.
- Rotating `mcp_plan_write_token` requires updating the authorized Open WebUI connection immediately.
- If Money and `yb-mcp` share an Apple Maps key, rotate its key ID and private
  key in both Nomad Variable paths before restarting either job.
- Rotate Plaid/Duo credentials in their provider consoles first, then update
  Nomad.
- Never print variable contents into CI logs or ticket attachments.

## Rollback

GitHub still publishes immutable SHA tags. To roll back, change the job's
`image` line from `latest` to the last known-good SHA, then plan and run it:

```hcl
image = "ghcr.io/francisschmaltz/money:sha-PREVIOUS_FULL_COMMIT_SHA"
```

```bash
nomad job plan docs/nomad/money.nomad.hcl
nomad job run docs/nomad/money.nomad.hcl
```

If the new release applied a non-backward-compatible migration, stop. Rolling
back only the image can corrupt assumptions on both sides. Restore using the
documented database migration/backup procedure instead of improvising against
the finance database.

## Secret and log audit

Before production:

- Confirm allocation environment variables come from `secrets/money.env`.
- Confirm no secret is committed, baked into the image, or written to durable
  allocation storage.
- Confirm reporting/database users cannot select `plaid_item_secrets`.
- Confirm logs redact tokens, authorization, cookies, amounts, balances,
  merchants, descriptions, evidence, and request payloads.
- Confirm health responses include only state, never configuration values.
- Confirm database backups are encrypted and access-controlled; they contain
  plaintext Plaid access tokens in v1.
