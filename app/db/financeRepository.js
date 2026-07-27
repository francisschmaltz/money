import { randomUUID } from "node:crypto";
import { withTransaction } from "./pool.js";
import { stableId } from "../services/ids.js";

const DEFAULT_WORKSPACE_ID = "shared";
const BALANCE_GROUPS = new Set([
  "cash",
  "taxable_investment",
  "retirement",
  "credit_card",
  "loan",
  "other_asset",
  "other_liability",
  "excluded",
]);
const MANUAL_ASSET_TYPES = new Set([
  "vehicle",
  "real_estate",
  "business",
  "collectible",
  "other",
]);
const RETIREMENT_SUBTYPES = new Set([
  "401a",
  "401k",
  "403b",
  "457b",
  "annuity",
  "fixed_annuity",
  "health_savings_account",
  "hsa",
  "ira",
  "keogh",
  "lif",
  "lira",
  "lrif",
  "lrsp",
  "non_taxable_brokerage",
  "non_taxable_brokerage_account",
  "pension",
  "prif",
  "profit_sharing",
  "profit_sharing_plan",
  "retirement",
  "rlif",
  "roth",
  "roth_401k",
  "roth_ira",
  "rrif",
  "rrsp",
  "sarsep",
  "sep_ira",
  "simple_ira",
  "sipp",
  "thrift_savings",
  "thrift_savings_plan",
  "traditional_ira",
  "variable_annuity",
]);
const RETIREMENT_SUBTYPES_SQL = [...RETIREMENT_SUBTYPES]
  .map((value) => `'${value}'`)
  .join(", ");

function integer(value) {
  return value == null ? null : Number(value);
}

function dateValue(value) {
  return value == null ? null : new Date(value).toISOString();
}

function encodeCursor(row) {
  return Buffer.from(
    JSON.stringify({ posted_on: row.posted_on, id: row.id }),
  ).toString("base64url");
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof value.posted_on !== "string" ||
      typeof value.id !== "string"
    ) {
      throw new Error("invalid shape");
    }
    return value;
  } catch {
    throw new TypeError("Invalid transaction cursor");
  }
}

function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeTagName(value) {
  const name = String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedName = normalizeSearchText(name);
  if (
    !name ||
    name.length > 64 ||
    !normalizedName ||
    normalizedName.length > 64
  ) {
    throw new TypeError("tags must contain names between 1 and 64 characters");
  }
  return { name, normalized_name: normalizedName };
}

function normalizeEnum(value, allowed, fieldName, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!allowed.has(normalized)) {
    throw new TypeError(`${fieldName} is invalid`);
  }
  return normalized;
}

function normalizeCurrencyCode(value = "USD") {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new TypeError("currencyCode must be a three-letter ISO code");
  }
  return normalized;
}

