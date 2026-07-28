# Nomad deployment

The checked-in [job specification](money.nomad.hcl) runs one
allocation containing:

- A one-shot prestart migration task.
- The Express web/MCP server.
- The PostgreSQL-backed finance worker.

Static secrets come only from the Nomad Variable path `nomad/jobs/money`.
There is no Vault integration and no application-layer encryption key.

HashiCorp's [Nomad Variables](https://developer.hashicorp.com/nomad/docs/concepts/variables)
and [`template` block](https://developer.hashicorp.com/nomad/docs/job-specification/template)
documentation describe the storage and workload-identity access model used by
the job.

## Prerequisites

- Nomad clients can pull the GHCR image.
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

Do not put a GHCR token in the job file. Configure registry authentication on
Nomad clients or use a narrowly scoped scheduler-supported credential.

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
| `database_url` | Application PostgreSQL role |
| `database_ssl` | Set to `true` in production so every database connection requires TLS |
| `plaid_client_id`, `plaid_secret` | Plaid environment credentials |
| `plaid_webhook_url` | Public signed-webhook endpoint |
| `duo_oidc_issuer` | Duo Generic OIDC issuer and discovery base |
| `duo_client_id`, `duo_client_secret` | OIDC relying-party credentials |
| `duo_authorization_url`, `duo_token_url` | Optional exact discovery consistency checks; empty is valid |
| `duo_redirect_uri` | Exact Money OIDC callback registered in Duo |
| `duo_admin_emails` | Users allowed to mutate shared finance data |
| `session_secret` | Express session signing; at least 32 random bytes |
| `mcp_bearer_token` | Read access to the full shared workspace |
| `mcp_plan_write_token` | Read plus audited family-plan writes; must differ from the read token |
| `lm_studio_*` | Optional aggregate narrative service |

Leave the optional Duo endpoint checks and LM Studio values as empty strings if
unused. Do not remove their keys from the variable document: the job template
references them.

The Duo issuer must come from the Generic OIDC Relying Party Metadata tab.
`api-*.duosecurity.com/oauth/v1/*` is the MFA-only Auth API, not this
application's SSO issuer. Money discovers authorization, token, and JWKS
endpoints from
`${DUO_OIDC_ISSUER}/.well-known/openid-configuration`.

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

## Deploy an immutable image

GitHub Actions publishes:

```text
ghcr.io/francisschmaltz/money:sha-FULL_COMMIT_SHA
```

Use the full SHA tag. `latest` is a moving target wearing a fake mustache.

```bash
export MONEY_IMAGE='ghcr.io/francisschmaltz/money:sha-FULL_COMMIT_SHA'

nomad job validate \
  -var="image=${MONEY_IMAGE}" \
  docs/nomad/money.nomad.hcl

nomad job plan \
  -var="image=${MONEY_IMAGE}" \
  docs/nomad/money.nomad.hcl

nomad job run \
  -var="image=${MONEY_IMAGE}" \
  docs/nomad/money.nomad.hcl
```

The migration task runs `npm run migrate` before the server and worker. Applied
files are recorded in `schema_migrations`, so restarts do not replay them.
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
4. Worker remains running and consumes queued sync/insight jobs.
5. The read bearer discovers 15 tools and the planning bearer discovers 24
   under connection `money`.
6. A fresh chat receives each of the 15 finance card kinds.

Readiness must fail when production configuration or PostgreSQL is unavailable.
Do not weaken it to make a broken rollout look green.

## Rotation

Update the secure variable document, then run `nomad var put` again. The job's
`change_mode = "restart"` templates restart affected tasks.

- Rotating `session_secret` signs everyone out.
- Rotating `mcp_bearer_token` requires updating Open WebUI immediately.
- Rotating `mcp_plan_write_token` requires updating the authorized Open WebUI connection immediately.
- Rotate Plaid/Duo credentials in their provider consoles first, then update
  Nomad.
- Never print variable contents into CI logs or ticket attachments.

## Rollback

Plan and run the last known-good SHA:

```bash
export MONEY_IMAGE='ghcr.io/francisschmaltz/money:sha-PREVIOUS_FULL_COMMIT_SHA'
nomad job plan -var="image=${MONEY_IMAGE}" docs/nomad/money.nomad.hcl
nomad job run -var="image=${MONEY_IMAGE}" docs/nomad/money.nomad.hcl
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