function normalizeDateOnly(value, fieldName) {
  const normalized =
    value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value ?? "");
  const parsed = new Date(`${normalized}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(normalized) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized
  ) {
    throw new TypeError(`${fieldName} must be an ISO date`);
  }
  return normalized;
}

function normalizeManualAssetName(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 120) {
    throw new TypeError("name must be between 1 and 120 characters");
  }
  return normalized;
}

function normalizeManualAssetDescription(value) {
  if (value == null) return null;
  const normalized = String(value).trim() || null;
  if (normalized != null && normalized.length > 500) {
    throw new TypeError("description must be at most 500 characters");
  }
  return normalized;
}

function normalizeCreditScoreText(
  value,
  fieldName,
  maximum,
  { nullable = false } = {},
) {
  if (nullable && (value == null || String(value).trim() === "")) {
    return null;
  }
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.length > maximum) {
    throw new TypeError(
      `${fieldName} must be between 1 and ${maximum} characters`,
    );
  }
  return normalized;
}

function normalizeCreditScore(value) {
  const normalized = Number(value);
  if (
    !Number.isInteger(normalized) ||
    normalized < 300 ||
    normalized > 850
  ) {
    throw new TypeError("score must be an integer between 300 and 850");
  }
  return normalized;
}

function normalizeNonnegativeMinor(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError("valueMinor must be a non-negative safe integer");
  }
  return normalized;
}

function inferBalanceGroup(account) {
  if (BALANCE_GROUPS.has(account.balance_group_override)) {
    return account.balance_group_override;
  }
  const type = normalizeSearchText(account.type).replaceAll(" ", "_");
  const subtype = normalizeSearchText(account.subtype).replaceAll(" ", "_");
  if (type === "credit" || subtype === "credit_card") return "credit_card";
  if (type === "loan") return "loan";
  if (account.is_liability) return "other_liability";
  if (type === "investment" || type === "brokerage") {
    return RETIREMENT_SUBTYPES.has(subtype)
      ? "retirement"
      : "taxable_investment";
  }
  if (type === "depository" || type === "cash") return "cash";
  return "other_asset";
}

export class PgFinanceRepository {
  #pool;

  constructor(pool) {
    this.#pool = pool;
  }

  async #refreshAccountSearchDocument(
    client,
    workspaceId,
    accountId,
  ) {
    await client.query(
      `
        DELETE FROM search_documents
        WHERE workspace_id = $1
          AND entity_type = 'account'
          AND entity_id = $2
      `,
      [workspaceId, accountId],
    );
    await client.query(
      `
        INSERT INTO search_documents (
          id, workspace_id, entity_type, entity_id, title, subtitle,
          search_text, normalized_text, metadata
        )
        SELECT
          'account:' || a.id, a.workspace_id, 'account', a.id, a.name,
          concat_ws(' · ', a.institution_name, a.type, a.mask),
          concat_ws(
            ' ',
            a.name,
            a.official_name,
            a.institution_name,
            a.type,
            a.subtype,
            a.mask,
            COALESCE(
              a.balance_group_override,
              CASE
                WHEN a.type = 'credit' OR a.subtype = 'credit card'
                  THEN 'credit_card'
                WHEN a.type = 'loan' THEN 'loan'
                WHEN a.is_liability THEN 'other_liability'
                WHEN a.type IN ('investment', 'brokerage')
                  AND regexp_replace(
                    lower(COALESCE(a.subtype, '')),
                    '[^a-z0-9]+',
                    '_',
                    'g'
                  ) IN (${RETIREMENT_SUBTYPES_SQL})
                  THEN 'retirement'
                WHEN a.type IN ('investment', 'brokerage')
                  THEN 'taxable_investment'
                WHEN a.type IN ('depository', 'cash') THEN 'cash'
                ELSE 'other_asset'
              END
            )
          ),
          lower(regexp_replace(
            concat_ws(
              ' ',
              a.name,
              a.official_name,
              a.institution_name,
              a.type,
              a.subtype,
              a.mask,
              COALESCE(a.balance_group_override, '')
            ),
            '[^[:alnum:]]+',
            ' ',
            'g'
          )),
          jsonb_strip_nulls(
            jsonb_build_object(
              'type', a.type,
              'mask', a.mask,
              'balance_group_override', a.balance_group_override
            )
          )
        FROM accounts a
        WHERE a.workspace_id = $1
          AND a.id = $2
          AND a.active = true
        ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
          title = EXCLUDED.title,
          subtitle = EXCLUDED.subtitle,
          search_text = EXCLUDED.search_text,
          normalized_text = EXCLUDED.normalized_text,
          metadata = EXCLUDED.metadata,
          updated_at = now()
      `,
      [workspaceId, accountId],
    );
  }

  async #refreshManualAssetSearchDocument(
    client,
    workspaceId,
    assetId,
  ) {
    await client.query(
      `
        DELETE FROM search_documents
        WHERE workspace_id = $1
          AND entity_type = 'manual_asset'
          AND entity_id = $2
      `,
      [workspaceId, assetId],
    );
    await client.query(
      `
        INSERT INTO search_documents (
          id, workspace_id, entity_type, entity_id, title, subtitle,
          search_text, normalized_text, metadata
        )
        SELECT
          'manual_asset:' || a.id,
          a.workspace_id,
          'manual_asset',
          a.id,
          a.name,
          concat_ws(
            ' · ',
            initcap(replace(a.asset_type, '_', ' ')),
            latest.currency_code
          ),
          concat_ws(' ', a.name, a.asset_type, a.description),
          lower(regexp_replace(
            concat_ws(' ', a.name, a.asset_type, a.description),
            '[^[:alnum:]]+',
            ' ',
            'g'
          )),
          jsonb_strip_nulls(
            jsonb_build_object(
              'asset_type', a.asset_type,
              'value_minor', latest.value_minor,
              'currency_code', latest.currency_code,
              'valued_on', latest.valued_on
            )
          )
        FROM manual_assets a
        LEFT JOIN LATERAL (
          SELECT value_minor, currency_code, valued_on
          FROM manual_asset_valuations
          WHERE asset_id = a.id
            AND valued_on <= (now() AT TIME ZONE 'UTC')::date
          ORDER BY valued_on DESC
          LIMIT 1
        ) latest ON true
        WHERE a.workspace_id = $1
          AND a.id = $2
          AND a.active = true
        ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
          title = EXCLUDED.title,
          subtitle = EXCLUDED.subtitle,
          search_text = EXCLUDED.search_text,
          normalized_text = EXCLUDED.normalized_text,
          metadata = EXCLUDED.metadata,
          updated_at = now()
      `,
      [workspaceId, assetId],
    );
  }

  async #refreshTransactionSearchDocuments(
    client,
    workspaceId,
    transactionIds,
  ) {
    const ids = [...new Set(transactionIds)];
    if (!ids.length) return;
    await client.query(
      `
        DELETE FROM search_documents
        WHERE workspace_id = $1
          AND entity_type = 'transaction'
          AND entity_id = ANY($2::text[])
      `,
      [workspaceId, ids],
    );
    await client.query(
      `
        INSERT INTO search_documents (
          id, workspace_id, entity_type, entity_id, title, subtitle,
          search_text, normalized_text, metadata
        )
        SELECT
          'transaction:' || t.id,
          t.workspace_id,
          'transaction',
          t.id,
          COALESCE(
            metadata.display_name,
            cleanup_rule.display_name,
            t.merchant_name,
            t.name
          ),
          concat_ws(
            ' · ',
            a.name,
            COALESCE(
              transaction_override.category_primary,
              cleanup_rule.category_primary,
              merchant_override.category_primary,
              original_transaction_override.category_primary,
              original_cleanup_rule.category_primary,
              original_merchant_override.category_primary,
              original.category_primary,
              t.category_primary
            ),
            t.posted_on::text
          ),
          concat_ws(
            ' ',
            metadata.display_name,
            cleanup_rule.display_name,
            t.merchant_name,
            t.name,
            COALESCE(
              transaction_override.category_primary,
              cleanup_rule.category_primary,
              merchant_override.category_primary,
              original_transaction_override.category_primary,
              original_cleanup_rule.category_primary,
              original_merchant_override.category_primary,
              original.category_primary,
              t.category_primary
            ),
            COALESCE(
              transaction_override.category_detailed,
              merchant_override.category_detailed,
              original_transaction_override.category_detailed,
              original_merchant_override.category_detailed,
              original.category_detailed,
              t.category_detailed
            ),
            effective_tags.tag_names,
            a.name,
            a.institution_name
          ),
          lower(regexp_replace(
            concat_ws(
              ' ',
              metadata.display_name,
              cleanup_rule.display_name,
              t.merchant_name,
              t.name,
              COALESCE(
                transaction_override.category_primary,
                cleanup_rule.category_primary,
                merchant_override.category_primary,
                original_transaction_override.category_primary,
                original_cleanup_rule.category_primary,
                original_merchant_override.category_primary,
                original.category_primary,
                t.category_primary
              ),
              COALESCE(
                transaction_override.category_detailed,
                merchant_override.category_detailed,
                original_transaction_override.category_detailed,
                original_merchant_override.category_detailed,
                original.category_detailed,
                t.category_detailed
              ),
              effective_tags.tag_names,
              a.name,
              a.institution_name
            ),
            '[^[:alnum:]]+',
            ' ',
            'g'
          )),
          jsonb_strip_nulls(
            jsonb_build_object(
              'posted_on', t.posted_on,
              'amount_minor', t.amount_minor,
              'raw_merchant', t.merchant_name,
              'raw_name', t.name,
              'tags', effective_tags.tags
            )
          )
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        LEFT JOIN transaction_metadata metadata
          ON metadata.workspace_id = t.workspace_id
         AND metadata.transaction_id = t.id
        LEFT JOIN LATERAL (
          SELECT rule.*
          FROM transaction_cleanup_rules rule
          WHERE rule.workspace_id = t.workspace_id
            AND rule.enabled = true
            AND (
              (
                rule.match_field = 'normalized_merchant'
                AND rule.normalized_match_value = t.normalized_merchant
              )
              OR (
                rule.match_field = 'normalized_name'
                AND rule.normalized_match_value = t.normalized_name
              )
            )
          ORDER BY
            (rule.match_field = 'normalized_merchant') DESC,
            rule.updated_at DESC,
            rule.id
          LIMIT 1
        ) cleanup_rule ON true
        LEFT JOIN transactions original
          ON original.id = t.original_transaction_id
         AND original.workspace_id = t.workspace_id
        LEFT JOIN LATERAL (
          SELECT rule.*
          FROM transaction_cleanup_rules rule
          WHERE original.id IS NOT NULL
            AND rule.workspace_id = original.workspace_id
            AND rule.enabled = true
            AND (
              (
                rule.match_field = 'normalized_merchant'
                AND rule.normalized_match_value =
                    original.normalized_merchant
              )
              OR (
                rule.match_field = 'normalized_name'
                AND rule.normalized_match_value = original.normalized_name
              )
            )
          ORDER BY
            (rule.match_field = 'normalized_merchant') DESC,
            rule.updated_at DESC,
            rule.id
          LIMIT 1
        ) original_cleanup_rule ON true
        LEFT JOIN categorization_overrides transaction_override
          ON transaction_override.workspace_id = t.workspace_id
         AND transaction_override.transaction_id = t.id
        LEFT JOIN categorization_overrides merchant_override
          ON merchant_override.workspace_id = t.workspace_id
         AND merchant_override.transaction_id IS NULL
         AND merchant_override.normalized_merchant = t.normalized_merchant
        LEFT JOIN categorization_overrides original_transaction_override
          ON original_transaction_override.workspace_id = original.workspace_id
         AND original_transaction_override.transaction_id = original.id
        LEFT JOIN categorization_overrides original_merchant_override
          ON original_merchant_override.workspace_id = original.workspace_id
         AND original_merchant_override.transaction_id IS NULL
         AND original_merchant_override.normalized_merchant =
             original.normalized_merchant
        LEFT JOIN LATERAL (
          SELECT
            jsonb_agg(tag.name ORDER BY tag.normalized_name) AS tags,
            string_agg(tag.name, ' ' ORDER BY tag.normalized_name) AS tag_names
          FROM transaction_tag_assignments assignment
          JOIN transaction_tags tag
            ON tag.workspace_id = assignment.workspace_id
           AND tag.id = assignment.tag_id
          WHERE assignment.workspace_id = t.workspace_id
            AND assignment.transaction_id = t.id
        ) tag_data ON true
        LEFT JOIN LATERAL (
          SELECT
            CASE
              WHEN metadata.tags_overridden
                THEN COALESCE(tag_data.tags, '[]'::jsonb)
              WHEN cleanup_rule.tags IS NOT NULL
                THEN cleanup_rule.tags
              ELSE COALESCE(tag_data.tags, '[]'::jsonb)
            END AS tags,
            CASE
              WHEN metadata.tags_overridden
                THEN tag_data.tag_names
              WHEN cleanup_rule.tags IS NOT NULL
                THEN (
                  SELECT string_agg(value, ' ' ORDER BY value)
                  FROM jsonb_array_elements_text(cleanup_rule.tags)
                    AS cleanup_tag(value)
                )
              ELSE tag_data.tag_names
            END AS tag_names
        ) effective_tags ON true
        WHERE t.workspace_id = $1
          AND t.id = ANY($2::text[])
        ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
          title = EXCLUDED.title,
          subtitle = EXCLUDED.subtitle,
          search_text = EXCLUDED.search_text,
          normalized_text = EXCLUDED.normalized_text,
          metadata = EXCLUDED.metadata,
          updated_at = now()
      `,
      [workspaceId, ids],
    );
  }

  async #transactionIdsForCleanupRule(
    client,
    workspaceId,
    { match_field: matchField, normalized_match_value: matchValue },
  ) {
    const result = await client.query(
      `
        SELECT id
        FROM transactions
        WHERE workspace_id = $1
          AND (
            (
              $2 = 'normalized_merchant'
              AND normalized_merchant = $3
            )
            OR (
              $2 = 'normalized_name'
              AND normalized_name = $3
            )
          )
        ORDER BY id
      `,
      [workspaceId, matchField, matchValue],
    );
    return result.rows.map((row) => row.id);
  }

  async #transactionIdsUsingCleanupRule(
    client,
    workspaceId,
    ruleId,
  ) {
    const result = await client.query(
      `
        SELECT t.id
        FROM transactions t
        JOIN LATERAL (
          SELECT rule.id
          FROM transaction_cleanup_rules rule
          WHERE rule.workspace_id = t.workspace_id
            AND rule.enabled = true
            AND (
              (
                rule.match_field = 'normalized_merchant'
                AND rule.normalized_match_value = t.normalized_merchant
              )
              OR (
                rule.match_field = 'normalized_name'
                AND rule.normalized_match_value = t.normalized_name
              )
            )
          ORDER BY
            (rule.match_field = 'normalized_merchant') DESC,
            rule.updated_at DESC,
            rule.id
          LIMIT 1
        ) winner ON true
        WHERE t.workspace_id = $1
          AND t.pending = false
          AND winner.id = $2
        ORDER BY t.id
      `,
      [workspaceId, ruleId],
    );
    return result.rows.map((row) => row.id);
  }

  transaction(operation) {
    return withTransaction(this.#pool, operation);
  }

  async upsertUser(
    {
      id = randomUUID(),
      email,
      displayName = null,
      isAdmin = false,
      workspaceId = DEFAULT_WORKSPACE_ID,
    },
  ) {
    const normalizedEmail = String(email ?? "").trim().toLowerCase();
    if (!normalizedEmail) throw new TypeError("email is required");
    return withTransaction(this.#pool, async (client) => {
      const result = await client.query(
        `
          INSERT INTO users (
            id, email, display_name, is_admin, last_login_at
          )
          VALUES ($1, $2, $3, $4, now())
          ON CONFLICT (lower(email)) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            is_admin = EXCLUDED.is_admin,
            last_login_at = now(),
            updated_at = now()
          RETURNING id, email, display_name, is_admin, last_login_at
        `,
        [id, normalizedEmail, displayName, isAdmin],
      );
      const user = result.rows[0];
      await client.query(
        `
          INSERT INTO workspace_members (workspace_id, user_id)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
        `,
        [workspaceId, user.id],
      );
      return {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        is_admin: user.is_admin,
        last_login_at: dateValue(user.last_login_at),
      };
    });
  }

  async createPlaidItem(
    {
      id = randomUUID(),
      workspaceId = DEFAULT_WORKSPACE_ID,
      providerItemId,
      institutionId = null,
      institutionName = null,
      consentExpiresAt = null,
    },
    client = this.#pool,
  ) {
    const existing = await client.query(
      `
        SELECT connection_id
        FROM plaid_connection_details
        WHERE provider_item_id = $1
      `,
      [providerItemId],
    );
    const connectionId = existing.rows[0]?.connection_id ?? id;
    await client.query(
      `
        INSERT INTO finance_connections (
          id, workspace_id, provider, ingestion_method, freshness_mode,
          institution_name
        )
        VALUES ($1, $2, 'plaid', 'plaid', 'automatic', $3)
        ON CONFLICT (id) DO UPDATE SET
          institution_name = COALESCE(
            EXCLUDED.institution_name,
            finance_connections.institution_name
          ),
          status = 'active',
          error_code = NULL,
          updated_at = now()
      `,
      [connectionId, workspaceId, institutionName],
    );
    await client.query(
      `
        INSERT INTO plaid_connection_details (
          connection_id, provider_item_id, institution_id,
          consent_expires_at
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (provider_item_id) DO UPDATE SET
          institution_id = COALESCE(
            EXCLUDED.institution_id,
            plaid_connection_details.institution_id
          ),
          consent_expires_at = EXCLUDED.consent_expires_at
      `,
      [
        connectionId,
        providerItemId,
        institutionId,
        consentExpiresAt,
      ],
    );
    return this.getPlaidItem(connectionId, client);
  }

  async getPlaidItem(itemId, client = this.#pool) {
    const result = await client.query(
      `
        SELECT c.*, p.provider_item_id, p.institution_id,
               p.transactions_cursor, p.coverage_warnings,
               p.consent_expires_at
        FROM finance_connections c
        JOIN plaid_connection_details p ON p.connection_id = c.id
        WHERE c.id = $1
      `,
      [itemId],
    );
    return result.rows[0] ? mapPlaidItem(result.rows[0]) : null;
  }

  async getPlaidItemByProviderId(
    providerItemId,
    client = this.#pool,
  ) {
    const result = await client.query(
      `
        SELECT c.*, p.provider_item_id, p.institution_id,
               p.transactions_cursor, p.coverage_warnings,
               p.consent_expires_at
        FROM finance_connections c
        JOIN plaid_connection_details p ON p.connection_id = c.id
        WHERE p.provider_item_id = $1
      `,
      [providerItemId],
    );
    return result.rows[0] ? mapPlaidItem(result.rows[0]) : null;
  }

  async listPlaidItems(
    workspaceId = DEFAULT_WORKSPACE_ID,
    client = this.#pool,
  ) {
    const result = await client.query(
      `
        SELECT c.*, p.provider_item_id, p.institution_id,
               p.transactions_cursor, p.coverage_warnings,
               p.consent_expires_at
        FROM finance_connections c
        JOIN plaid_connection_details p ON p.connection_id = c.id
        WHERE c.workspace_id = $1
          AND c.provider = 'plaid'
          AND c.status <> 'removed'
        ORDER BY c.institution_name NULLS LAST, c.created_at
      `,
      [workspaceId],
    );
    return result.rows.map(mapPlaidItem);
  }

  async listFinanceConnections(
    workspaceId = DEFAULT_WORKSPACE_ID,
    client = this.#pool,
  ) {
    const result = await client.query(
      `
        SELECT
          c.*,
          p.institution_id,
          latest.imported_at AS last_imported_at,
          latest.total_row_count AS last_total_row_count,
          latest.new_row_count AS last_new_row_count,
          latest.existing_row_count AS last_existing_row_count,
          latest.rejected_row_count AS last_rejected_row_count,
          latest.warning_count AS last_warning_count,
          a.id AS account_id,
          a.mask,
          a.current_balance_minor,
          a.credit_limit_minor,
          (
            c.freshness_mode = 'manual'
            AND (
              c.imported_through_on IS NULL
              OR c.imported_through_on < current_date - 7
            )
          ) AS manual_update_due
        FROM finance_connections c
        LEFT JOIN plaid_connection_details p ON p.connection_id = c.id
        LEFT JOIN accounts a
          ON a.connection_id = c.id
         AND c.provider = 'apple_card'
        LEFT JOIN LATERAL (
          SELECT *
          FROM apple_card_imports imported
          WHERE imported.connection_id = c.id
          ORDER BY imported.imported_at DESC
          LIMIT 1
        ) latest ON true
        WHERE c.workspace_id = $1
          AND c.status <> 'removed'
        ORDER BY c.provider, c.institution_name NULLS LAST, c.created_at
      `,
      [workspaceId],
    );
    return result.rows.map(mapFinanceConnection);
  }

  async getAppleCardConnection(
    workspaceId = DEFAULT_WORKSPACE_ID,
    client = this.#pool,
  ) {
    const result = await client.query(
      `
        SELECT
          c.*,
          a.id AS account_id,
          a.mask,
          a.current_balance_minor,
          a.credit_limit_minor
        FROM finance_connections c
        LEFT JOIN accounts a ON a.connection_id = c.id
        WHERE c.workspace_id = $1
          AND c.provider = 'apple_card'
          AND c.status <> 'removed'
        ORDER BY c.created_at
        LIMIT 1
      `,
      [workspaceId],
    );
    return result.rows[0] ? mapFinanceConnection(result.rows[0]) : null;
  }

  async findExistingTransactionProviderIds(
    workspaceId = DEFAULT_WORKSPACE_ID,
    providerTransactionIds = [],
    client = this.#pool,
  ) {
    if (!providerTransactionIds.length) return [];
    const result = await client.query(
      `
        SELECT provider_transaction_id
        FROM transactions
        WHERE workspace_id = $1
          AND provider_transaction_id = ANY($2::text[])
      `,
      [workspaceId, providerTransactionIds],
    );
    return result.rows.map((row) => row.provider_transaction_id);
  }

  async importAppleCardTransactions({
    workspaceId = DEFAULT_WORKSPACE_ID,
    parsed,
    balanceMinor = null,
    creditLimitMinor = null,
    balanceAsOf = null,
    lastFour = null,
    actorId = null,
    importedAt = new Date(),
  }) {
    return withTransaction(this.#pool, async (client) => {
      const connectionId = stableId(
        "connection",
        `${workspaceId}:apple-card`,
      );
      const accountId = stableId("account", `${workspaceId}:apple-card`);
      await client.query(
        `
          INSERT INTO finance_connections (
            id, workspace_id, provider, ingestion_method, freshness_mode,
            institution_name, status
          )
          VALUES (
            $1, $2, 'apple_card', 'csv', 'manual', 'Apple Card', 'active'
          )
          ON CONFLICT (id) DO UPDATE SET
            ingestion_method = 'csv',
            freshness_mode = 'manual',
            institution_name = 'Apple Card',
            status = 'active',
            error_code = NULL,
            updated_at = now()
        `,
        [connectionId, workspaceId],
      );
      await client.query(
        `
          INSERT INTO accounts (
            id, workspace_id, connection_id, provider_account_id,
            institution_name, name, official_name, mask, type, subtype,
            currency_code, current_balance_minor, available_balance_minor,
            credit_limit_minor, is_liability, active, last_synced_at
          )
          VALUES (
            $1, $2, $3, $4, 'Apple Card', 'Apple Card', 'Apple Card',
            $5, 'credit', 'credit_card', 'USD', $6, NULL, $7, true, true, $8
          )
          ON CONFLICT (provider_account_id) DO UPDATE SET
            connection_id = EXCLUDED.connection_id,
            mask = COALESCE(EXCLUDED.mask, accounts.mask),
            current_balance_minor = COALESCE(
              EXCLUDED.current_balance_minor,
              accounts.current_balance_minor
            ),
            credit_limit_minor = COALESCE(
              EXCLUDED.credit_limit_minor,
              accounts.credit_limit_minor
            ),
            active = true,
            last_synced_at = EXCLUDED.last_synced_at,
            updated_at = now()
        `,
        [
          accountId,
          workspaceId,
          connectionId,
          `apple-card:${workspaceId}`,
          lastFour,
          balanceMinor,
          creditLimitMinor,
          importedAt,
        ],
      );
      await client.query(
        `
          UPDATE accounts
          SET available_balance_minor =
                credit_limit_minor - GREATEST(current_balance_minor, 0),
              updated_at = now()
          WHERE id = $1
            AND current_balance_minor IS NOT NULL
            AND credit_limit_minor IS NOT NULL
        `,
        [accountId],
      );

      const existingIds = await this.findExistingTransactionProviderIds(
        workspaceId,
        parsed.transactions.map((row) => row.provider_transaction_id),
        client,
      );
      const existingCount = existingIds.length;
      await client.query(
        `
          INSERT INTO transactions (
            id, workspace_id, account_id, provider_transaction_id,
            provider_pending_transaction_id, merchant_name,
            normalized_merchant, name, normalized_name, category_primary,
            category_detailed, amount_minor, currency_code, authorized_on,
            posted_on, pending, excluded_from_spending, payment_channel,
            cardholder_name, source_transaction_type
          )
          SELECT
            r.id, $2, $3, r.provider_transaction_id,
            r.provider_pending_transaction_id, r.merchant_name,
            r.normalized_merchant, r.name, r.normalized_name,
            r.category_primary, r.category_detailed, r.amount_minor,
            r.currency_code, r.authorized_on, r.posted_on, r.pending,
            r.excluded_from_spending, r.payment_channel,
            r.cardholder_name, r.source_transaction_type
          FROM jsonb_to_recordset($1::jsonb) AS r(
            id text,
            provider_transaction_id text,
            provider_pending_transaction_id text,
            merchant_name text,
            normalized_merchant text,
            name text,
            normalized_name text,
            category_primary text,
            category_detailed text,
            amount_minor bigint,
            currency_code char(3),
            authorized_on date,
            posted_on date,
            pending boolean,
            excluded_from_spending boolean,
            payment_channel text,
            cardholder_name text,
            source_transaction_type text
          )
          ON CONFLICT (provider_transaction_id) DO UPDATE SET
            account_id = EXCLUDED.account_id,
            merchant_name = EXCLUDED.merchant_name,
            normalized_merchant = EXCLUDED.normalized_merchant,
            name = EXCLUDED.name,
            normalized_name = EXCLUDED.normalized_name,
            category_primary = EXCLUDED.category_primary,
            category_detailed = EXCLUDED.category_detailed,
            amount_minor = EXCLUDED.amount_minor,
            currency_code = EXCLUDED.currency_code,
            authorized_on = EXCLUDED.authorized_on,
            posted_on = EXCLUDED.posted_on,
            pending = false,
            excluded_from_spending = EXCLUDED.excluded_from_spending,
            payment_channel = EXCLUDED.payment_channel,
            cardholder_name = EXCLUDED.cardholder_name,
            source_transaction_type = EXCLUDED.source_transaction_type,
            updated_at = now()
        `,
        [JSON.stringify(parsed.transactions), workspaceId, accountId],
      );

      await client.query(
        `
          UPDATE finance_connections
          SET imported_through_on = CASE
                WHEN imported_through_on IS NULL THEN $2
                ELSE GREATEST(imported_through_on, $2)
              END,
              balance_as_of = COALESCE($3, balance_as_of),
              status = 'active',
              error_code = NULL,
              updated_at = now()
          WHERE id = $1
        `,
        [connectionId, parsed.posted_end_on, balanceAsOf],
      );
      if (balanceAsOf != null) {
        await client.query(
          `
            INSERT INTO daily_account_snapshots (
              workspace_id, account_id, snapshot_on,
              current_balance_minor, available_balance_minor,
              credit_limit_minor, currency_code
            )
            SELECT
              workspace_id, id, $2, current_balance_minor,
              available_balance_minor, credit_limit_minor, currency_code
            FROM accounts
            WHERE id = $1
            ON CONFLICT (account_id, snapshot_on) DO UPDATE SET
              current_balance_minor = EXCLUDED.current_balance_minor,
              available_balance_minor = EXCLUDED.available_balance_minor,
              credit_limit_minor = EXCLUDED.credit_limit_minor,
              currency_code = EXCLUDED.currency_code
          `,
          [accountId, balanceAsOf],
        );
      }

      const newCount = parsed.accepted_row_count - existingCount;
      await client.query(
        `
          INSERT INTO apple_card_imports (
            id, workspace_id, connection_id, file_digest,
            posted_start_on, posted_end_on, total_row_count,
            accepted_row_count, new_row_count, existing_row_count,
            rejected_row_count, warning_count, actor_id, imported_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
          )
        `,
        [
          randomUUID(),
          workspaceId,
          connectionId,
          parsed.digest,
          parsed.posted_start_on,
          parsed.posted_end_on,
          parsed.total_row_count,
          parsed.accepted_row_count,
          newCount,
          existingCount,
          parsed.rejected_row_count,
          parsed.warning_count,
          actorId,
          importedAt,
        ],
      );
      await this.#refreshTransactionSearchDocuments(
        client,
        workspaceId,
        parsed.transactions.map((row) => row.id),
      );
      await this.#refreshAccountSearchDocument(
        client,
        workspaceId,
        accountId,
      );
      return {
        connection_id: connectionId,
        account_id: accountId,
        imported_through_on: parsed.posted_end_on,
        balance_as_of: balanceAsOf,
        accepted_row_count: parsed.accepted_row_count,
        new_row_count: newCount,
        existing_row_count: existingCount,
        rejected_row_count: parsed.rejected_row_count,
        warning_count: parsed.warning_count,
      };
    });
  }

  async updateAppleCardAccount({
    workspaceId = DEFAULT_WORKSPACE_ID,
    balanceMinor,
    creditLimitMinor,
    balanceAsOf,
    lastFour = null,
    updatedAt = new Date(),
  }) {
    return withTransaction(this.#pool, async (client) => {
      const result = await client.query(
        `
          UPDATE accounts a
          SET current_balance_minor = $2,
              credit_limit_minor = $3,
              available_balance_minor = $3 - GREATEST($2::bigint, 0),
              mask = COALESCE($4, a.mask),
              last_synced_at = $5,
              updated_at = now()
          FROM finance_connections c
          WHERE c.id = a.connection_id
            AND c.workspace_id = $1
            AND c.provider = 'apple_card'
            AND c.status <> 'removed'
          RETURNING a.*, c.id AS connection_id
        `,
        [
          workspaceId,
          balanceMinor,
          creditLimitMinor,
          lastFour,
          updatedAt,
        ],
      );
      const row = result.rows[0];
      if (!row) return null;
      await client.query(
        `
          UPDATE finance_connections
          SET balance_as_of = $2,
              updated_at = now()
          WHERE id = $1
        `,
        [row.connection_id, balanceAsOf],
      );
      await client.query(
        `
          INSERT INTO daily_account_snapshots (
            workspace_id, account_id, snapshot_on,
            current_balance_minor, available_balance_minor,
            credit_limit_minor, currency_code
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'USD')
          ON CONFLICT (account_id, snapshot_on) DO UPDATE SET
            current_balance_minor = EXCLUDED.current_balance_minor,
            available_balance_minor = EXCLUDED.available_balance_minor,
            credit_limit_minor = EXCLUDED.credit_limit_minor
        `,
        [
          workspaceId,
          row.id,
          balanceAsOf,
          balanceMinor,
          creditLimitMinor - Math.max(balanceMinor, 0),
          creditLimitMinor,
        ],
      );
      await this.#refreshAccountSearchDocument(
        client,
        workspaceId,
        row.id,
      );
      return {
        connection_id: row.connection_id,
        account_id: row.id,
        balance_as_of: balanceAsOf,
        current_balance_minor: balanceMinor,
        credit_limit_minor: creditLimitMinor,
      };
    });
  }

  async updatePlaidItemState(
    itemId,
    {
      status,
      errorCode = null,
      cursor,
      lastSyncedAt,
      coverageWarnings,
    },
    client = this.#pool,
  ) {
    await client.query(
      `
        UPDATE finance_connections
        SET status = COALESCE($2, status),
            error_code = $3,
            last_synced_at = COALESCE($4, last_synced_at),
            updated_at = now()
        WHERE id = $1
      `,
      [
        itemId,
        status ?? null,
        errorCode,
        lastSyncedAt ?? null,
      ],
    );
    await client.query(
      `
        UPDATE plaid_connection_details
        SET transactions_cursor = COALESCE($2, transactions_cursor),
            coverage_warnings = COALESCE($3::jsonb, coverage_warnings)
        WHERE connection_id = $1
      `,
      [
        itemId,
        cursor ?? null,
        coverageWarnings === undefined
          ? null
          : JSON.stringify(coverageWarnings),
      ],
    );
    return this.getPlaidItem(itemId, client);
  }

  async removePlaidItem(itemId, { retainHistory = false } = {}) {
    return this.removeFinanceConnection(itemId, { retainHistory });
  }

  async removeFinanceConnection(
    connectionId,
    { retainHistory = false } = {},
  ) {
    return withTransaction(this.#pool, async (client) => {
      const item = await client.query(
        `
          SELECT workspace_id
          FROM finance_connections
          WHERE id = $1
          FOR UPDATE
        `,
        [connectionId],
      );
      const workspaceId = item.rows[0]?.workspace_id;
      if (!workspaceId) return false;

      if (retainHistory) {
        await client.query(
          `
            UPDATE accounts
            SET active = false, updated_at = now()
            WHERE connection_id = $1
          `,
          [connectionId],
        );
        await client.query(
          `
            UPDATE recurring_streams
            SET status = 'canceled',
                next_expected_on = NULL,
                updated_at = now()
            WHERE workspace_id = $2
              AND account_id IN (
                SELECT id
                FROM accounts
                WHERE connection_id = $1
              )
              AND status <> 'dismissed'
          `,
          [connectionId, workspaceId],
        );
        await client.query(
          `
            DELETE FROM search_documents
            WHERE workspace_id = $2
              AND (
                (
                  entity_type = 'account'
                  AND entity_id IN (
                    SELECT id
                    FROM accounts
                    WHERE connection_id = $1
                  )
                )
                OR (
                  entity_type = 'recurring'
                  AND entity_id IN (
                    SELECT r.id
                    FROM recurring_streams r
                    JOIN accounts a ON a.id = r.account_id
                    WHERE a.connection_id = $1
                  )
                )
                OR entity_type = 'insight'
              )
          `,
          [connectionId, workspaceId],
        );
        await client.query(
          "DELETE FROM insight_narratives WHERE workspace_id = $1",
          [workspaceId],
        );
        await client.query(
          `
            UPDATE insight_findings
            SET is_current = false,
                retired_at = COALESCE(retired_at, now())
            WHERE workspace_id = $1
              AND is_current = true
          `,
          [workspaceId],
        );
        await client.query(
          `
            UPDATE finance_connections
            SET status = 'removed',
                error_code = NULL,
                updated_at = now()
            WHERE id = $1
          `,
          [connectionId],
        );
        await client.query(
          `
            UPDATE plaid_connection_details
            SET transactions_cursor = NULL
            WHERE connection_id = $1
          `,
          [connectionId],
        );
        return true;
      }

      await client.query(
        `
          DELETE FROM search_documents
          WHERE workspace_id = $2
            AND (
              (
                entity_type = 'account'
                AND entity_id IN (
                  SELECT id
                  FROM accounts
                  WHERE connection_id = $1
                )
              )
              OR (
                entity_type = 'transaction'
                AND entity_id IN (
                  SELECT t.id
                  FROM transactions t
                  JOIN accounts a ON a.id = t.account_id
                  WHERE a.connection_id = $1
                )
              )
              OR (
                entity_type = 'recurring'
                AND entity_id IN (
                  SELECT r.id
                  FROM recurring_streams r
                  JOIN accounts a ON a.id = r.account_id
                  WHERE a.connection_id = $1
                )
              )
              OR entity_type = 'insight'
            )
        `,
        [connectionId, workspaceId],
      );
      await client.query(
        `
          DELETE FROM recurring_streams
          WHERE workspace_id = $2
            AND account_id IN (
              SELECT id
              FROM accounts
              WHERE connection_id = $1
            )
        `,
        [connectionId, workspaceId],
      );
      await client.query(
        "DELETE FROM insight_narratives WHERE workspace_id = $1",
        [workspaceId],
      );
      await client.query(
        "DELETE FROM insight_findings WHERE workspace_id = $1",
        [workspaceId],
      );
      await client.query(
        "DELETE FROM finance_connections WHERE id = $1",
        [connectionId],
      );
      return true;
    });
  }

  async upsertAccounts(
    itemId,
    accounts,
    { syncedAt = new Date() } = {},
    client = this.#pool,
  ) {
    if (!accounts.length) return;
    await client.query(
      `
        INSERT INTO accounts (
          id, workspace_id, connection_id, provider_account_id, institution_name,
          name, official_name, mask, type, subtype, currency_code,
          current_balance_minor, available_balance_minor, credit_limit_minor,
          is_liability, active, last_synced_at
        )
        SELECT
          r.id, i.workspace_id, i.id, r.provider_account_id, r.institution_name,
          r.name, r.official_name, r.mask, r.type, r.subtype, r.currency_code,
          r.current_balance_minor, r.available_balance_minor, r.credit_limit_minor,
          r.is_liability, true, $3
        FROM jsonb_to_recordset($2::jsonb) AS r(
          id text,
          provider_account_id text,
          institution_name text,
          name text,
          official_name text,
          mask text,
          type text,
          subtype text,
          currency_code char(3),
          current_balance_minor bigint,
          available_balance_minor bigint,
          credit_limit_minor bigint,
          is_liability boolean
        )
        CROSS JOIN finance_connections i
        WHERE i.id = $1
        ON CONFLICT (provider_account_id) DO UPDATE SET
          institution_name = EXCLUDED.institution_name,
          name = EXCLUDED.name,
          official_name = EXCLUDED.official_name,
          mask = EXCLUDED.mask,
          type = EXCLUDED.type,
          subtype = EXCLUDED.subtype,
          currency_code = EXCLUDED.currency_code,
          current_balance_minor = EXCLUDED.current_balance_minor,
          available_balance_minor = EXCLUDED.available_balance_minor,
          credit_limit_minor = EXCLUDED.credit_limit_minor,
          is_liability = EXCLUDED.is_liability,
          active = true,
          last_synced_at = EXCLUDED.last_synced_at,
          updated_at = now()
      `,
      [itemId, JSON.stringify(accounts), syncedAt],
    );
  }

  async deactivateMissingAccounts(
    itemId,
    activeProviderAccountIds,
    client = this.#pool,
  ) {
    await client.query(
      `
        UPDATE accounts
        SET active = false, updated_at = now()
        WHERE connection_id = $1
          AND NOT (provider_account_id = ANY($2::text[]))
      `,
      [itemId, activeProviderAccountIds],
    );
  }

  async applyTransactionSync(
    {
      itemId,
      added = [],
      modified = [],
      removedProviderIds = [],
      cursor,
      syncedAt = new Date(),
    },
  ) {
    const changed = [...added, ...modified];
    await withTransaction(this.#pool, async (client) => {
      if (removedProviderIds.length) {
        await client.query(
          `
            DELETE FROM transactions
            WHERE provider_transaction_id = ANY($1::text[])
              AND account_id IN (
                SELECT id FROM accounts WHERE connection_id = $2
              )
          `,
          [removedProviderIds, itemId],
        );
      }

      if (changed.length) {
        await client.query(
          `
            INSERT INTO transactions (
              id, workspace_id, account_id, provider_transaction_id,
              provider_pending_transaction_id, merchant_name, normalized_merchant,
              name, normalized_name, category_primary, category_detailed, amount_minor,
              currency_code, authorized_at, posted_on, pending,
              excluded_from_spending, original_transaction_id,
              payment_channel
            )
            SELECT
              r.id, a.workspace_id, a.id, r.provider_transaction_id,
              r.provider_pending_transaction_id, r.merchant_name,
              r.normalized_merchant, r.name, r.normalized_name, r.category_primary,
              r.category_detailed, r.amount_minor, r.currency_code,
              r.authorized_at, r.posted_on, r.pending,
              r.excluded_from_spending, r.original_transaction_id,
              r.payment_channel
            FROM jsonb_to_recordset($1::jsonb) AS r(
              id text,
              provider_account_id text,
              provider_transaction_id text,
              provider_pending_transaction_id text,
              merchant_name text,
              normalized_merchant text,
              name text,
              normalized_name text,
              category_primary text,
              category_detailed text,
              amount_minor bigint,
              currency_code char(3),
              authorized_at timestamptz,
              posted_on date,
              pending boolean,
              excluded_from_spending boolean,
              original_transaction_id text,
              payment_channel text
            )
            JOIN accounts a
              ON a.provider_account_id = r.provider_account_id
             AND a.connection_id = $2
            ON CONFLICT (provider_transaction_id) DO UPDATE SET
              account_id = EXCLUDED.account_id,
              provider_pending_transaction_id = EXCLUDED.provider_pending_transaction_id,
              merchant_name = EXCLUDED.merchant_name,
              normalized_merchant = EXCLUDED.normalized_merchant,
              name = EXCLUDED.name,
              normalized_name = EXCLUDED.normalized_name,
              category_primary = EXCLUDED.category_primary,
              category_detailed = EXCLUDED.category_detailed,
              amount_minor = EXCLUDED.amount_minor,
              currency_code = EXCLUDED.currency_code,
              authorized_at = EXCLUDED.authorized_at,
              posted_on = EXCLUDED.posted_on,
              pending = EXCLUDED.pending,
              excluded_from_spending = EXCLUDED.excluded_from_spending,
              original_transaction_id = COALESCE(
                EXCLUDED.original_transaction_id,
                transactions.original_transaction_id
              ),
              payment_channel = EXCLUDED.payment_channel,
              updated_at = now()
          `,
          [JSON.stringify(changed), itemId],
        );

        const replacementIds = changed
          .map(
            (transaction) =>
              transaction.provider_pending_transaction_id ??
              transaction.providerPendingTransactionId,
          )
          .filter(Boolean);
        if (replacementIds.length) {
          await client.query(
            `
              DELETE FROM transactions pending
              WHERE pending.provider_transaction_id = ANY($1::text[])
                AND pending.pending = true
                AND EXISTS (
                  SELECT 1
                  FROM transactions posted
                  WHERE posted.provider_pending_transaction_id =
                        pending.provider_transaction_id
                )
            `,
            [replacementIds],
          );
        }
      }

      await this.updatePlaidItemState(
        itemId,
        {
          status: "active",
          errorCode: null,
          cursor,
          lastSyncedAt: syncedAt,
        },
        client,
      );
    });
  }

  async replaceInvestments(
    itemId,
    { securities = [], holdings = [], transactions = [], asOf = new Date() },
  ) {
    await withTransaction(this.#pool, async (client) => {
      if (securities.length) {
        await client.query(
          `
            INSERT INTO securities (
              id, workspace_id, provider_security_id, name, ticker_symbol,
              security_type, close_price_minor, close_price_as_of, currency_code
            )
            SELECT
              r.id, i.workspace_id, r.provider_security_id, r.name,
              r.ticker_symbol, r.security_type, r.close_price_minor,
              r.close_price_as_of, r.currency_code
            FROM jsonb_to_recordset($1::jsonb) AS r(
              id text,
              provider_security_id text,
              name text,
              ticker_symbol text,
              security_type text,
              close_price_minor bigint,
              close_price_as_of date,
              currency_code char(3)
            )
            CROSS JOIN finance_connections i
            WHERE i.id = $2
            ON CONFLICT (provider_security_id) DO UPDATE SET
              name = EXCLUDED.name,
              ticker_symbol = EXCLUDED.ticker_symbol,
              security_type = EXCLUDED.security_type,
              close_price_minor = EXCLUDED.close_price_minor,
              close_price_as_of = EXCLUDED.close_price_as_of,
              currency_code = EXCLUDED.currency_code,
              updated_at = now()
          `,
          [JSON.stringify(securities), itemId],
        );
      }

      await client.query(
        "DELETE FROM holdings WHERE account_id IN (SELECT id FROM accounts WHERE connection_id = $1)",
        [itemId],
      );
      if (holdings.length) {
        await client.query(
          `
            INSERT INTO holdings (
              id, workspace_id, account_id, security_id, quantity,
              institution_value_minor, institution_price_minor, cost_basis_minor,
              currency_code, as_of
            )
            SELECT
              r.id, a.workspace_id, a.id, s.id, r.quantity,
              r.institution_value_minor, r.institution_price_minor,
              r.cost_basis_minor, r.currency_code, $2
            FROM jsonb_to_recordset($1::jsonb) AS r(
              id text,
              provider_account_id text,
              provider_security_id text,
              quantity numeric,
              institution_value_minor bigint,
              institution_price_minor bigint,
              cost_basis_minor bigint,
              currency_code char(3)
            )
            JOIN accounts a ON a.provider_account_id = r.provider_account_id
            JOIN securities s ON s.provider_security_id = r.provider_security_id
            WHERE a.connection_id = $3
          `,
          [JSON.stringify(holdings), asOf, itemId],
        );
      }

      if (transactions.length) {
        await client.query(
          `
            INSERT INTO investment_transactions (
              id, workspace_id, account_id, security_id,
              provider_investment_transaction_id, transaction_type, subtype,
              amount_minor, fees_minor, quantity, price_minor, currency_code,
              posted_on, name
            )
            SELECT
              r.id, a.workspace_id, a.id, s.id,
              r.provider_investment_transaction_id, r.transaction_type,
              r.subtype, r.amount_minor, r.fees_minor, r.quantity,
              r.price_minor, r.currency_code, r.posted_on, r.name
            FROM jsonb_to_recordset($1::jsonb) AS r(
              id text,
              provider_account_id text,
              provider_security_id text,
              provider_investment_transaction_id text,
              transaction_type text,
              subtype text,
              amount_minor bigint,
              fees_minor bigint,
              quantity numeric,
              price_minor bigint,
              currency_code char(3),
              posted_on date,
              name text
            )
            JOIN accounts a ON a.provider_account_id = r.provider_account_id
            LEFT JOIN securities s
              ON s.provider_security_id = r.provider_security_id
            WHERE a.connection_id = $2
            ON CONFLICT (provider_investment_transaction_id) DO UPDATE SET
              transaction_type = EXCLUDED.transaction_type,
              subtype = EXCLUDED.subtype,
              amount_minor = EXCLUDED.amount_minor,
              fees_minor = EXCLUDED.fees_minor,
              quantity = EXCLUDED.quantity,
              price_minor = EXCLUDED.price_minor,
              posted_on = EXCLUDED.posted_on,
              name = EXCLUDED.name,
              updated_at = now()
          `,
          [JSON.stringify(transactions), itemId],
        );
      }
    });
  }

  async replaceLiabilities(itemId, liabilities, { asOf = new Date() } = {}) {
    await withTransaction(this.#pool, async (client) => {
      await client.query(
        "DELETE FROM liabilities WHERE account_id IN (SELECT id FROM accounts WHERE connection_id = $1)",
        [itemId],
      );
      if (!liabilities.length) return;
      await client.query(
        `
          INSERT INTO liabilities (
            id, workspace_id, account_id, liability_type,
            minimum_payment_minor, last_payment_minor, next_payment_due_on,
            apr_basis_points, principal_minor, currency_code, details, as_of
          )
          SELECT
            r.id, a.workspace_id, a.id, r.liability_type,
            r.minimum_payment_minor, r.last_payment_minor,
            r.next_payment_due_on, r.apr_basis_points, r.principal_minor,
            r.currency_code, r.details, $2
          FROM jsonb_to_recordset($1::jsonb) AS r(
            id text,
            provider_account_id text,
            liability_type text,
            minimum_payment_minor bigint,
            last_payment_minor bigint,
            next_payment_due_on date,
            apr_basis_points integer,
            principal_minor bigint,
            currency_code char(3),
            details jsonb
          )
          JOIN accounts a ON a.provider_account_id = r.provider_account_id
          WHERE a.connection_id = $3
        `,
        [JSON.stringify(liabilities), asOf, itemId],
      );
    });
  }

  async takeDailySnapshots(
    workspaceId = DEFAULT_WORKSPACE_ID,
    snapshotOn = new Date().toISOString().slice(0, 10),
  ) {
    await withTransaction(this.#pool, async (client) => {
      await client.query(
        `
          INSERT INTO daily_account_snapshots (
            workspace_id, account_id, snapshot_on,
            current_balance_minor, available_balance_minor,
            credit_limit_minor, currency_code
          )
          SELECT
            a.workspace_id, a.id, $2, a.current_balance_minor,
            a.available_balance_minor, a.credit_limit_minor, a.currency_code
          FROM accounts a
          JOIN finance_connections i ON i.id = a.connection_id
          WHERE a.workspace_id = $1
            AND a.active = true
            AND i.status <> 'removed'
          ON CONFLICT (account_id, snapshot_on) DO UPDATE SET
            current_balance_minor = EXCLUDED.current_balance_minor,
            available_balance_minor = EXCLUDED.available_balance_minor,
            credit_limit_minor = EXCLUDED.credit_limit_minor
        `,
        [workspaceId, snapshotOn],
      );
      await client.query(
        `
          INSERT INTO daily_holding_snapshots (
            workspace_id, account_id, security_id, snapshot_on,
            value_minor, quantity, currency_code
          )
          SELECT
            h.workspace_id, h.account_id, h.security_id, $2,
            h.institution_value_minor, h.quantity, h.currency_code
          FROM holdings h
          JOIN accounts a ON a.id = h.account_id
          JOIN finance_connections i ON i.id = a.connection_id
          WHERE h.workspace_id = $1
            AND a.active = true
            AND i.status <> 'removed'
          ON CONFLICT (account_id, security_id, snapshot_on) DO UPDATE SET
            value_minor = EXCLUDED.value_minor,
            quantity = EXCLUDED.quantity
        `,
        [workspaceId, snapshotOn],
      );
    });
  }

  async listAccounts(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { includeInactive = false } = {},
  ) {
    const result = await this.#pool.query(
      `
        SELECT
          a.*,
          p.institution_id,
          i.provider,
          i.ingestion_method,
          i.imported_through_on,
          i.balance_as_of
        FROM accounts a
        JOIN finance_connections i ON i.id = a.connection_id
        LEFT JOIN plaid_connection_details p ON p.connection_id = i.id
        WHERE a.workspace_id = $1
          AND (
            $2::boolean
            OR (a.active = true AND i.status <> 'removed')
          )
        ORDER BY a.institution_name NULLS LAST, a.type, a.name, a.id
      `,
      [workspaceId, includeInactive],
    );
    return result.rows.map(mapAccount);
  }

  async updateAccountBalanceGroup(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { accountId, balanceGroup },
  ) {
    const normalizedGroup = normalizeEnum(
      balanceGroup,
      BALANCE_GROUPS,
      "balanceGroup",
      { nullable: true },
    );
    return withTransaction(this.#pool, async (client) => {
      const result = await client.query(
        `
          UPDATE accounts a
          SET balance_group_override = $3,
              updated_at = now()
          FROM finance_connections i
          LEFT JOIN plaid_connection_details p ON p.connection_id = i.id
          WHERE a.id = $2
            AND a.workspace_id = $1
            AND i.id = a.connection_id
          RETURNING a.*, p.institution_id
        `,
        [workspaceId, accountId, normalizedGroup],
      );
      const row = result.rows[0];
      if (!row) return null;
      await this.#refreshAccountSearchDocument(
        client,
        workspaceId,
        accountId,
      );
      return mapAccount(row);
    });
  }

  async createManualAsset(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      id = randomUUID(),
      name,
      assetType,
      description = null,
      currencyCode = "USD",
      valueMinor,
      valuedOn = new Date().toISOString().slice(0, 10),
    } = {},
  ) {
    const normalizedName = normalizeManualAssetName(name);
    const normalizedType = normalizeEnum(
      assetType,
      MANUAL_ASSET_TYPES,
      "assetType",
    );
    const normalizedCurrency = normalizeCurrencyCode(currencyCode);
    const normalizedDescription =
      normalizeManualAssetDescription(description);
    const normalizedValue =
      valueMinor === undefined
        ? null
        : normalizeNonnegativeMinor(valueMinor);
    const normalizedValuedOn =
      valueMinor === undefined
        ? null
        : normalizeDateOnly(valuedOn, "valuedOn");

    return withTransaction(this.#pool, async (client) => {
      const result = await client.query(
        `
          INSERT INTO manual_assets (
            id, workspace_id, name, asset_type, description, currency_code
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *
        `,
        [
          id,
          workspaceId,
          normalizedName,
          normalizedType,
          normalizedDescription,
          normalizedCurrency,
        ],
      );
      if (normalizedValue != null) {
        await client.query(
          `
            INSERT INTO manual_asset_valuations (
              asset_id, valued_on, value_minor, currency_code
            )
            VALUES ($1, $2, $3, $4)
          `,
          [id, normalizedValuedOn, normalizedValue, normalizedCurrency],
        );
      }
      await this.#refreshManualAssetSearchDocument(
        client,
        workspaceId,
        id,
      );
      return mapManualAsset({
        ...result.rows[0],
        current_value_minor: normalizedValue,
        valued_on: normalizedValuedOn,
        valuation_currency_code:
          normalizedValue == null ? null : normalizedCurrency,
      });
    });
  }

  async getManualAsset(
    workspaceId = DEFAULT_WORKSPACE_ID,
    assetId,
    { asOf = null } = {},
  ) {
    const normalizedAsOf =
      normalizeDateOnly(asOf ?? new Date(), "asOf");
    const result = await this.#pool.query(
      `
        SELECT
          a.*,
          latest.value_minor AS current_value_minor,
          latest.currency_code AS valuation_currency_code,
          latest.valued_on
        FROM manual_assets a
        LEFT JOIN LATERAL (
          SELECT value_minor, currency_code, valued_on
          FROM manual_asset_valuations
          WHERE asset_id = a.id
            AND ($3::date IS NULL OR valued_on <= $3)
          ORDER BY valued_on DESC
          LIMIT 1
        ) latest ON true
        WHERE a.workspace_id = $1 AND a.id = $2
      `,
      [workspaceId, assetId, normalizedAsOf],
    );
    return result.rows[0] ? mapManualAsset(result.rows[0]) : null;
  }

  async listManualAssets(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { includeInactive = false, asOf = null } = {},
  ) {
    const normalizedAsOf =
      normalizeDateOnly(asOf ?? new Date(), "asOf");
    const result = await this.#pool.query(
      `
        SELECT
          a.*,
          latest.value_minor AS current_value_minor,
          latest.currency_code AS valuation_currency_code,
          latest.valued_on
        FROM manual_assets a
        LEFT JOIN LATERAL (
          SELECT value_minor, currency_code, valued_on
          FROM manual_asset_valuations
          WHERE asset_id = a.id
            AND ($3::date IS NULL OR valued_on <= $3)
          ORDER BY valued_on DESC
          LIMIT 1
        ) latest ON true
        WHERE a.workspace_id = $1
          AND ($2::boolean OR a.active = true)
        ORDER BY a.active DESC, a.name, a.id
      `,
      [workspaceId, includeInactive, normalizedAsOf],
    );
    return result.rows.map(mapManualAsset);
  }

  async updateManualAsset(
    workspaceId = DEFAULT_WORKSPACE_ID,
    input = {},
  ) {
    const assetId = input.assetId ?? input.id;
    if (!assetId) throw new TypeError("assetId is required");
    const hasName = Object.hasOwn(input, "name");
    const hasAssetType =
      Object.hasOwn(input, "assetType") ||
      Object.hasOwn(input, "asset_type");
    const hasDescription = Object.hasOwn(input, "description");
    const hasCurrency =
      Object.hasOwn(input, "currencyCode") ||
      Object.hasOwn(input, "currency_code");
    const hasActive = Object.hasOwn(input, "active");
    const hasValue =
      Object.hasOwn(input, "valueMinor") ||
      Object.hasOwn(input, "value_minor");
    const hasValuedOn =
      Object.hasOwn(input, "valuedOn") ||
      Object.hasOwn(input, "valued_on");
    const name = hasName ? normalizeManualAssetName(input.name) : null;
    const assetType = hasAssetType
      ? normalizeEnum(
          input.assetType ?? input.asset_type,
          MANUAL_ASSET_TYPES,
          "assetType",
        )
      : null;
    const description = hasDescription
      ? normalizeManualAssetDescription(input.description)
      : null;
    const currencyCode = hasCurrency
      ? normalizeCurrencyCode(input.currencyCode ?? input.currency_code)
      : null;
    if (hasActive && typeof input.active !== "boolean") {
      throw new TypeError("active must be a boolean");
    }
    if (hasValue && !hasValuedOn) {
      throw new TypeError("valuedOn is required when valueMinor changes");
    }
    if (hasValuedOn && !hasValue) {
      throw new TypeError("valueMinor is required when valuedOn changes");
    }
    const valueMinor = hasValue
      ? normalizeNonnegativeMinor(input.valueMinor ?? input.value_minor)
      : null;
    const valuedOn = hasValuedOn
      ? normalizeDateOnly(input.valuedOn ?? input.valued_on, "valuedOn")
      : null;
    if (
      !hasName &&
      !hasAssetType &&
      !hasDescription &&
      !hasCurrency &&
      !hasActive &&
      !hasValue
    ) {
      return this.getManualAsset(workspaceId, assetId);
    }

    return withTransaction(this.#pool, async (client) => {
      const result = await client.query(
        `
          WITH updated AS (
            UPDATE manual_assets
            SET name = CASE WHEN $3::boolean THEN $4 ELSE name END,
                asset_type = CASE WHEN $5::boolean THEN $6 ELSE asset_type END,
                description = CASE
                  WHEN $7::boolean THEN $8
                  ELSE description
                END,
                currency_code = CASE
                WHEN $9::boolean THEN $10
                ELSE currency_code
              END,
              active = CASE WHEN $11::boolean THEN $12 ELSE active END,
              archived_at = CASE
                WHEN $11::boolean AND $12::boolean = false THEN now()
                WHEN $11::boolean AND $12::boolean = true THEN NULL
                ELSE archived_at
              END,
              updated_at = now()
            WHERE workspace_id = $1 AND id = $2
            RETURNING *
          )
          SELECT
            updated.*,
            latest.value_minor AS current_value_minor,
            latest.currency_code AS valuation_currency_code,
            latest.valued_on
          FROM updated
          LEFT JOIN LATERAL (
            SELECT value_minor, currency_code, valued_on
            FROM manual_asset_valuations
            WHERE asset_id = updated.id
              AND valued_on <= (now() AT TIME ZONE 'UTC')::date
            ORDER BY valued_on DESC
            LIMIT 1
          ) latest ON true
        `,
        [
          workspaceId,
          assetId,
          hasName,
          name,
          hasAssetType,
          assetType,
          hasDescription,
          description,
          hasCurrency,
          currencyCode,
          hasActive,
          hasActive ? input.active : null,
        ],
      );
      const row = result.rows[0];
      if (!row) return null;
      if (hasValue) {
        await client.query(
          `
            INSERT INTO manual_asset_valuations (
              asset_id, valued_on, value_minor, currency_code
            )
            SELECT id, $3, $4, currency_code
            FROM manual_assets
            WHERE workspace_id = $1 AND id = $2
            ON CONFLICT (asset_id, valued_on) DO UPDATE SET
              value_minor = EXCLUDED.value_minor,
              currency_code = EXCLUDED.currency_code,
              updated_at = now()
          `,
          [workspaceId, assetId, valuedOn, valueMinor],
        );
      }
      await this.#refreshManualAssetSearchDocument(
        client,
        workspaceId,
        assetId,
      );
      const current = await client.query(
        `
          SELECT
            a.*,
            latest.value_minor AS current_value_minor,
            latest.currency_code AS valuation_currency_code,
            latest.valued_on
          FROM manual_assets a
          LEFT JOIN LATERAL (
            SELECT value_minor, currency_code, valued_on
            FROM manual_asset_valuations
            WHERE asset_id = a.id
              AND valued_on <= (now() AT TIME ZONE 'UTC')::date
            ORDER BY valued_on DESC
            LIMIT 1
          ) latest ON true
          WHERE a.workspace_id = $1 AND a.id = $2
        `,
        [workspaceId, assetId],
      );
      return mapManualAsset(current.rows[0] ?? row);
    });
  }

  async archiveManualAsset(
    workspaceId = DEFAULT_WORKSPACE_ID,
    assetIdOrInput,
  ) {
    const assetId =
      typeof assetIdOrInput === "object"
        ? assetIdOrInput?.assetId ?? assetIdOrInput?.asset_id
        : assetIdOrInput;
    if (!assetId) throw new TypeError("assetId is required");
    return this.updateManualAsset(workspaceId, {
      assetId,
      active: false,
    });
  }

  async listWorkspaceMembers(
    workspaceId = DEFAULT_WORKSPACE_ID,
  ) {
    const result = await this.#pool.query(
      `
        SELECT u.id, u.display_name
        FROM workspace_members wm
        JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = $1
        ORDER BY
          lower(COALESCE(NULLIF(u.display_name, ''), u.id)),
          u.id
      `,
      [workspaceId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      display_name: row.display_name ?? null,
    }));
  }

  async listCreditScoreSources(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { includeArchived = true } = {},
  ) {
    const result = await this.#pool.query(
      `
        SELECT *
        FROM credit_score_sources
        WHERE workspace_id = $1
          AND ($2::boolean OR archived_on IS NULL)
        ORDER BY user_id, archived_on NULLS FIRST, created_at, id
      `,
      [workspaceId, includeArchived],
    );
    return result.rows.map(mapCreditScoreSource);
  }

  async getCreditScoreSource(
    workspaceId = DEFAULT_WORKSPACE_ID,
    sourceId,
  ) {
    const result = await this.#pool.query(
      `
        SELECT *
        FROM credit_score_sources
        WHERE workspace_id = $1 AND id = $2
      `,
      [workspaceId, sourceId],
    );
    return result.rows[0]
      ? mapCreditScoreSource(result.rows[0])
      : null;
  }

  async listCreditScoreObservations(
    workspaceId = DEFAULT_WORKSPACE_ID,
  ) {
    const result = await this.#pool.query(
      `
        SELECT observation.*
        FROM credit_score_observations observation
        JOIN credit_score_sources source
          ON source.id = observation.source_id
        WHERE source.workspace_id = $1
        ORDER BY observation.observed_on, observation.id
      `,
      [workspaceId],
    );
    return result.rows.map(mapCreditScoreObservation);
  }

  async createCreditScoreSource(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      id = randomUUID(),
      ownerUserId,
      label,
      bureau = null,
      model = null,
    } = {},
  ) {
    const normalizedOwner = normalizeCreditScoreText(
      ownerUserId,
      "ownerUserId",
      128,
    );
    const normalizedLabel = normalizeCreditScoreText(
      label,
      "label",
      120,
    );
    const normalizedBureau = normalizeCreditScoreText(
      bureau,
      "bureau",
      80,
      { nullable: true },
    );
    const normalizedModel = normalizeCreditScoreText(
      model,
      "model",
      80,
      { nullable: true },
    );
    const result = await this.#pool.query(
      `
        INSERT INTO credit_score_sources (
          id, workspace_id, user_id, label, bureau, scoring_model
        )
        SELECT $1, wm.workspace_id, wm.user_id, $4, $5, $6
        FROM workspace_members wm
        WHERE wm.workspace_id = $2 AND wm.user_id = $3
        RETURNING *
      `,
      [
        id,
        workspaceId,
        normalizedOwner,
        normalizedLabel,
        normalizedBureau,
        normalizedModel,
      ],
    );
    return result.rows[0]
      ? mapCreditScoreSource(result.rows[0])
      : null;
  }

  async updateCreditScoreSource(
    workspaceId = DEFAULT_WORKSPACE_ID,
    input = {},
  ) {
    const sourceId = input.sourceId ?? input.source_id;
    const ownerUserId = input.ownerUserId ?? input.owner_user_id;
    if (!sourceId) throw new TypeError("sourceId is required");
    if (!ownerUserId) throw new TypeError("ownerUserId is required");
    const hasLabel = Object.hasOwn(input, "label");
    const hasBureau = Object.hasOwn(input, "bureau");
    const hasModel =
      Object.hasOwn(input, "model") ||
      Object.hasOwn(input, "scoring_model");
    if (!hasLabel && !hasBureau && !hasModel) {
      const current = await this.getCreditScoreSource(
        workspaceId,
        sourceId,
      );
      return current?.user_id === ownerUserId ? current : null;
    }
    const label = hasLabel
      ? normalizeCreditScoreText(input.label, "label", 120)
      : null;
    const bureau = hasBureau
      ? normalizeCreditScoreText(input.bureau, "bureau", 80, {
          nullable: true,
        })
      : null;
    const model = hasModel
      ? normalizeCreditScoreText(
          input.model ?? input.scoring_model,
          "model",
          80,
          { nullable: true },
        )
      : null;
    const result = await this.#pool.query(
      `
        UPDATE credit_score_sources
        SET label = CASE WHEN $4::boolean THEN $5 ELSE label END,
            bureau = CASE WHEN $6::boolean THEN $7 ELSE bureau END,
            scoring_model = CASE
              WHEN $8::boolean THEN $9
              ELSE scoring_model
            END,
            updated_at = now()
        WHERE workspace_id = $1
          AND id = $2
          AND user_id = $3
          AND archived_on IS NULL
        RETURNING *
      `,
      [
        workspaceId,
        sourceId,
        ownerUserId,
        hasLabel,
        label,
        hasBureau,
        bureau,
        hasModel,
        model,
      ],
    );
    return result.rows[0]
      ? mapCreditScoreSource(result.rows[0])
      : null;
  }

  async archiveCreditScoreSource(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      sourceId,
      ownerUserId,
      archivedOn = new Date().toISOString().slice(0, 10),
    } = {},
  ) {
    const normalizedArchivedOn = normalizeDateOnly(
      archivedOn,
      "archivedOn",
    );
    const result = await this.#pool.query(
      `
        UPDATE credit_score_sources
        SET archived_on = $4, updated_at = now()
        WHERE workspace_id = $1
          AND id = $2
          AND user_id = $3
          AND archived_on IS NULL
        RETURNING *
      `,
      [workspaceId, sourceId, ownerUserId, normalizedArchivedOn],
    );
    return result.rows[0]
      ? mapCreditScoreSource(result.rows[0])
      : null;
  }

  async upsertCreditScoreObservation(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      id = randomUUID(),
      sourceId,
      ownerUserId,
      observedOn,
      score,
    } = {},
  ) {
    const normalizedObservedOn = normalizeDateOnly(
      observedOn,
      "observedOn",
    );
    const normalizedScore = normalizeCreditScore(score);
    const result = await this.#pool.query(
      `
        INSERT INTO credit_score_observations (
          id, source_id, observed_on, score
        )
        SELECT $1, source.id, $5, $6
        FROM credit_score_sources source
        WHERE source.workspace_id = $2
          AND source.id = $3
          AND source.user_id = $4
        ON CONFLICT (source_id, observed_on) DO UPDATE SET
          score = EXCLUDED.score,
          updated_at = now()
        RETURNING *
      `,
      [
        id,
        workspaceId,
        sourceId,
        ownerUserId,
        normalizedObservedOn,
        normalizedScore,
      ],
    );
    return result.rows[0]
      ? mapCreditScoreObservation(result.rows[0])
      : null;
  }

  async deleteManualAsset(
    workspaceId = DEFAULT_WORKSPACE_ID,
    assetId,
  ) {
    return withTransaction(this.#pool, async (client) => {
      await client.query(
        `
          DELETE FROM search_documents
          WHERE workspace_id = $1
            AND entity_type = 'manual_asset'
            AND entity_id = $2
        `,
        [workspaceId, assetId],
      );
      const result = await client.query(
        `
          DELETE FROM manual_assets
          WHERE workspace_id = $1 AND id = $2
          RETURNING id
        `,
        [workspaceId, assetId],
      );
      return Boolean(result.rows[0]);
    });
  }

  async upsertManualAssetValuation(
    workspaceId = DEFAULT_WORKSPACE_ID,
    assetId,
    {
      valuedOn = new Date().toISOString().slice(0, 10),
      valueMinor,
      currencyCode = null,
    } = {},
  ) {
    const normalizedValuedOn = normalizeDateOnly(valuedOn, "valuedOn");
    const normalizedValue = normalizeNonnegativeMinor(valueMinor);
    const normalizedCurrency =
      currencyCode == null ? null : normalizeCurrencyCode(currencyCode);
    return withTransaction(this.#pool, async (client) => {
      const result = await client.query(
        `
          INSERT INTO manual_asset_valuations (
            asset_id, valued_on, value_minor, currency_code
          )
          SELECT id, $3, $4, COALESCE($5, currency_code)
          FROM manual_assets
          WHERE workspace_id = $1 AND id = $2
          ON CONFLICT (asset_id, valued_on) DO UPDATE SET
            value_minor = EXCLUDED.value_minor,
            currency_code = EXCLUDED.currency_code,
            updated_at = now()
          RETURNING asset_id, valued_on, value_minor, currency_code
        `,
        [
          workspaceId,
          assetId,
          normalizedValuedOn,
          normalizedValue,
          normalizedCurrency,
        ],
      );
      const row = result.rows[0];
      if (!row) return null;
      await this.#refreshManualAssetSearchDocument(
        client,
        workspaceId,
        assetId,
      );
      return mapManualAssetValuation(row);
    });
  }

  async takeManualAssetSnapshot(
    workspaceId = DEFAULT_WORKSPACE_ID,
    assetId,
    input = {},
  ) {
    return this.upsertManualAssetValuation(
      workspaceId,
      assetId,
      input,
    );
  }

  async getManualAssetValuations(
    workspaceId = DEFAULT_WORKSPACE_ID,
    assetIdOrOptions = null,
    maybeOptions = {},
  ) {
    const assetId =
      assetIdOrOptions != null &&
      typeof assetIdOrOptions !== "object"
        ? assetIdOrOptions
        : null;
    const {
      startOn = null,
      endOn = null,
      limit = 2_000,
    } = assetId == null ? (assetIdOrOptions ?? {}) : maybeOptions;
    const normalizedStart =
      startOn == null ? null : normalizeDateOnly(startOn, "startOn");
    const normalizedEnd =
      endOn == null ? null : normalizeDateOnly(endOn, "endOn");
    const boundedLimit = Math.max(1, Math.min(2_000, Number(limit) || 366));
    const result = await this.#pool.query(
      `
        SELECT v.*
        FROM manual_asset_valuations v
        JOIN manual_assets a ON a.id = v.asset_id
        WHERE a.workspace_id = $1
          AND ($2::text IS NULL OR a.id = $2)
          AND ($3::date IS NULL OR v.valued_on >= $3)
          AND ($4::date IS NULL OR v.valued_on < $4)
        ORDER BY v.valued_on DESC
        LIMIT $5
      `,
      [
        workspaceId,
        assetId,
        normalizedStart,
        normalizedEnd,
        boundedLimit,
      ],
    );
    return result.rows.map(mapManualAssetValuation);
  }

  async listManualAssetValuations(
    workspaceId = DEFAULT_WORKSPACE_ID,
    assetId,
    options = {},
  ) {
    return this.getManualAssetValuations(workspaceId, assetId, options);
  }

  async listTransactions(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      startOn = null,
      endOn = null,
      accountId = null,
      category = null,
      search = null,
      includePending = true,
      status = "all",
      minAmountMinor = null,
      maxAmountMinor = null,
      limit = 50,
      cursor = null,
      activeAccountsOnly = false,
    } = {},
  ) {
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const decoded = decodeCursor(cursor);
    const result = await this.#pool.query(
      `
        SELECT
          t.*,
          a.name AS account_name,
          a.mask AS account_mask,
          a.institution_name,
          COALESCE(
            metadata.display_name,
            cleanup_rule.display_name
          ) AS display_name,
          effective_tags.tags,
          COALESCE(
            transaction_override.category_primary,
            cleanup_rule.category_primary,
            merchant_override.category_primary,
            original_override.category_primary,
            original_cleanup_rule.category_primary,
            original_merchant_override.category_primary,
            original_transaction.category_primary,
            t.category_primary
          ) AS effective_category_primary,
          COALESCE(
            transaction_override.category_detailed,
            merchant_override.category_detailed,
            original_override.category_detailed,
            original_merchant_override.category_detailed,
            original_transaction.category_detailed,
            t.category_detailed
          ) AS effective_category_detailed,
          COALESCE(
            transaction_override.excluded_from_spending,
            merchant_override.excluded_from_spending,
            original_override.excluded_from_spending,
            original_merchant_override.excluded_from_spending,
            original_transaction.excluded_from_spending,
            t.excluded_from_spending
          )
            AS effective_excluded_from_spending,
          COALESCE(
            transaction_override.is_fixed,
            merchant_override.is_fixed,
            original_override.is_fixed,
            original_merchant_override.is_fixed,
            false
          ) AS is_fixed
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        JOIN finance_connections i ON i.id = a.connection_id
        LEFT JOIN transaction_metadata metadata
          ON metadata.workspace_id = t.workspace_id
         AND metadata.transaction_id = t.id
        LEFT JOIN LATERAL (
          SELECT rule.*
          FROM transaction_cleanup_rules rule
          WHERE rule.workspace_id = t.workspace_id
            AND rule.enabled = true
            AND (
              (
                rule.match_field = 'normalized_merchant'
                AND rule.normalized_match_value = t.normalized_merchant
              )
              OR (
                rule.match_field = 'normalized_name'
                AND rule.normalized_match_value = t.normalized_name
              )
            )
          ORDER BY
            (rule.match_field = 'normalized_merchant') DESC,
            rule.updated_at DESC,
            rule.id
          LIMIT 1
        ) cleanup_rule ON true
        LEFT JOIN LATERAL (
          SELECT
            jsonb_agg(tag.name ORDER BY tag.normalized_name) AS tags,
            string_agg(tag.name, ' ' ORDER BY tag.normalized_name) AS tag_names
          FROM transaction_tag_assignments assignment
          JOIN transaction_tags tag
            ON tag.workspace_id = assignment.workspace_id
           AND tag.id = assignment.tag_id
          WHERE assignment.workspace_id = t.workspace_id
            AND assignment.transaction_id = t.id
        ) tag_data ON true
        LEFT JOIN LATERAL (
          SELECT
            CASE
              WHEN metadata.tags_overridden
                THEN COALESCE(tag_data.tags, '[]'::jsonb)
              WHEN cleanup_rule.tags IS NOT NULL
                THEN cleanup_rule.tags
              ELSE COALESCE(tag_data.tags, '[]'::jsonb)
            END AS tags,
            CASE
              WHEN metadata.tags_overridden
                THEN tag_data.tag_names
              WHEN cleanup_rule.tags IS NOT NULL
                THEN (
                  SELECT string_agg(value, ' ' ORDER BY value)
                  FROM jsonb_array_elements_text(cleanup_rule.tags)
                    AS cleanup_tag(value)
                )
              ELSE tag_data.tag_names
            END AS tag_names
        ) effective_tags ON true
        LEFT JOIN transactions original_transaction
          ON original_transaction.id = t.original_transaction_id
         AND original_transaction.workspace_id = t.workspace_id
        LEFT JOIN LATERAL (
          SELECT rule.*
          FROM transaction_cleanup_rules rule
          WHERE original_transaction.id IS NOT NULL
            AND rule.workspace_id = original_transaction.workspace_id
            AND rule.enabled = true
            AND (
              (
                rule.match_field = 'normalized_merchant'
                AND rule.normalized_match_value =
                    original_transaction.normalized_merchant
              )
              OR (
                rule.match_field = 'normalized_name'
                AND rule.normalized_match_value =
                    original_transaction.normalized_name
              )
            )
          ORDER BY
            (rule.match_field = 'normalized_merchant') DESC,
            rule.updated_at DESC,
            rule.id
          LIMIT 1
        ) original_cleanup_rule ON true
        LEFT JOIN categorization_overrides transaction_override
          ON transaction_override.workspace_id = t.workspace_id
         AND transaction_override.transaction_id = t.id
        LEFT JOIN categorization_overrides merchant_override
          ON merchant_override.workspace_id = t.workspace_id
         AND merchant_override.transaction_id IS NULL
         AND merchant_override.normalized_merchant = t.normalized_merchant
        LEFT JOIN categorization_overrides original_override
          ON original_override.workspace_id =
              original_transaction.workspace_id
         AND original_override.transaction_id =
             original_transaction.id
        LEFT JOIN categorization_overrides original_merchant_override
          ON original_merchant_override.workspace_id =
              original_transaction.workspace_id
         AND original_merchant_override.transaction_id IS NULL
         AND original_merchant_override.normalized_merchant =
             original_transaction.normalized_merchant
        WHERE t.workspace_id = $1
          AND ($2::date IS NULL OR t.posted_on >= $2)
          AND ($3::date IS NULL OR t.posted_on < $3)
          AND ($4::text IS NULL OR t.account_id = $4)
          AND (
            $5::text IS NULL
            OR COALESCE(
              transaction_override.category_primary,
              cleanup_rule.category_primary,
              merchant_override.category_primary,
              original_override.category_primary,
              original_cleanup_rule.category_primary,
              original_merchant_override.category_primary,
              original_transaction.category_primary,
              t.category_primary
            ) = $5
          )
          AND ($6::boolean OR t.pending = false)
          AND (
            $11::text = 'all'
            OR ($11 = 'pending' AND t.pending = true)
            OR ($11 = 'posted' AND t.pending = false)
          )
          AND ($12::bigint IS NULL OR abs(t.amount_minor) >= $12)
          AND ($13::bigint IS NULL OR abs(t.amount_minor) <= $13)
          AND (
            $14::boolean = false
            OR (a.active = true AND i.status <> 'removed')
          )
          AND (
            $7::text IS NULL
            OR concat_ws(
                 ' ',
                 metadata.display_name,
                 cleanup_rule.display_name,
                 t.merchant_name,
                 t.name,
                 effective_tags.tag_names,
                 COALESCE(
                   transaction_override.category_primary,
                   cleanup_rule.category_primary,
                   merchant_override.category_primary,
                   original_override.category_primary,
                   original_cleanup_rule.category_primary,
                   original_merchant_override.category_primary,
                   original_transaction.category_primary,
                   t.category_primary
                 )
               )
               ILIKE '%' || $7 || '%'
          )
          AND (
            $8::date IS NULL
            OR (t.posted_on, t.id) < ($8::date, $9::text)
          )
        ORDER BY t.posted_on DESC, t.id DESC
        LIMIT $10
      `,
      [
        workspaceId,
        startOn,
        endOn,
        accountId,
        category,
        includePending,
        search?.trim() || null,
        decoded?.posted_on ?? null,
        decoded?.id ?? null,
        boundedLimit + 1,
        status,
        minAmountMinor,
        maxAmountMinor,
        activeAccountsOnly,
      ],
    );
    const hasMore = result.rows.length > boundedLimit;
    const rows = result.rows.slice(0, boundedLimit);
    return {
      transactions: rows.map(mapTransaction),
      pageInfo: {
        has_more: hasMore,
        next_cursor: hasMore ? encodeCursor(rows.at(-1)) : null,
      },
    };
  }

  async getTransactionsForPeriod(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      startOn,
      endOn,
      includePending = false,
      accountId = null,
      category = null,
      search = null,
      activeAccountsOnly = false,
    } = {},
  ) {
    const result = await this.listTransactions(workspaceId, {
      startOn,
      endOn,
      includePending,
      accountId,
      category,
      search,
      activeAccountsOnly,
      limit: 100,
    });
    const all = [...result.transactions];
    let cursor = result.pageInfo.next_cursor;
    while (cursor) {
      const page = await this.listTransactions(workspaceId, {
        startOn,
        endOn,
        includePending,
        accountId,
        category,
        search,
        activeAccountsOnly,
        limit: 100,
        cursor,
      });
      all.push(...page.transactions);
      cursor = page.pageInfo.next_cursor;
    }
    return all;
  }

  async getTransaction(
    workspaceId = DEFAULT_WORKSPACE_ID,
    transactionId,
  ) {
    const result = await this.#pool.query(
      `
        SELECT
          t.*,
          a.name AS account_name,
          a.mask AS account_mask,
          a.institution_name,
          COALESCE(
            metadata.display_name,
            cleanup_rule.display_name
          ) AS display_name,
          CASE
            WHEN metadata.tags_overridden
              THEN COALESCE(tag_data.tags, '[]'::jsonb)
            WHEN cleanup_rule.tags IS NOT NULL
              THEN cleanup_rule.tags
            ELSE COALESCE(tag_data.tags, '[]'::jsonb)
          END AS tags,
          COALESCE(
            transaction_override.category_primary,
            cleanup_rule.category_primary,
            merchant_override.category_primary,
            original_transaction_override.category_primary,
            original_cleanup_rule.category_primary,
            original_merchant_override.category_primary,
            original_transaction.category_primary,
            t.category_primary
          )
            AS effective_category_primary,
          COALESCE(
            transaction_override.category_detailed,
            merchant_override.category_detailed,
            original_transaction_override.category_detailed,
            original_merchant_override.category_detailed,
            original_transaction.category_detailed,
            t.category_detailed
          )
            AS effective_category_detailed,
          COALESCE(
            transaction_override.excluded_from_spending,
            merchant_override.excluded_from_spending,
            original_transaction_override.excluded_from_spending,
            original_merchant_override.excluded_from_spending,
            original_transaction.excluded_from_spending,
            t.excluded_from_spending
          )
            AS effective_excluded_from_spending,
          COALESCE(
            transaction_override.is_fixed,
            merchant_override.is_fixed,
            original_transaction_override.is_fixed,
            original_merchant_override.is_fixed,
            false
          ) AS is_fixed
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        LEFT JOIN transaction_metadata metadata
          ON metadata.workspace_id = t.workspace_id
         AND metadata.transaction_id = t.id
        LEFT JOIN LATERAL (
          SELECT rule.*
          FROM transaction_cleanup_rules rule
          WHERE rule.workspace_id = t.workspace_id
            AND rule.enabled = true
            AND (
              (
                rule.match_field = 'normalized_merchant'
                AND rule.normalized_match_value = t.normalized_merchant
              )
              OR (
                rule.match_field = 'normalized_name'
                AND rule.normalized_match_value = t.normalized_name
              )
            )
          ORDER BY
            (rule.match_field = 'normalized_merchant') DESC,
            rule.updated_at DESC,
            rule.id
          LIMIT 1
        ) cleanup_rule ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(
            tag.name
            ORDER BY tag.normalized_name
          ) AS tags
          FROM transaction_tag_assignments assignment
          JOIN transaction_tags tag
            ON tag.workspace_id = assignment.workspace_id
           AND tag.id = assignment.tag_id
          WHERE assignment.workspace_id = t.workspace_id
            AND assignment.transaction_id = t.id
        ) tag_data ON true
        LEFT JOIN transactions original_transaction
          ON original_transaction.id = t.original_transaction_id
         AND original_transaction.workspace_id = t.workspace_id
        LEFT JOIN LATERAL (
          SELECT rule.*
          FROM transaction_cleanup_rules rule
          WHERE original_transaction.id IS NOT NULL
            AND rule.workspace_id = original_transaction.workspace_id
            AND rule.enabled = true
            AND (
              (
                rule.match_field = 'normalized_merchant'
                AND rule.normalized_match_value =
                    original_transaction.normalized_merchant
              )
              OR (
                rule.match_field = 'normalized_name'
                AND rule.normalized_match_value =
                    original_transaction.normalized_name
              )
            )
          ORDER BY
            (rule.match_field = 'normalized_merchant') DESC,
            rule.updated_at DESC,
            rule.id
          LIMIT 1
        ) original_cleanup_rule ON true
        LEFT JOIN categorization_overrides transaction_override
          ON transaction_override.workspace_id = t.workspace_id
         AND transaction_override.transaction_id = t.id
        LEFT JOIN categorization_overrides merchant_override
          ON merchant_override.workspace_id = t.workspace_id
         AND merchant_override.transaction_id IS NULL
         AND merchant_override.normalized_merchant = t.normalized_merchant
        LEFT JOIN categorization_overrides original_transaction_override
          ON original_transaction_override.workspace_id =
              original_transaction.workspace_id
         AND original_transaction_override.transaction_id =
             original_transaction.id
        LEFT JOIN categorization_overrides original_merchant_override
          ON original_merchant_override.workspace_id =
              original_transaction.workspace_id
         AND original_merchant_override.transaction_id IS NULL
         AND original_merchant_override.normalized_merchant =
             original_transaction.normalized_merchant
        WHERE t.workspace_id = $1 AND t.id = $2
        LIMIT 1
      `,
      [workspaceId, transactionId],
    );
    return result.rows[0] ? mapTransaction(result.rows[0]) : null;
  }

  async listTransactionCleanupRules(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { includeDisabled = true, limit = 200 } = {},
  ) {
    const result = await this.#pool.query(
      `
        WITH winning_rules AS (
          SELECT
            t.id AS transaction_id,
            winner.id AS rule_id
          FROM transactions t
          JOIN LATERAL (
            SELECT rule.id
            FROM transaction_cleanup_rules rule
            WHERE rule.workspace_id = t.workspace_id
              AND rule.enabled = true
              AND (
                (
                  rule.match_field = 'normalized_merchant'
                  AND rule.normalized_match_value =
                      t.normalized_merchant
                )
                OR (
                  rule.match_field = 'normalized_name'
                  AND rule.normalized_match_value = t.normalized_name
                )
              )
            ORDER BY
              (rule.match_field = 'normalized_merchant') DESC,
              rule.updated_at DESC,
              rule.id
            LIMIT 1
          ) winner ON true
          WHERE t.workspace_id = $1
            AND t.pending = false
        )
        SELECT
          rule.*,
          count(winning.transaction_id)::integer
            AS matched_transaction_count
        FROM transaction_cleanup_rules rule
        LEFT JOIN winning_rules winning
          ON winning.rule_id = rule.id
        WHERE rule.workspace_id = $1
          AND ($2::boolean OR rule.enabled = true)
        GROUP BY rule.id
        ORDER BY rule.enabled DESC, rule.updated_at DESC, rule.id
        LIMIT $3
      `,
      [
        workspaceId,
        includeDisabled,
        Math.max(1, Math.min(500, Number(limit) || 200)),
      ],
    );
    return result.rows.map(mapTransactionCleanupRule);
  }

  async createTransactionCleanupRule(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      id = randomUUID(),
      matchField,
      matchValue,
      normalizedMatchValue,
      displayName = null,
      categoryPrimary = null,
      tags = null,
      enabled = true,
      userId = null,
    },
  ) {
    return withTransaction(this.#pool, async (client) => {
      const result = await client.query(
        `
          INSERT INTO transaction_cleanup_rules (
            id, workspace_id, match_field, match_value,
            normalized_match_value, display_name, category_primary,
            tags, enabled, created_by, updated_by
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $10
          )
          RETURNING *
        `,
        [
          id,
          workspaceId,
          matchField,
          matchValue,
          normalizedMatchValue,
          displayName,
          categoryPrimary,
          tags == null ? null : JSON.stringify(tags),
          enabled,
          userId,
        ],
      );
      const rule = result.rows[0];
      const affectedIds = await this.#transactionIdsForCleanupRule(
        client,
        workspaceId,
        rule,
      );
      await this.#refreshTransactionSearchDocuments(
        client,
        workspaceId,
        affectedIds,
      );
      const winningIds = await this.#transactionIdsUsingCleanupRule(
        client,
        workspaceId,
        rule.id,
      );
      return mapTransactionCleanupRule({
        ...rule,
        matched_transaction_count: winningIds.length,
      });
    });
  }

  async updateTransactionCleanupRule(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      ruleId,
      matchField,
      matchValue,
      normalizedMatchValue,
      displayName = null,
      categoryPrimary = null,
      tags = null,
      enabled,
      userId = null,
    },
  ) {
    return withTransaction(this.#pool, async (client) => {
      const existing = await client.query(
        `
          SELECT *
          FROM transaction_cleanup_rules
          WHERE workspace_id = $1 AND id = $2
          FOR UPDATE
        `,
        [workspaceId, ruleId],
      );
      const previous = existing.rows[0];
      if (!previous) return null;
      const previousIds = await this.#transactionIdsForCleanupRule(
        client,
        workspaceId,
        previous,
      );
      const result = await client.query(
        `
          UPDATE transaction_cleanup_rules
          SET match_field = $3,
              match_value = $4,
              normalized_match_value = $5,
              display_name = $6,
              category_primary = $7,
              tags = $8::jsonb,
              enabled = COALESCE($9::boolean, enabled),
              updated_by = $10,
              updated_at = now()
          WHERE workspace_id = $1 AND id = $2
          RETURNING *
        `,
        [
          workspaceId,
          ruleId,
          matchField,
          matchValue,
          normalizedMatchValue,
          displayName,
          categoryPrimary,
          tags == null ? null : JSON.stringify(tags),
          enabled,
          userId,
        ],
      );
      const rule = result.rows[0];
      const nextIds = await this.#transactionIdsForCleanupRule(
        client,
        workspaceId,
        rule,
      );
      await this.#refreshTransactionSearchDocuments(
        client,
        workspaceId,
        [...new Set([...previousIds, ...nextIds])],
      );
      const winningIds = await this.#transactionIdsUsingCleanupRule(
        client,
        workspaceId,
        rule.id,
      );
      return mapTransactionCleanupRule({
        ...rule,
        matched_transaction_count: winningIds.length,
      });
    });
  }

  async deleteTransactionCleanupRule(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { ruleId },
  ) {
    return withTransaction(this.#pool, async (client) => {
      const existing = await client.query(
        `
          SELECT *
          FROM transaction_cleanup_rules
          WHERE workspace_id = $1 AND id = $2
          FOR UPDATE
        `,
        [workspaceId, ruleId],
      );
      const rule = existing.rows[0];
      if (!rule) return null;
      const affectedIds = await this.#transactionIdsForCleanupRule(
        client,
        workspaceId,
        rule,
      );
      const winningIds = await this.#transactionIdsUsingCleanupRule(
        client,
        workspaceId,
        rule.id,
      );
      await client.query(
        `
          DELETE FROM transaction_cleanup_rules
          WHERE workspace_id = $1 AND id = $2
        `,
        [workspaceId, ruleId],
      );
      await this.#refreshTransactionSearchDocuments(
        client,
        workspaceId,
        affectedIds,
      );
      return mapTransactionCleanupRule({
        ...rule,
        matched_transaction_count: winningIds.length,
      });
    });
  }

  async listTransactionTags(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { limit = 200 } = {},
  ) {
    const result = await this.#pool.query(
      `
        SELECT
          tag.id,
          tag.name,
          tag.normalized_name,
          count(assignment.transaction_id)::integer AS transaction_count
        FROM transaction_tags tag
        LEFT JOIN transaction_tag_assignments assignment
          ON assignment.workspace_id = tag.workspace_id
         AND assignment.tag_id = tag.id
        WHERE tag.workspace_id = $1
        GROUP BY tag.id, tag.name, tag.normalized_name
        ORDER BY tag.normalized_name, tag.id
        LIMIT $2
      `,
      [workspaceId, Math.max(1, Math.min(500, Number(limit) || 200))],
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      normalized_name: row.normalized_name,
      transaction_count: Number(row.transaction_count) || 0,
    }));
  }

  async findTransactionMatches(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      transactionId = null,
      query = null,
      limit = 50,
    } = {},
  ) {
    const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 50));
    const anchorCandidate = transactionId
      ? await this.getTransaction(workspaceId, transactionId)
      : null;
    const anchor =
      anchorCandidate && !anchorCandidate.pending
        ? {
            ...anchorCandidate,
            similarity_basis_points: 10_000,
            match_reason: "anchor",
            preselected: true,
          }
        : null;
    const queryText = String(query ?? "").trim();
    const normalizedQuery = normalizeSearchText(
      queryText ||
        anchor?.normalized_merchant ||
        anchor?.normalized_name ||
        anchor?.display_name,
    );
    const exactMerchant =
      anchor?.normalized_merchant || normalizedQuery || null;
    const availableTagsPromise = this.listTransactionTags(workspaceId);
    if (!normalizedQuery) {
      return {
        query: queryText,
        anchor,
        matches: [],
        availableTags: await availableTagsPromise,
      };
    }
    const result = await this.#pool.query(
      `
        WITH candidates AS (
          SELECT
            t.*,
            a.name AS account_name,
            a.mask AS account_mask,
            a.institution_name,
            COALESCE(
              metadata.display_name,
              cleanup_rule.display_name
            ) AS display_name,
            CASE
              WHEN metadata.tags_overridden
                THEN COALESCE(tag_data.tags, '[]'::jsonb)
              WHEN cleanup_rule.tags IS NOT NULL
                THEN cleanup_rule.tags
              ELSE COALESCE(tag_data.tags, '[]'::jsonb)
            END AS tags,
            COALESCE(
              transaction_override.category_primary,
              cleanup_rule.category_primary,
              merchant_override.category_primary,
              original_transaction_override.category_primary,
              original_cleanup_rule.category_primary,
              original_merchant_override.category_primary,
              original_transaction.category_primary,
              t.category_primary
            ) AS effective_category_primary,
            COALESCE(
              transaction_override.category_detailed,
              merchant_override.category_detailed,
              original_transaction_override.category_detailed,
              original_merchant_override.category_detailed,
              original_transaction.category_detailed,
              t.category_detailed
            ) AS effective_category_detailed,
            COALESCE(
              transaction_override.excluded_from_spending,
              merchant_override.excluded_from_spending,
              original_transaction_override.excluded_from_spending,
              original_merchant_override.excluded_from_spending,
              original_transaction.excluded_from_spending,
              t.excluded_from_spending
            ) AS effective_excluded_from_spending,
            COALESCE(
              transaction_override.is_fixed,
              merchant_override.is_fixed,
              original_transaction_override.is_fixed,
              original_merchant_override.is_fixed,
              false
            ) AS is_fixed,
            GREATEST(
              similarity(COALESCE(t.normalized_merchant, ''), $3),
              similarity(COALESCE(t.normalized_name, ''), $3),
              similarity(
                lower(regexp_replace(
                  COALESCE(
                    metadata.display_name,
                    cleanup_rule.display_name,
                    ''
                  ),
                  '[^[:alnum:]]+',
                  ' ',
                  'g'
                )),
                $3
              )
            ) AS similarity_score
          FROM transactions t
          JOIN accounts a ON a.id = t.account_id
          LEFT JOIN transaction_metadata metadata
            ON metadata.workspace_id = t.workspace_id
           AND metadata.transaction_id = t.id
          LEFT JOIN LATERAL (
            SELECT rule.*
            FROM transaction_cleanup_rules rule
            WHERE rule.workspace_id = t.workspace_id
              AND rule.enabled = true
              AND (
                (
                  rule.match_field = 'normalized_merchant'
                  AND rule.normalized_match_value = t.normalized_merchant
                )
                OR (
                  rule.match_field = 'normalized_name'
                  AND rule.normalized_match_value = t.normalized_name
                )
              )
            ORDER BY
              (rule.match_field = 'normalized_merchant') DESC,
              rule.updated_at DESC,
              rule.id
            LIMIT 1
          ) cleanup_rule ON true
          LEFT JOIN LATERAL (
            SELECT jsonb_agg(
              tag.name
              ORDER BY tag.normalized_name
            ) AS tags
            FROM transaction_tag_assignments assignment
            JOIN transaction_tags tag
              ON tag.workspace_id = assignment.workspace_id
             AND tag.id = assignment.tag_id
            WHERE assignment.workspace_id = t.workspace_id
              AND assignment.transaction_id = t.id
          ) tag_data ON true
          LEFT JOIN transactions original_transaction
            ON original_transaction.id = t.original_transaction_id
           AND original_transaction.workspace_id = t.workspace_id
          LEFT JOIN LATERAL (
            SELECT rule.*
            FROM transaction_cleanup_rules rule
            WHERE original_transaction.id IS NOT NULL
              AND rule.workspace_id = original_transaction.workspace_id
              AND rule.enabled = true
              AND (
                (
                  rule.match_field = 'normalized_merchant'
                  AND rule.normalized_match_value =
                      original_transaction.normalized_merchant
                )
                OR (
                  rule.match_field = 'normalized_name'
                  AND rule.normalized_match_value =
                      original_transaction.normalized_name
                )
              )
            ORDER BY
              (rule.match_field = 'normalized_merchant') DESC,
              rule.updated_at DESC,
              rule.id
            LIMIT 1
          ) original_cleanup_rule ON true
          LEFT JOIN categorization_overrides transaction_override
            ON transaction_override.workspace_id = t.workspace_id
           AND transaction_override.transaction_id = t.id
          LEFT JOIN categorization_overrides merchant_override
            ON merchant_override.workspace_id = t.workspace_id
           AND merchant_override.transaction_id IS NULL
           AND merchant_override.normalized_merchant =
               t.normalized_merchant
          LEFT JOIN categorization_overrides original_transaction_override
            ON original_transaction_override.workspace_id =
                original_transaction.workspace_id
           AND original_transaction_override.transaction_id =
               original_transaction.id
          LEFT JOIN categorization_overrides original_merchant_override
            ON original_merchant_override.workspace_id =
                original_transaction.workspace_id
           AND original_merchant_override.transaction_id IS NULL
           AND original_merchant_override.normalized_merchant =
               original_transaction.normalized_merchant
          WHERE t.workspace_id = $1
            AND t.pending = false
            AND ($2::text IS NULL OR t.id <> $2)
            AND (
              $5::bigint IS NULL
              OR sign(t.amount_minor) = sign($5::bigint)
            )
        )
        SELECT
          candidates.*,
          round(candidates.similarity_score * 10000)::integer
            AS similarity_basis_points,
          CASE
            WHEN candidates.normalized_merchant = $4
              THEN 'exact_merchant'
            WHEN similarity(
              COALESCE(candidates.normalized_merchant, ''),
              $3
            ) >= similarity(
              COALESCE(candidates.normalized_name, ''),
              $3
            )
              THEN 'similar_merchant'
            ELSE 'similar_name'
          END AS match_reason,
          (
            $2::text IS NOT NULL
            AND candidates.normalized_merchant = $4
          ) AS preselected
        FROM candidates
        WHERE candidates.normalized_merchant = $4
           OR candidates.similarity_score >= 0.2
        ORDER BY
          (candidates.normalized_merchant = $4) DESC,
          candidates.similarity_score DESC,
          candidates.posted_on DESC,
          candidates.id DESC
        LIMIT $6
      `,
      [
        workspaceId,
        transactionId,
        normalizedQuery,
        exactMerchant,
        anchor?.amount_minor ?? null,
        boundedLimit,
      ],
    );
    return {
      query:
        queryText ||
        anchor?.display_name ||
        anchor?.merchant_name ||
        anchor?.name ||
        "",
      anchor,
      matches: result.rows.map((row) => ({
        ...mapTransaction(row),
        similarity_basis_points: Number(
          row.similarity_basis_points,
        ),
        match_reason: row.match_reason,
        preselected: Boolean(row.preselected),
      })),
      availableTags: await availableTagsPromise,
    };
  }

  async batchEditTransactions(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      transactionIds,
      changes,
      userId = null,
    },
  ) {
    const ids = [...new Set(transactionIds)];
    const hasDisplayName = Object.hasOwn(changes, "displayName");
    const hasCategoryPrimary = Object.hasOwn(
      changes,
      "categoryPrimary",
    );
    const hasTags = Object.hasOwn(changes, "tags");
    const normalizedTags = hasTags
      ? [
          ...new Map(
            changes.tags.map((tag) => {
              const normalized = normalizeTagName(tag);
              return [normalized.normalized_name, normalized];
            }),
          ).values(),
        ]
      : [];

    return withTransaction(this.#pool, async (client) => {
      const locked = await client.query(
        `
          SELECT id
          FROM transactions
          WHERE workspace_id = $1
            AND id = ANY($2::text[])
            AND pending = false
          ORDER BY id
          FOR UPDATE
        `,
        [workspaceId, ids],
      );
      const lockedIds = locked.rows.map((row) => row.id);
      if (
        lockedIds.length !== ids.length ||
        lockedIds.some((id) => !ids.includes(id))
      ) {
        return null;
      }

      if (hasDisplayName) {
        if (changes.displayName == null) {
          await client.query(
            `
              UPDATE transaction_metadata
              SET display_name = NULL,
                  updated_at = now()
              WHERE workspace_id = $1
                AND transaction_id = ANY($2::text[])
            `,
            [workspaceId, ids],
          );
          await client.query(
            `
              DELETE FROM transaction_metadata
              WHERE workspace_id = $1
                AND transaction_id = ANY($2::text[])
                AND display_name IS NULL
                AND tags_overridden = false
            `,
            [workspaceId, ids],
          );
        } else {
          await client.query(
            `
              INSERT INTO transaction_metadata (
                workspace_id, transaction_id, display_name, created_by
              )
              SELECT $1, selected.transaction_id, $3, $4
              FROM unnest($2::text[]) AS selected(transaction_id)
              ON CONFLICT (workspace_id, transaction_id) DO UPDATE SET
                display_name = EXCLUDED.display_name,
                updated_at = now()
            `,
            [workspaceId, ids, changes.displayName, userId],
          );
        }
      }

      if (hasCategoryPrimary) {
        const overrideRows = ids.map((transactionId) => ({
          id: randomUUID(),
          transaction_id: transactionId,
        }));
        await client.query(
          `
            INSERT INTO categorization_overrides (
              id, workspace_id, transaction_id, category_primary,
              category_detailed, created_by
            )
            SELECT
              row.id, $1, row.transaction_id, $3, NULL, $4
            FROM jsonb_to_recordset($2::jsonb) AS row(
              id text,
              transaction_id text
            )
            ON CONFLICT (workspace_id, transaction_id)
              WHERE transaction_id IS NOT NULL
            DO UPDATE SET
              category_primary = EXCLUDED.category_primary,
              category_detailed = NULL,
              updated_at = now()
          `,
          [
            workspaceId,
            JSON.stringify(overrideRows),
            changes.categoryPrimary,
            userId,
          ],
        );
      }

      if (hasTags) {
        await client.query(
          `
            INSERT INTO transaction_metadata (
              workspace_id, transaction_id, tags_overridden, created_by
            )
            SELECT $1, selected.transaction_id, true, $3
            FROM unnest($2::text[]) AS selected(transaction_id)
            ON CONFLICT (workspace_id, transaction_id) DO UPDATE SET
              tags_overridden = true,
              updated_at = now()
          `,
          [workspaceId, ids, userId],
        );
        if (normalizedTags.length) {
          const tagRows = normalizedTags.map((tag) => ({
            id: randomUUID(),
            ...tag,
          }));
          await client.query(
            `
              INSERT INTO transaction_tags (
                id, workspace_id, name, normalized_name, created_by
              )
              SELECT
                row.id, $1, row.name, row.normalized_name, $3
              FROM jsonb_to_recordset($2::jsonb) AS row(
                id text,
                name text,
                normalized_name text
              )
              ON CONFLICT (workspace_id, normalized_name) DO UPDATE SET
                name = EXCLUDED.name,
                updated_at = now()
            `,
            [workspaceId, JSON.stringify(tagRows), userId],
          );
        }
        await client.query(
          `
            DELETE FROM transaction_tag_assignments
            WHERE workspace_id = $1
              AND transaction_id = ANY($2::text[])
          `,
          [workspaceId, ids],
        );
        if (normalizedTags.length) {
          await client.query(
            `
              INSERT INTO transaction_tag_assignments (
                workspace_id, transaction_id, tag_id, created_by
              )
              SELECT $1, selected.transaction_id, tag.id, $4
              FROM unnest($2::text[]) AS selected(transaction_id)
              JOIN transaction_tags tag
                ON tag.workspace_id = $1
               AND tag.normalized_name = ANY($3::text[])
              ON CONFLICT DO NOTHING
            `,
            [
              workspaceId,
              ids,
              normalizedTags.map((tag) => tag.normalized_name),
              userId,
            ],
          );
        }
      }

      await this.#refreshTransactionSearchDocuments(
        client,
        workspaceId,
        ids,
      );
      return {
        updatedCount: lockedIds.length,
        transactionIds: ids,
      };
    });
  }

  async linkRefundToOriginal(
    workspaceId = DEFAULT_WORKSPACE_ID,
    transactionId,
    originalTransactionId,
  ) {
    const result = await this.#pool.query(
      `
        UPDATE transactions refund
        SET original_transaction_id = original_transaction.id,
            updated_at = now()
        FROM transactions original_transaction
        WHERE refund.workspace_id = $1
          AND refund.id = $2
          AND original_transaction.workspace_id = $1
          AND original_transaction.id = $3
          AND refund.id <> original_transaction.id
        RETURNING
          refund.id AS transaction_id,
          refund.original_transaction_id
      `,
      [workspaceId, transactionId, originalTransactionId],
    );
    return result.rows[0] ?? null;
  }

  async listTransactionCategories(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { limit = 100 } = {},
  ) {
    const result = await this.#pool.query(
      `
        SELECT DISTINCT
          COALESCE(
            transaction_override.category_primary,
            cleanup_rule.category_primary,
            merchant_override.category_primary,
            original_transaction_override.category_primary,
            original_cleanup_rule.category_primary,
            original_merchant_override.category_primary,
            original_transaction.category_primary,
            t.category_primary
          ) AS category
        FROM transactions t
        LEFT JOIN LATERAL (
          SELECT rule.*
          FROM transaction_cleanup_rules rule
          WHERE rule.workspace_id = t.workspace_id
            AND rule.enabled = true
            AND (
              (
                rule.match_field = 'normalized_merchant'
                AND rule.normalized_match_value = t.normalized_merchant
              )
              OR (
                rule.match_field = 'normalized_name'
                AND rule.normalized_match_value = t.normalized_name
              )
            )
          ORDER BY
            (rule.match_field = 'normalized_merchant') DESC,
            rule.updated_at DESC,
            rule.id
          LIMIT 1
        ) cleanup_rule ON true
        LEFT JOIN transactions original_transaction
          ON original_transaction.id = t.original_transaction_id
         AND original_transaction.workspace_id = t.workspace_id
        LEFT JOIN LATERAL (
          SELECT rule.*
          FROM transaction_cleanup_rules rule
          WHERE original_transaction.id IS NOT NULL
            AND rule.workspace_id = original_transaction.workspace_id
            AND rule.enabled = true
            AND (
              (
                rule.match_field = 'normalized_merchant'
                AND rule.normalized_match_value =
                    original_transaction.normalized_merchant
              )
              OR (
                rule.match_field = 'normalized_name'
                AND rule.normalized_match_value =
                    original_transaction.normalized_name
              )
            )
          ORDER BY
            (rule.match_field = 'normalized_merchant') DESC,
            rule.updated_at DESC,
            rule.id
          LIMIT 1
        ) original_cleanup_rule ON true
        LEFT JOIN categorization_overrides transaction_override
          ON transaction_override.workspace_id = t.workspace_id
         AND transaction_override.transaction_id = t.id
        LEFT JOIN categorization_overrides merchant_override
          ON merchant_override.workspace_id = t.workspace_id
         AND merchant_override.transaction_id IS NULL
         AND merchant_override.normalized_merchant = t.normalized_merchant
        LEFT JOIN categorization_overrides original_transaction_override
          ON original_transaction_override.workspace_id =
              original_transaction.workspace_id
         AND original_transaction_override.transaction_id =
             original_transaction.id
        LEFT JOIN categorization_overrides original_merchant_override
          ON original_merchant_override.workspace_id =
              original_transaction.workspace_id
         AND original_merchant_override.transaction_id IS NULL
         AND original_merchant_override.normalized_merchant =
             original_transaction.normalized_merchant
        WHERE t.workspace_id = $1
          AND COALESCE(
            transaction_override.category_primary,
            cleanup_rule.category_primary,
            merchant_override.category_primary,
            original_transaction_override.category_primary,
            original_cleanup_rule.category_primary,
            original_merchant_override.category_primary,
            original_transaction.category_primary,
            t.category_primary
          ) IS NOT NULL
        ORDER BY category
        LIMIT $2
      `,
      [workspaceId, Math.max(1, Math.min(250, Number(limit) || 100))],
    );
    return result.rows.map((row) => row.category);
  }

  async getAccountSnapshots(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { startOn = null, endOn = null } = {},
  ) {
    const result = await this.#pool.query(
      `
        SELECT
          s.*,
          a.name AS account_name,
          a.type,
          a.subtype,
          a.is_liability,
          a.balance_group_override
        FROM daily_account_snapshots s
        JOIN accounts a ON a.id = s.account_id
        WHERE s.workspace_id = $1
          AND ($2::date IS NULL OR s.snapshot_on >= $2)
          AND ($3::date IS NULL OR s.snapshot_on < $3)
        ORDER BY s.snapshot_on, s.account_id
      `,
      [workspaceId, startOn, endOn],
    );
    return result.rows.map((row) => ({
      account_id: row.account_id,
      account_name: row.account_name,
      snapshot_on: String(row.snapshot_on),
      current_balance_minor: integer(row.current_balance_minor),
      available_balance_minor: integer(row.available_balance_minor),
      credit_limit_minor: integer(row.credit_limit_minor),
      currency_code: row.currency_code,
      type: row.type,
      subtype: row.subtype,
      is_liability: row.is_liability,
      balance_group_override: row.balance_group_override ?? null,
      balance_group: inferBalanceGroup(row),
    }));
  }

  async getHoldings(workspaceId = DEFAULT_WORKSPACE_ID) {
    const result = await this.#pool.query(
      `
        SELECT
          h.*, s.name AS security_name, s.ticker_symbol, s.security_type,
          s.close_price_as_of, a.name AS account_name, a.type AS account_type,
          a.subtype AS account_subtype, a.is_liability,
          a.balance_group_override
        FROM holdings h
        JOIN securities s ON s.id = h.security_id
        JOIN accounts a ON a.id = h.account_id
        JOIN finance_connections i ON i.id = a.connection_id
        WHERE h.workspace_id = $1
          AND a.active = true
          AND i.status <> 'removed'
        ORDER BY h.institution_value_minor DESC, s.name
      `,
      [workspaceId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      account_id: row.account_id,
      account_name: row.account_name,
      account_type: row.account_type,
      account_subtype: row.account_subtype,
      balance_group_override: row.balance_group_override ?? null,
      balance_group: inferBalanceGroup({
        type: row.account_type,
        subtype: row.account_subtype,
        is_liability: row.is_liability,
        balance_group_override: row.balance_group_override,
      }),
      security_id: row.security_id,
      name: row.security_name,
      ticker_symbol: row.ticker_symbol,
      security_type: row.security_type,
      quantity: Number(row.quantity),
      value_minor: integer(row.institution_value_minor),
      price_minor: integer(row.institution_price_minor),
      cost_basis_minor: integer(row.cost_basis_minor),
      currency_code: row.currency_code,
      close_price_as_of: row.close_price_as_of
        ? String(row.close_price_as_of)
        : null,
      as_of: dateValue(row.as_of),
    }));
  }

  async getHoldingSnapshots(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      startOn = null,
      endOn = null,
      activeAccountsOnly = false,
    } = {},
  ) {
    const result = await this.#pool.query(
      `
        SELECT
          s.*,
          sec.name,
          sec.ticker_symbol,
          a.type AS account_type,
          a.subtype AS account_subtype,
          a.is_liability,
          a.balance_group_override
        FROM daily_holding_snapshots s
        JOIN securities sec ON sec.id = s.security_id
        JOIN accounts a ON a.id = s.account_id
        JOIN finance_connections i ON i.id = a.connection_id
        WHERE s.workspace_id = $1
          AND ($2::date IS NULL OR s.snapshot_on >= $2)
          AND ($3::date IS NULL OR s.snapshot_on < $3)
          AND (
            $4::boolean = false
            OR (a.active = true AND i.status <> 'removed')
          )
        ORDER BY s.snapshot_on, s.security_id
      `,
      [workspaceId, startOn, endOn, activeAccountsOnly],
    );
    return result.rows.map((row) => ({
      account_id: row.account_id,
      security_id: row.security_id,
      name: row.name,
      ticker_symbol: row.ticker_symbol,
      snapshot_on: String(row.snapshot_on),
      value_minor: integer(row.value_minor),
      quantity: Number(row.quantity),
      currency_code: row.currency_code,
      balance_group_override: row.balance_group_override ?? null,
      balance_group: inferBalanceGroup({
        type: row.account_type,
        subtype: row.account_subtype,
        is_liability: row.is_liability,
        balance_group_override: row.balance_group_override,
      }),
    }));
  }

  async getInvestmentTransactions(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      startOn = null,
      endOn = null,
      activeAccountsOnly = false,
    } = {},
  ) {
    const result = await this.#pool.query(
      `
        SELECT it.*
        FROM investment_transactions it
        JOIN accounts a ON a.id = it.account_id
        JOIN finance_connections i ON i.id = a.connection_id
        WHERE it.workspace_id = $1
          AND ($2::date IS NULL OR it.posted_on >= $2)
          AND ($3::date IS NULL OR it.posted_on < $3)
          AND (
            $4::boolean = false
            OR (a.active = true AND i.status <> 'removed')
          )
        ORDER BY it.posted_on, it.id
      `,
      [workspaceId, startOn, endOn, activeAccountsOnly],
    );
    return result.rows.map((row) => ({
      id: row.id,
      account_id: row.account_id,
      security_id: row.security_id,
      transaction_type: row.transaction_type,
      subtype: row.subtype,
      amount_minor: integer(row.amount_minor),
      fees_minor: integer(row.fees_minor),
      quantity: row.quantity == null ? null : Number(row.quantity),
      price_minor: integer(row.price_minor),
      currency_code: row.currency_code,
      posted_on: String(row.posted_on),
      name: row.name,
    }));
  }

  async replaceRecurringStreams(
    workspaceId = DEFAULT_WORKSPACE_ID,
    streams,
  ) {
    await withTransaction(this.#pool, async (client) => {
      const activeIds = streams.map((stream) => stream.id);
      await client.query(
        `
          UPDATE recurring_streams
          SET status = 'canceled', updated_at = now()
          WHERE workspace_id = $1
            AND status IN ('active', 'resumed', 'irregular')
            AND NOT (id = ANY($2::text[]))
        `,
        [workspaceId, activeIds],
      );
      for (const stream of streams) {
        await client.query(
          `
            INSERT INTO recurring_streams (
              id, workspace_id, service_family, display_name, stream_type,
              cadence, account_id, expected_amount_minor, min_amount_minor,
              max_amount_minor, monthly_equivalent_minor, currency_code,
              first_seen_on, last_seen_on, next_expected_on,
              confidence_basis_points, status
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9,
              $10, $11, $12, $13, $14, $15, $16, $17
            )
            ON CONFLICT (id) DO UPDATE SET
              display_name = EXCLUDED.display_name,
              stream_type = EXCLUDED.stream_type,
              cadence = EXCLUDED.cadence,
              account_id = EXCLUDED.account_id,
              expected_amount_minor = EXCLUDED.expected_amount_minor,
              min_amount_minor = EXCLUDED.min_amount_minor,
              max_amount_minor = EXCLUDED.max_amount_minor,
              monthly_equivalent_minor = EXCLUDED.monthly_equivalent_minor,
              last_seen_on = EXCLUDED.last_seen_on,
              next_expected_on = EXCLUDED.next_expected_on,
              confidence_basis_points = EXCLUDED.confidence_basis_points,
              status = CASE
                WHEN recurring_streams.status = 'canceled'
                  AND EXCLUDED.status IN ('active', 'irregular')
                  THEN 'resumed'
                ELSE EXCLUDED.status
              END,
              updated_at = now()
          `,
          [
            stream.id,
            workspaceId,
            stream.service_family,
            stream.display_name,
            stream.stream_type,
            stream.cadence,
            stream.account_id,
            stream.expected_amount_minor,
            stream.min_amount_minor,
            stream.max_amount_minor,
            stream.monthly_equivalent_minor,
            stream.currency_code,
            stream.first_seen_on,
            stream.last_seen_on,
            stream.next_expected_on,
            stream.confidence_basis_points,
            stream.status,
          ],
        );
        await client.query(
          "DELETE FROM recurring_stream_transactions WHERE stream_id = $1",
          [stream.id],
        );
        if (stream.transaction_ids?.length) {
          await client.query(
            `
              INSERT INTO recurring_stream_transactions (stream_id, transaction_id)
              SELECT $1, unnest($2::text[])
              ON CONFLICT DO NOTHING
            `,
            [stream.id, stream.transaction_ids],
          );
        }
      }
    });
  }

  async listRecurringStreams(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { includeInactive = false } = {},
  ) {
    const result = await this.#pool.query(
      `
        SELECT r.*, a.name AS account_name,
          COALESCE(
            jsonb_agg(rst.transaction_id)
              FILTER (WHERE rst.transaction_id IS NOT NULL),
            '[]'::jsonb
          ) AS transaction_ids
        FROM recurring_streams r
        LEFT JOIN accounts a ON a.id = r.account_id
        LEFT JOIN recurring_stream_transactions rst ON rst.stream_id = r.id
        WHERE r.workspace_id = $1
          AND (
            $2::boolean
            OR r.status IN ('active', 'resumed', 'irregular')
          )
        GROUP BY r.id, a.name
        ORDER BY r.monthly_equivalent_minor DESC, r.display_name
      `,
      [workspaceId, includeInactive],
    );
    return result.rows.map(mapRecurring);
  }

  async replaceInsightFindings(
    workspaceId = DEFAULT_WORKSPACE_ID,
    family,
    findings,
  ) {
    await withTransaction(this.#pool, async (client) => {
      const preferenceResult = await client.query(
        `
          SELECT finding_key, disposition, updated_by, updated_at
          FROM insight_finding_preferences
          WHERE workspace_id = $1
        `,
        [workspaceId],
      );
      const preferences = new Map(
        preferenceResult.rows.map((row) => [row.finding_key, row]),
      );
      const findingIds = findings.map((finding) => finding.id);
      const deletedResult = findingIds.length
        ? await client.query(
            `
              SELECT DISTINCT finding_id
              FROM insight_finding_events
              WHERE workspace_id = $1
                AND action = 'delete'
                AND finding_id = ANY($2::text[])
            `,
            [workspaceId, findingIds],
          )
        : { rows: [] };
      const deletedFindingIds = new Set(
        deletedResult.rows.map((row) => row.finding_id),
      );
      await client.query(
        `
          UPDATE insight_findings
          SET is_current = false,
              retired_at = COALESCE(retired_at, now())
          WHERE workspace_id = $1
            AND family = $2
            AND is_current = true
        `,
        [workspaceId, family],
      );
      for (const finding of findings) {
        if (deletedFindingIds.has(finding.id)) continue;
        const findingKey = finding.finding_key ?? finding.id;
        const preference = preferences.get(findingKey);
        await client.query(
          `
            INSERT INTO insight_findings (
              id, workspace_id, finding_key, family, finding_type, severity,
              title, explanation, period_start, period_end, metrics, rule,
              confidence_basis_points, evidence, actions, generated_at,
              data_as_of, state, is_current, retired_at,
              state_changed_at, state_changed_by
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
              $11::jsonb, $12::jsonb, $13, $14::jsonb, $15::jsonb,
              $16, $17, $18, true, NULL, $19, $20
            )
            ON CONFLICT (id) DO UPDATE SET
              finding_key = EXCLUDED.finding_key,
              severity = EXCLUDED.severity,
              title = EXCLUDED.title,
              explanation = EXCLUDED.explanation,
              period_start = EXCLUDED.period_start,
              period_end = EXCLUDED.period_end,
              metrics = EXCLUDED.metrics,
              rule = EXCLUDED.rule,
              confidence_basis_points = EXCLUDED.confidence_basis_points,
              evidence = EXCLUDED.evidence,
              actions = EXCLUDED.actions,
              generated_at = EXCLUDED.generated_at,
              data_as_of = EXCLUDED.data_as_of,
              is_current = true,
              retired_at = NULL,
              state = insight_findings.state,
              state_changed_at = insight_findings.state_changed_at,
              state_changed_by = insight_findings.state_changed_by
          `,
          [
            finding.id,
            workspaceId,
            findingKey,
            family,
            finding.type,
            finding.severity,
            finding.title,
            finding.explanation,
            finding.period_start ?? null,
            finding.period_end ?? null,
            JSON.stringify(finding.metrics ?? {}),
            JSON.stringify(finding.rule ?? {}),
            finding.confidence_basis_points,
            JSON.stringify(finding.evidence ?? []),
            JSON.stringify(finding.actions ?? []),
            finding.generated_at,
            finding.data_as_of,
            preference?.disposition ?? "active",
            preference ? dateValue(preference.updated_at) : null,
            preference?.updated_by ?? null,
          ],
        );
      }
    });
  }

  async listInsightFindings(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { family = null, scope = "active", limit = 100 } = {},
  ) {
    if (!["active", "archive", "all"].includes(scope)) {
      throw new TypeError("Invalid insight finding scope");
    }
    const result = await this.#pool.query(
      `
        SELECT *
        FROM insight_findings
        WHERE workspace_id = $1
          AND ($2::text IS NULL OR family = $2)
          AND (
            ($3 = 'active' AND is_current = true AND state = 'active')
            OR (
              $3 = 'archive'
              AND (is_current = false OR state <> 'active')
            )
            OR $3 = 'all'
          )
        ORDER BY
          CASE
            WHEN $3 = 'active' THEN
              CASE severity
                WHEN 'important' THEN 0
                WHEN 'attention' THEN 1
                WHEN 'info' THEN 2
                ELSE 3
              END
            ELSE 0
          END,
          generated_at DESC,
          id
        LIMIT $4
      `,
      [
        workspaceId,
        family,
        scope,
        Math.max(1, Math.min(200, limit)),
      ],
    );
    return result.rows.map(mapInsightFinding);
  }

  async getInsightFinding(
    workspaceId = DEFAULT_WORKSPACE_ID,
    findingId,
  ) {
    const result = await this.#pool.query(
      `
        SELECT *
        FROM insight_findings
        WHERE workspace_id = $1 AND id = $2
      `,
      [workspaceId, findingId],
    );
    const row = result.rows[0];
    return row ? mapInsightFinding(row) : null;
  }

  async getInsightRules(
    workspaceId = DEFAULT_WORKSPACE_ID,
    family = null,
  ) {
    const result = await this.#pool.query(
      `
        SELECT family, rule_key, enabled, settings
        FROM insight_rules
        WHERE workspace_id = $1
          AND ($2::text IS NULL OR family = $2)
      `,
      [workspaceId, family],
    );
    return Object.fromEntries(
      result.rows.map((row) => [
        `${row.family}.${row.rule_key}`,
        { enabled: row.enabled, ...row.settings },
      ]),
    );
  }

  async updateTransactionClassification(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      transactionId,
      categoryPrimary = null,
      categoryDetailed = null,
      excludedFromSpending = null,
      isFixed = null,
      userId = null,
    },
  ) {
    return withTransaction(this.#pool, async (client) => {
      const exists = await client.query(
        `
          SELECT id
          FROM transactions
          WHERE id = $1 AND workspace_id = $2
          FOR UPDATE
        `,
        [transactionId, workspaceId],
      );
      if (!exists.rows[0]) return null;
      const result = await client.query(
        `
          INSERT INTO categorization_overrides (
            id, workspace_id, transaction_id, category_primary,
            category_detailed, excluded_from_spending, is_fixed, created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (workspace_id, transaction_id)
            WHERE transaction_id IS NOT NULL
          DO UPDATE SET
            category_primary = EXCLUDED.category_primary,
            category_detailed = EXCLUDED.category_detailed,
            excluded_from_spending = EXCLUDED.excluded_from_spending,
            is_fixed = EXCLUDED.is_fixed,
            updated_at = now()
          RETURNING *
        `,
        [
          randomUUID(),
          workspaceId,
          transactionId,
          categoryPrimary,
          categoryDetailed,
          excludedFromSpending,
          isFixed,
          userId,
        ],
      );
      await this.#refreshTransactionSearchDocuments(
        client,
        workspaceId,
        [transactionId],
      );
      return result.rows[0];
    });
  }

  async updateInsightRule(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { family, ruleKey, settings, enabled },
  ) {
    const result = await this.#pool.query(
      `
        INSERT INTO insight_rules (
          id, workspace_id, family, rule_key, enabled, settings
        )
        VALUES (
          $1, $2, $3, $4,
          COALESCE($5::boolean, true),
          COALESCE($6::jsonb, '{}'::jsonb)
        )
        ON CONFLICT (workspace_id, family, rule_key) DO UPDATE SET
          enabled = COALESCE($5::boolean, insight_rules.enabled),
          settings = COALESCE($6::jsonb, insight_rules.settings),
          updated_at = now()
        RETURNING family, rule_key, enabled, settings
      `,
      [
        randomUUID(),
        workspaceId,
        family,
        ruleKey,
        enabled ?? null,
        settings === undefined ? null : JSON.stringify(settings),
      ],
    );
    return result.rows[0];
  }

  async updateInsightRuleById(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { ruleId, settings, enabled },
  ) {
    const result = await this.#pool.query(
      `
        UPDATE insight_rules
        SET settings = COALESCE($3::jsonb, settings),
            enabled = COALESCE($4, enabled),
            updated_at = now()
        WHERE workspace_id = $1 AND id = $2
        RETURNING id, family, rule_key, enabled, settings
      `,
      [
        workspaceId,
        ruleId,
        settings === undefined ? null : JSON.stringify(settings),
        enabled ?? null,
      ],
    );
    return result.rows[0] ?? null;
  }

  async transitionInsightFinding(
    workspaceId = DEFAULT_WORKSPACE_ID,
    findingId,
    { action, actorId = null } = {},
  ) {
    const targetStates = {
      archive: "archived",
      mark_bad: "bad",
      restore: "active",
      dismiss: "dismissed",
      mark_expected: "resolved",
      confirm: "resolved",
    };
    if (action !== "delete" && !targetStates[action]) {
      throw new TypeError("Unsupported insight transition");
    }

    return withTransaction(this.#pool, async (client) => {
      const existing = await client.query(
        `
          SELECT *
          FROM insight_findings
          WHERE id = $1 AND workspace_id = $2
          FOR UPDATE
        `,
        [findingId, workspaceId],
      );
      const row = existing.rows[0];
      if (!row) return null;

      const targetState =
        action === "delete" ? "deleted" : targetStates[action];
      await client.query(
        `
          INSERT INTO insight_finding_events (
            id, workspace_id, finding_id, finding_key, family,
            finding_type, action, from_state, to_state, actor_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
        [
          randomUUID(),
          workspaceId,
          findingId,
          row.finding_key ?? row.id,
          row.family,
          row.finding_type,
          action,
          row.state,
          targetState,
          actorId,
        ],
      );

      if (action === "delete") {
        await client.query(
          `
            DELETE FROM insight_narratives
            WHERE workspace_id = $1
              AND finding_ids @> jsonb_build_array($2::text)
          `,
          [workspaceId, findingId],
        );
        await client.query(
          `
            DELETE FROM search_documents
            WHERE workspace_id = $1
              AND entity_type = 'insight'
              AND entity_id = $2
          `,
          [workspaceId, findingId],
        );
        await client.query(
          `
            DELETE FROM insight_findings
            WHERE workspace_id = $1 AND id = $2
          `,
          [workspaceId, findingId],
        );
        return {
          ...mapInsightFinding(row),
          deleted: true,
        };
      }

      if (action === "restore") {
        await client.query(
          `
            DELETE FROM insight_finding_preferences
            WHERE workspace_id = $1 AND finding_key = $2
          `,
          [workspaceId, row.finding_key ?? row.id],
        );
      } else if (
        ["mark_bad", "dismiss", "mark_expected", "confirm"].includes(
          action,
        )
      ) {
        await client.query(
          `
            INSERT INTO insight_finding_preferences (
              workspace_id, finding_key, disposition, updated_by
            )
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (workspace_id, finding_key) DO UPDATE SET
              disposition = EXCLUDED.disposition,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()
          `,
          [
            workspaceId,
            row.finding_key ?? row.id,
            targetState,
            actorId,
          ],
        );
      }

      const updated = await client.query(
        `
          UPDATE insight_findings
          SET state = $3,
              state_changed_at = now(),
              state_changed_by = $4
          WHERE id = $1 AND workspace_id = $2
          RETURNING *
        `,
        [findingId, workspaceId, targetState, actorId],
      );
      return updated.rows[0]
        ? mapInsightFinding(updated.rows[0])
        : null;
    });
  }

  async getInsightFeedbackSummary(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { family = null, days = 90, limit = 20 } = {},
  ) {
    const boundedDays = Math.max(1, Math.min(365, Number(days) || 90));
    const boundedLimit = Math.max(1, Math.min(20, Number(limit) || 20));
    const params = [
      workspaceId,
      family,
      boundedDays,
      boundedLimit,
    ];
    const [feedback, archived] = await Promise.all([
      this.#pool.query(
        `
          WITH latest_restore AS (
            SELECT finding_key, MAX(created_at) AS restored_at
            FROM insight_finding_events
            WHERE workspace_id = $1 AND action = 'restore'
            GROUP BY finding_key
          )
          SELECT
            e.finding_key AS feedback_key,
            COUNT(*) AS count,
            array_agg(
              DISTINCT CASE e.action
                WHEN 'mark_bad' THEN 'marked_bad'
                WHEN 'dismiss' THEN 'dismissed'
                WHEN 'mark_expected' THEN 'expected'
                WHEN 'confirm' THEN 'confirmed'
              END
            ) AS reason_codes,
            MAX(e.created_at) AS last_feedback_at
          FROM insight_finding_events e
          LEFT JOIN latest_restore r
            ON r.finding_key = e.finding_key
          WHERE e.workspace_id = $1
            AND ($2::text IS NULL OR e.family = $2)
            AND e.action IN (
              'mark_bad',
              'dismiss',
              'mark_expected',
              'confirm'
            )
            AND e.created_at >= now() - ($3::integer * interval '1 day')
            AND (r.restored_at IS NULL OR e.created_at > r.restored_at)
          GROUP BY e.finding_key
          ORDER BY MAX(e.created_at) DESC, e.finding_key
          LIMIT $4
        `,
        params,
      ),
      this.#pool.query(
        `
          WITH latest_restore AS (
            SELECT finding_key, MAX(created_at) AS restored_at
            FROM insight_finding_events
            WHERE workspace_id = $1 AND action = 'restore'
            GROUP BY finding_key
          )
          SELECT
            e.finding_key AS feedback_key,
            COUNT(*) AS count,
            MAX(e.created_at) AS last_feedback_at
          FROM insight_finding_events e
          LEFT JOIN latest_restore r
            ON r.finding_key = e.finding_key
          WHERE e.workspace_id = $1
            AND ($2::text IS NULL OR e.family = $2)
            AND e.action = 'archive'
            AND e.created_at >= now() - ($3::integer * interval '1 day')
            AND (r.restored_at IS NULL OR e.created_at > r.restored_at)
          GROUP BY e.finding_key
          ORDER BY MAX(e.created_at) DESC, e.finding_key
          LIMIT $4
        `,
        params,
      ),
    ]);
    return {
      bad: feedback.rows.map((row) => ({
        feedback_key: row.feedback_key,
        count: Number(row.count),
        reason_codes: [...new Set(row.reason_codes ?? [])].sort(),
      })),
      archived: archived.rows.map((row) => ({
        feedback_key: row.feedback_key,
        count: Number(row.count),
      })),
    };
  }

  async updateRecurringDuplicateState(
    workspaceId = DEFAULT_WORKSPACE_ID,
    streamIds,
    duplicateState,
  ) {
    const result = await this.#pool.query(
      `
        UPDATE recurring_streams
        SET duplicate_state = $3, updated_at = now()
        WHERE workspace_id = $1 AND id = ANY($2::text[])
        RETURNING id
      `,
      [workspaceId, streamIds, duplicateState],
    );
    return result.rows.map((row) => row.id);
  }

  async saveNarrative(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      id = randomUUID(),
      family,
      findingsHash,
      headline,
      bullets,
      findingIds,
    },
  ) {
    await this.#pool.query(
      `
        INSERT INTO insight_narratives (
          id, workspace_id, family, findings_hash,
          headline, bullets, finding_ids
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
        ON CONFLICT (workspace_id, family, findings_hash) DO UPDATE SET
          headline = EXCLUDED.headline,
          bullets = EXCLUDED.bullets,
          finding_ids = EXCLUDED.finding_ids,
          generated_at = now()
      `,
      [
        id,
        workspaceId,
        family,
        findingsHash,
        headline,
        JSON.stringify(bullets),
        JSON.stringify(findingIds),
      ],
    );
  }

  async getLatestNarrative(
    workspaceId = DEFAULT_WORKSPACE_ID,
    family,
  ) {
    const result = await this.#pool.query(
      `
        SELECT *
        FROM insight_narratives
        WHERE workspace_id = $1 AND family = $2
        ORDER BY generated_at DESC
        LIMIT 1
      `,
      [workspaceId, family],
    );
    const row = result.rows[0];
    return row
      ? {
          family: row.family,
          headline: row.headline,
          bullets: row.bullets,
          finding_ids: row.finding_ids,
          generated_at: dateValue(row.generated_at),
        }
      : null;
  }

  async getDataFreshness(workspaceId = DEFAULT_WORKSPACE_ID) {
    const result = await this.#pool.query(
      `
        SELECT
          min(
            CASE
              WHEN c.freshness_mode = 'manual'
                THEN c.imported_through_on::timestamptz
              ELSE c.last_synced_at
            END
          ) AS data_as_of,
          bool_or(
            c.status IN ('error', 'reauth_required')
            OR (
              c.freshness_mode = 'automatic'
              AND (
                c.last_synced_at IS NULL
                OR c.last_synced_at < now() - interval '24 hours'
              )
            )
            OR (
              c.freshness_mode = 'manual'
              AND (
                c.imported_through_on IS NULL
                OR c.imported_through_on < current_date - 7
              )
            )
            OR jsonb_array_length(
              COALESCE(p.coverage_warnings, '[]'::jsonb)
            ) > 0
          ) AS has_errors,
          COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'code', 'partial_product_coverage',
                'message', COALESCE(c.institution_name, 'A connection') ||
                  ' has incomplete optional product coverage.'
              )
            ) FILTER (
              WHERE jsonb_array_length(
                COALESCE(p.coverage_warnings, '[]'::jsonb)
              ) > 0
            ),
            '[]'::jsonb
          ) AS warnings,
          count(*) AS item_count,
          count(*) FILTER (
            WHERE c.freshness_mode = 'automatic'
              AND c.last_synced_at IS NULL
          ) AS unsynced_count,
          count(*) FILTER (
            WHERE c.freshness_mode = 'automatic'
              AND c.last_synced_at IS NOT NULL
              AND c.last_synced_at < now() - interval '24 hours'
          ) AS stale_count,
          count(*) FILTER (
            WHERE c.freshness_mode = 'manual'
              AND (
                c.imported_through_on IS NULL
                OR c.imported_through_on < current_date - 7
              )
          ) AS manual_due_count,
          count(*) FILTER (
            WHERE c.status IN ('error', 'reauth_required')
          ) AS error_count
        FROM finance_connections c
        LEFT JOIN plaid_connection_details p ON p.connection_id = c.id
        WHERE c.workspace_id = $1
          AND c.status <> 'removed'
      `,
      [workspaceId],
    );
    const row = result.rows[0];
    const itemCount = Number(row.item_count);
    const unsyncedCount = Number(row.unsynced_count);
    const staleCount = Number(row.stale_count);
    const manualDueCount = Number(row.manual_due_count);
    const errorCount = Number(row.error_count);
    const hasSuccessfulSync = row.data_as_of != null;
    const warnings = [...(row.warnings ?? [])];
    if (unsyncedCount > 0) {
      warnings.push({
        code: "unsynced_connections",
        message: `${unsyncedCount} active connection${
          unsyncedCount === 1 ? " has" : "s have"
        } not completed a successful sync.`,
      });
    }
    if (staleCount > 0) {
      warnings.push({
        code: "stale_connections",
        message: `${staleCount} active connection${
          staleCount === 1 ? " is" : "s are"
        } more than 24 hours out of date.`,
      });
    }
    if (errorCount > 0) {
      warnings.push({
        code: "connection_errors",
        message: `${errorCount} active connection${
          errorCount === 1 ? " needs" : "s need"
        } attention.`,
      });
    }
    if (manualDueCount > 0) {
      warnings.push({
        code: "manual_update_due",
        message: `${manualDueCount} manual connection${
          manualDueCount === 1 ? " is" : "s are"
        } due for a newer import.`,
      });
    }
    if (!hasSuccessfulSync) {
      warnings.push({
        code: "no_successful_sync",
        message: itemCount
          ? "No connected account has completed a successful sync."
          : "No finance connections are configured.",
      });
    }
    return {
      data_as_of: dateValue(row.data_as_of),
      partial:
        Boolean(row.has_errors) ||
        !hasSuccessfulSync ||
        unsyncedCount > 0 ||
        staleCount > 0 ||
        manualDueCount > 0 ||
        errorCount > 0,
      item_count: itemCount,
      warnings,
    };
  }

  async search(
    workspaceId = DEFAULT_WORKSPACE_ID,
    query,
    { entityTypes = null, limit = 30 } = {},
  ) {
    const normalized = normalizeSearchText(query);
    if (!normalized) return [];
    const result = await this.#pool.query(
      `
        SELECT
          entity_type, entity_id, title, subtitle, metadata,
          CASE
            WHEN normalized_text = $2 THEN 4
            WHEN normalized_text LIKE $2 || '%' THEN 3
            WHEN search_vector @@ plainto_tsquery('simple', $2) THEN 2
            WHEN entity_type = 'transaction'
              AND EXISTS (
                SELECT 1
                FROM transaction_splits split
                WHERE split.workspace_id = search_documents.workspace_id
                  AND split.transaction_id = search_documents.entity_id
                  AND lower(regexp_replace(
                    split.category,
                    '[^[:alnum:]]+',
                    ' ',
                    'g'
                  )) LIKE '%' || $2 || '%'
              )
              THEN 2
            ELSE 1
          END AS match_tier,
          similarity(normalized_text, $2) AS similarity_score
        FROM search_documents
        WHERE workspace_id = $1
          AND ($3::text[] IS NULL OR entity_type = ANY($3))
          AND (
            normalized_text LIKE $2 || '%'
            OR search_vector @@ plainto_tsquery('simple', $2)
            OR similarity(normalized_text, $2) >= 0.2
            OR (
              entity_type = 'transaction'
              AND EXISTS (
                SELECT 1
                FROM transaction_splits split
                WHERE split.workspace_id = search_documents.workspace_id
                  AND split.transaction_id = search_documents.entity_id
                  AND lower(regexp_replace(
                    split.category,
                    '[^[:alnum:]]+',
                    ' ',
                    'g'
                  )) LIKE '%' || $2 || '%'
              )
            )
          )
        ORDER BY match_tier DESC, similarity_score DESC, title
        LIMIT $4
      `,
      [workspaceId, normalized, entityTypes, Math.max(1, Math.min(50, limit))],
    );
    return result.rows.map((row) => ({
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      title: row.title,
      subtitle: row.subtitle,
      metadata: row.metadata,
    }));
  }

  async rebuildSearchDocuments(workspaceId = DEFAULT_WORKSPACE_ID) {
    await withTransaction(this.#pool, async (client) => {
      await client.query(
        "DELETE FROM search_documents WHERE workspace_id = $1",
        [workspaceId],
      );
      const transactionRows = await client.query(
        `
          SELECT id
          FROM transactions
          WHERE workspace_id = $1
        `,
        [workspaceId],
      );
      await this.#refreshTransactionSearchDocuments(
        client,
        workspaceId,
        transactionRows.rows.map((row) => row.id),
      );
      await client.query(
        `
          WITH grouped_accounts AS (
            SELECT
              a.*,
              COALESCE(
                a.balance_group_override,
                CASE
                  WHEN a.type = 'credit' OR a.subtype = 'credit card'
                    THEN 'credit_card'
                  WHEN a.type = 'loan' THEN 'loan'
                  WHEN a.is_liability THEN 'other_liability'
                  WHEN a.type IN ('investment', 'brokerage')
                    AND regexp_replace(
                      lower(COALESCE(a.subtype, '')),
                      '[^a-z0-9]+',
                      '_',
                      'g'
                    ) IN (${RETIREMENT_SUBTYPES_SQL})
                    THEN 'retirement'
                  WHEN a.type IN ('investment', 'brokerage')
                    THEN 'taxable_investment'
                  WHEN a.type IN ('depository', 'cash') THEN 'cash'
                  ELSE 'other_asset'
                END
              ) AS balance_group
            FROM accounts a
            WHERE a.workspace_id = $1 AND a.active = true
          )
          INSERT INTO search_documents (
            id, workspace_id, entity_type, entity_id, title, subtitle,
            search_text, normalized_text, metadata
          )
          SELECT
            'account:' || a.id, a.workspace_id, 'account', a.id, a.name,
            concat_ws(' · ', a.institution_name, a.type, a.mask),
            concat_ws(' ', a.name, a.official_name, a.institution_name,
                           a.type, a.subtype, a.mask, a.balance_group),
            lower(regexp_replace(
              concat_ws(' ', a.name, a.official_name, a.institution_name,
                             a.type, a.subtype, a.mask, a.balance_group),
              '[^[:alnum:]]+', ' ', 'g'
            )),
            jsonb_strip_nulls(
              jsonb_build_object(
                'type', a.type,
                'mask', a.mask,
                'balance_group', a.balance_group,
                'balance_group_override', a.balance_group_override
              )
            )
          FROM grouped_accounts a
        `,
        [workspaceId],
      );
      await client.query(
        `
          INSERT INTO search_documents (
            id, workspace_id, entity_type, entity_id, title, subtitle,
            search_text, normalized_text, metadata
          )
          SELECT
            'manual_asset:' || a.id,
            a.workspace_id,
            'manual_asset',
            a.id,
            a.name,
            concat_ws(
              ' · ',
              initcap(replace(a.asset_type, '_', ' ')),
              latest.currency_code
            ),
            concat_ws(' ', a.name, a.asset_type, a.description),
            lower(regexp_replace(
              concat_ws(' ', a.name, a.asset_type, a.description),
              '[^[:alnum:]]+',
              ' ',
              'g'
            )),
            jsonb_strip_nulls(
              jsonb_build_object(
                'asset_type', a.asset_type,
                'value_minor', latest.value_minor,
                'currency_code', latest.currency_code,
                'valued_on', latest.valued_on
              )
            )
          FROM manual_assets a
          LEFT JOIN LATERAL (
            SELECT value_minor, currency_code, valued_on
            FROM manual_asset_valuations
            WHERE asset_id = a.id
              AND valued_on <= (now() AT TIME ZONE 'UTC')::date
            ORDER BY valued_on DESC
            LIMIT 1
          ) latest ON true
          WHERE a.workspace_id = $1 AND a.active = true
        `,
        [workspaceId],
      );
      await client.query(
        `
          INSERT INTO search_documents (
            id, workspace_id, entity_type, entity_id, title, subtitle,
            search_text, normalized_text, metadata
          )
          SELECT
            'recurring:' || r.id, r.workspace_id, 'recurring', r.id,
            r.display_name, concat_ws(' · ', r.cadence, r.stream_type),
            concat_ws(' ', r.display_name, r.service_family, r.cadence, r.stream_type),
            lower(regexp_replace(
              concat_ws(' ', r.display_name, r.service_family, r.cadence, r.stream_type),
              '[^[:alnum:]]+', ' ', 'g'
            )),
            jsonb_build_object('monthly_equivalent_minor', r.monthly_equivalent_minor)
          FROM recurring_streams r
          WHERE r.workspace_id = $1
            AND r.status IN ('active', 'resumed', 'irregular')
        `,
        [workspaceId],
      );
      await client.query(
        `
          INSERT INTO search_documents (
            id, workspace_id, entity_type, entity_id, title, subtitle,
            search_text, normalized_text, metadata
          )
          SELECT
            'insight:' || f.id, f.workspace_id, 'insight', f.id, f.title,
            concat_ws(' · ', f.family, f.finding_type),
            concat_ws(' ', f.title, f.explanation, f.family, f.finding_type),
            lower(regexp_replace(
              concat_ws(' ', f.title, f.explanation, f.family, f.finding_type),
              '[^[:alnum:]]+', ' ', 'g'
            )),
            jsonb_build_object('family', f.family, 'severity', f.severity)
          FROM insight_findings f
          WHERE f.workspace_id = $1
            AND f.is_current = true
            AND f.state = 'active'
        `,
        [workspaceId],
      );
    });
  }

  async startSyncRun(
    {
      id = randomUUID(),
      workspaceId = DEFAULT_WORKSPACE_ID,
      itemId,
      syncType,
    },
  ) {
    await this.#pool.query(
      `
        INSERT INTO sync_runs (
          id, workspace_id, connection_id, sync_type, status
        )
        VALUES ($1, $2, $3, $4, 'running')
      `,
      [id, workspaceId, itemId, syncType],
    );
    return id;
  }

  async finishSyncRun(id, { status, stats = {}, errorCode = null }) {
    await this.#pool.query(
      `
        UPDATE sync_runs
        SET status = $2,
            stats = $3::jsonb,
            error_code = $4,
            finished_at = now()
        WHERE id = $1
      `,
      [id, status, JSON.stringify(stats), errorCode],
    );
  }
}

function mapPlaidItem(row) {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    provider_item_id: row.provider_item_id,
    institution_id: row.institution_id ?? null,
    institution_name: row.institution_name,
    transactions_cursor: row.transactions_cursor,
    status: row.status,
    error_code: row.error_code,
    coverage_warnings: row.coverage_warnings ?? [],
    consent_expires_at: dateValue(row.consent_expires_at),
    last_synced_at: dateValue(row.last_synced_at),
  };
}

function mapFinanceConnection(row) {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    provider: row.provider,
    ingestion_method: row.ingestion_method,
    freshness_mode: row.freshness_mode,
    institution_id: row.institution_id ?? null,
    institution_name: row.institution_name,
    status: row.status,
    error_code: row.error_code,
    last_synced_at: dateValue(row.last_synced_at),
    imported_through_on:
      row.imported_through_on == null
        ? null
        : String(row.imported_through_on),
    balance_as_of:
      row.balance_as_of == null ? null : String(row.balance_as_of),
    last_imported_at: dateValue(row.last_imported_at),
    last_import: row.last_imported_at
      ? {
          total_row_count: integer(row.last_total_row_count),
          new_row_count: integer(row.last_new_row_count),
          existing_row_count: integer(row.last_existing_row_count),
          rejected_row_count: integer(row.last_rejected_row_count),
          warning_count: integer(row.last_warning_count),
        }
      : null,
    account_id: row.account_id ?? null,
    mask: row.mask ?? null,
    current_balance_minor: integer(row.current_balance_minor),
    credit_limit_minor: integer(row.credit_limit_minor),
    manual_update_due: Boolean(row.manual_update_due),
  };
}

function mapAccount(row) {
  return {
    id: row.id,
    connection_id: row.connection_id,
    item_id: row.connection_id,
    institution_id: row.institution_id ?? null,
    provider: row.provider ?? "plaid",
    ingestion_method: row.ingestion_method ?? "plaid",
    imported_through_on:
      row.imported_through_on == null
        ? null
        : String(row.imported_through_on),
    balance_as_of:
      row.balance_as_of == null ? null : String(row.balance_as_of),
    institution_name: row.institution_name,
    name: row.name,
    official_name: row.official_name,
    mask: row.mask,
    type: row.type,
    subtype: row.subtype,
    currency_code: row.currency_code,
    current_balance_minor: integer(row.current_balance_minor),
    available_balance_minor: integer(row.available_balance_minor),
    credit_limit_minor: integer(row.credit_limit_minor),
    is_liability: row.is_liability,
    balance_group_override: row.balance_group_override ?? null,
    balance_group: inferBalanceGroup(row),
    active: row.active,
    last_synced_at: dateValue(row.last_synced_at),
  };
}

function mapTransaction(row) {
  return {
    id: row.id,
    account_id: row.account_id,
    account_name: row.account_name,
    account_mask: row.account_mask,
    institution_name: row.institution_name,
    merchant_name: row.merchant_name,
    normalized_merchant: row.normalized_merchant,
    name: row.name,
    normalized_name: row.normalized_name ?? null,
    authorized_on:
      row.authorized_on == null ? null : String(row.authorized_on),
    cardholder_name: row.cardholder_name ?? null,
    source_transaction_type: row.source_transaction_type ?? null,
    display_name:
      row.display_name ?? row.merchant_name ?? row.name,
    tags: Array.isArray(row.tags) ? row.tags : [],
    category_primary:
      row.effective_category_primary ?? row.category_primary ?? null,
    category_detailed:
      row.effective_category_detailed ?? row.category_detailed ?? null,
    amount_minor: integer(row.amount_minor),
    currency_code: row.currency_code,
    authorized_at: dateValue(row.authorized_at),
    posted_on: String(row.posted_on),
    pending: row.pending,
    excluded_from_spending:
      row.effective_excluded_from_spending ??
      row.excluded_from_spending ??
      false,
    is_fixed: row.is_fixed ?? false,
    original_transaction_id: row.original_transaction_id ?? null,
    payment_channel: row.payment_channel,
  };
}

function mapTransactionCleanupRule(row) {
  return {
    id: row.id,
    match_field: row.match_field,
    match_value: row.match_value,
    normalized_match_value: row.normalized_match_value,
    display_name: row.display_name ?? null,
    category_primary: row.category_primary ?? null,
    tags: row.tags == null
      ? null
      : Array.isArray(row.tags)
        ? row.tags
        : JSON.parse(row.tags),
    enabled: Boolean(row.enabled),
    matched_transaction_count:
      Number(row.matched_transaction_count) || 0,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: dateValue(row.created_at),
    updated_at: dateValue(row.updated_at),
  };
}

function mapManualAsset(row) {
  return {
    id: row.id,
    name: row.name,
    asset_type: row.asset_type,
    description: row.description ?? null,
    currency_code:
      row.valuation_currency_code ?? row.currency_code ?? "USD",
    active: row.active,
    archived_at: dateValue(row.archived_at),
    current_value_minor: integer(row.current_value_minor),
    valued_on: row.valued_on ? String(row.valued_on) : null,
    created_at: dateValue(row.created_at),
    updated_at: dateValue(row.updated_at),
  };
}

function mapManualAssetValuation(row) {
  return {
    asset_id: row.asset_id,
    valued_on: String(row.valued_on),
    value_minor: integer(row.value_minor),
    currency_code: row.currency_code,
  };
}

function mapCreditScoreSource(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    label: row.label,
    bureau: row.bureau ?? null,
    model: row.scoring_model ?? null,
    active: row.archived_on == null,
    archived_on: row.archived_on ? String(row.archived_on) : null,
    created_at: dateValue(row.created_at),
    updated_at: dateValue(row.updated_at),
  };
}

function mapCreditScoreObservation(row) {
  return {
    id: row.id,
    source_id: row.source_id,
    score: integer(row.score),
    observed_on: String(row.observed_on),
    created_at: dateValue(row.created_at),
    updated_at: dateValue(row.updated_at),
  };
}

function mapInsightFinding(row) {
  return {
    id: row.id,
    finding_key: row.finding_key ?? row.id,
    family: row.family,
    type: row.finding_type,
    severity: row.severity,
    title: row.title,
    explanation: row.explanation,
    period_start: row.period_start ? String(row.period_start) : null,
    period_end: row.period_end ? String(row.period_end) : null,
    metrics: row.metrics,
    rule: row.rule,
    confidence_basis_points: Number(row.confidence_basis_points),
    evidence: row.evidence,
    actions: row.actions,
    state: row.state,
    is_current: row.is_current !== false,
    retired_at: dateValue(row.retired_at),
    state_changed_at: dateValue(row.state_changed_at),
    state_changed_by: row.state_changed_by ?? null,
    generated_at: dateValue(row.generated_at),
    data_as_of: dateValue(row.data_as_of),
  };
}

function mapRecurring(row) {
  return {
    id: row.id,
    service_family: row.service_family,
    display_name: row.display_name,
    stream_type: row.stream_type,
    cadence: row.cadence,
    account_id: row.account_id,
    account_name: row.account_name,
    expected_amount_minor: integer(row.expected_amount_minor),
    min_amount_minor: integer(row.min_amount_minor),
    max_amount_minor: integer(row.max_amount_minor),
    monthly_equivalent_minor: integer(row.monthly_equivalent_minor),
    currency_code: row.currency_code,
    first_seen_on: String(row.first_seen_on),
    last_seen_on: String(row.last_seen_on),
    next_expected_on: row.next_expected_on
      ? String(row.next_expected_on)
      : null,
    confidence_basis_points: Number(row.confidence_basis_points),
    status: row.status,
    duplicate_state: row.duplicate_state,
    transaction_ids: row.transaction_ids,
  };
}

export {
  BALANCE_GROUPS,
  DEFAULT_WORKSPACE_ID,
  MANUAL_ASSET_TYPES,
  decodeCursor,
  inferBalanceGroup,
  normalizeSearchText,
};
