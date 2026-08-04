import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { withTransaction } from "./pool.js";
import { stableId } from "../services/ids.js";

const DEFAULT_WORKSPACE_ID = "shared";
const APPEARANCE_PREFERENCES = new Set(["system", "light", "dark"]);
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
const TRANSACTION_SORTS = new Set([
  "date",
  "merchant",
  "category",
  "cost",
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

function timestampValue(value) {
  if (value == null) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function jsonObject(value, fallback = {}) {
  if (typeof value === "string") {
    try {
      return jsonObject(JSON.parse(value), fallback);
    } catch {
      return fallback;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;
}

function transactionSort(value) {
  const normalized = String(value ?? "date").trim().toLowerCase();
  return TRANSACTION_SORTS.has(normalized) ? normalized : "date";
}

function transactionCursorKey(row, sort) {
  if (sort === "merchant") {
    return String(
      row.transaction_sort_merchant ??
        row.display_name ??
        row.merchant_name ??
        row.name ??
        "",
    ).toLowerCase();
  }
  if (sort === "category") {
    return String(
      row.transaction_sort_category ??
        row.split_category ??
        row.effective_category_primary ??
        row.category_primary ??
        "",
    ).toLowerCase();
  }
  if (sort === "cost") {
    return String(
      row.transaction_sort_cost ??
        row.split_category_amount_minor ??
        row.amount_minor ??
        0,
    );
  }
  return String(row.posted_on);
}

function encodeCursor(row, sort = "date") {
  const normalizedSort = transactionSort(sort);
  return Buffer.from(
    JSON.stringify({
      sort: normalizedSort,
      key: transactionCursorKey(row, normalizedSort),
      posted_on: String(row.posted_on),
      id: row.id,
    }),
  ).toString("base64url");
}

function decodeCursor(cursor, sort = "date") {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const expectedSort = transactionSort(sort);
    if (
      value.sort == null &&
      expectedSort === "date" &&
      typeof value.posted_on === "string" &&
      typeof value.id === "string"
    ) {
      return {
        sort: "date",
        key: value.posted_on,
        posted_on: value.posted_on,
        id: value.id,
      };
    }
    if (
      value.sort !== expectedSort ||
      !TRANSACTION_SORTS.has(value.sort) ||
      typeof value.key !== "string" ||
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

function investmentPersistenceMismatch(entity, received, inserted) {
  const kind = entity === "holdings" ? "HOLDINGS" : "TRANSACTIONS";
  const error = new Error(
    `Only ${inserted} of ${received} investment ${entity} matched stored accounts and securities`,
  );
  error.name = "InvestmentPersistenceError";
  error.code = `INVESTMENT_${kind}_PERSISTENCE_MISMATCH`;
  return error;
}

function inferBalanceGroup(account) {
  const type = normalizeSearchText(account.type).replaceAll(" ", "_");
  const subtype = normalizeSearchText(account.subtype).replaceAll(" ", "_");
  const requestedGroup =
    BALANCE_GROUPS.has(account.balance_group_override)
      ? account.balance_group_override
      : BALANCE_GROUPS.has(account.balance_group)
        ? account.balance_group
        : null;
  if (
    (RETIREMENT_SUBTYPES.has(subtype) ||
      account.balance_group === "retirement") &&
    ["cash", "taxable_investment"].includes(requestedGroup)
  ) {
    return "retirement";
  }
  if (BALANCE_GROUPS.has(account.balance_group_override)) {
    return account.balance_group_override;
  }
  if (BALANCE_GROUPS.has(account.balance_group)) {
    return account.balance_group;
  }
  if (RETIREMENT_SUBTYPES.has(subtype)) return "retirement";
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
  #transactionContext = new AsyncLocalStorage();

  constructor(pool) {
    if (!pool) throw new TypeError("pool is required");
    this.#pool = pool;
  }

  #client() {
    return this.#transactionContext.getStore()?.client ?? this.#pool;
  }

  async #withTransaction(operation) {
    const existing = this.#transactionContext.getStore();
    if (existing) return operation(existing.client);
    return withTransaction(this.#pool, (client) =>
      this.#transactionContext.run({ client }, () => operation(client)),
    );
  }

  transactionClient() {
    return this.#transactionContext.getStore()?.client ?? null;
  }

  async withPlaidSyncLock(itemId, operation) {
    if (typeof operation !== "function") {
      throw new TypeError("Plaid sync operation is required");
    }
    const client = await this.#pool.connect();
    const lockKey = `money:plaid-sync:${itemId}`;
    try {
      await client.query(
        "SELECT pg_advisory_lock(hashtextextended($1, 0))",
        [lockKey],
      );
    } catch (error) {
      client.release(true);
      throw error;
    }
    try {
      return await operation();
    } finally {
      try {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [lockKey],
        );
        client.release();
      } catch {
        // Destroying the session releases its advisory locks server-side.
        client.release(true);
      }
    }
  }

  async #assertBudgetHierarchy(client, workspaceId) {
    const result = await client.query(
      `SELECT budget_hierarchy_is_valid($1) AS is_valid`,
      [workspaceId],
    );
    if (result.rows[0]?.is_valid === false) {
      const error = new Error(
        "The category change would make the budget hierarchy invalid.",
      );
      error.code = "BUDGET_HIERARCHY_CONFLICT";
      throw error;
    }
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

  async #snapshotUnmatchedPendingEdits(
    client,
    { providerIds, itemId, replacementProviderIds = [] },
  ) {
    const removedIds = [...new Set(providerIds)].filter(Boolean);
    if (!removedIds.length) return;
    await client.query(
      `
        SELECT pending.id
        FROM transactions pending
        JOIN accounts account
          ON account.id = pending.account_id
         AND account.connection_id = $2
        WHERE pending.provider_transaction_id = ANY($1::text[])
          AND pending.pending = true
          AND NOT (
            pending.provider_transaction_id = ANY($3::text[])
          )
        ORDER BY pending.id
        FOR UPDATE OF pending
      `,
      [removedIds, itemId, replacementProviderIds],
    );
    await client.query(
      `
        WITH candidates AS (
          SELECT
            pending.*,
            CASE
              WHEN metadata.transaction_id IS NULL THEN NULL
              ELSE jsonb_build_object(
                'display_name', metadata.display_name,
                'display_name_overridden',
                  metadata.display_name_overridden,
                'display_name_updated_at',
                  metadata.display_name_updated_at,
                'tags_overridden', metadata.tags_overridden,
                'tags_updated_at', metadata.tags_updated_at,
                'note', metadata.note,
                'note_version', metadata.note_version,
                'note_updated_by', metadata.note_updated_by,
                'note_updated_at', metadata.note_updated_at,
                'budget_month_on', metadata.budget_month_on,
                'budget_month_overridden',
                  metadata.budget_month_overridden,
                'budget_month_updated_at',
                  metadata.budget_month_updated_at,
                'created_by', metadata.created_by,
                'created_at', metadata.created_at,
                'updated_at', metadata.updated_at
              )
            END AS metadata_state,
            CASE
              WHEN override.id IS NULL THEN NULL
              ELSE jsonb_build_object(
                'category_primary', override.category_primary,
                'category_detailed', override.category_detailed,
                'category_id', override.category_id,
                'category_overridden', override.category_overridden,
                'category_updated_at', override.category_updated_at,
                'excluded_from_spending',
                  override.excluded_from_spending,
                'excluded_from_spending_overridden',
                  override.excluded_from_spending_overridden,
                'excluded_from_spending_updated_at',
                  override.excluded_from_spending_updated_at,
                'cash_flow_role', override.cash_flow_role,
                'cash_flow_role_overridden',
                  override.cash_flow_role_overridden,
                'cash_flow_role_updated_at',
                  override.cash_flow_role_updated_at,
                'is_fixed', override.is_fixed,
                'is_fixed_overridden', override.is_fixed_overridden,
                'is_fixed_updated_at', override.is_fixed_updated_at,
                'created_by', override.created_by,
                'created_at', override.created_at,
                'updated_at', override.updated_at
              )
            END AS categorization_state,
            COALESCE(
              (
                SELECT jsonb_agg(
                  jsonb_build_object(
                    'name', tag.name,
                    'normalized_name', tag.normalized_name,
                    'created_by', assignment.created_by,
                    'created_at', assignment.created_at
                  )
                  ORDER BY tag.normalized_name, tag.id
                )
                FROM transaction_tag_assignments assignment
                JOIN transaction_tags tag
                  ON tag.workspace_id = assignment.workspace_id
                 AND tag.id = assignment.tag_id
                WHERE assignment.workspace_id = pending.workspace_id
                  AND assignment.transaction_id = pending.id
              ),
              '[]'::jsonb
            ) AS tag_state,
            COALESCE(
              (
                SELECT jsonb_agg(
                  jsonb_build_object(
                    'id', split.id,
                    'line_index', split.line_index,
                    'category', split.category,
                    'category_id', split.category_id,
                    'amount_minor', split.amount_minor,
                    'note', split.note,
                    'created_by', split.created_by,
                    'created_at', split.created_at,
                    'updated_at', split.updated_at
                  )
                  ORDER BY split.line_index, split.id
                )
                FROM transaction_splits split
                WHERE split.workspace_id = pending.workspace_id
                  AND split.transaction_id = pending.id
              ),
              '[]'::jsonb
            ) AS split_state,
            COALESCE(
              (
                SELECT jsonb_agg(
                  jsonb_build_object(
                    'id', rule.id,
                    'stream_id', rule.stream_id,
                    'account_id', rule.account_id,
                    'match_field', rule.match_field,
                    'normalized_match_value',
                      rule.normalized_match_value,
                    'anchor_amount_minor', rule.anchor_amount_minor,
                    'currency_code', rule.currency_code,
                    'stream_type', rule.stream_type,
                    'cadence', rule.cadence,
                    'active', rule.active,
                    'created_by', rule.created_by,
                    'updated_by', rule.updated_by,
                    'created_at', rule.created_at,
                    'updated_at', rule.updated_at
                  )
                  ORDER BY rule.updated_at DESC, rule.id
                )
                FROM recurring_pattern_rules rule
                WHERE rule.workspace_id = pending.workspace_id
                  AND rule.source_transaction_id = pending.id
              ),
              '[]'::jsonb
            ) AS recurring_state
          FROM transactions pending
          JOIN accounts account
            ON account.id = pending.account_id
           AND account.connection_id = $2
          LEFT JOIN transaction_metadata metadata
            ON metadata.workspace_id = pending.workspace_id
           AND metadata.transaction_id = pending.id
          LEFT JOIN categorization_overrides override
            ON override.workspace_id = pending.workspace_id
           AND override.transaction_id = pending.id
          WHERE pending.provider_transaction_id = ANY($1::text[])
            AND pending.pending = true
            AND NOT (
              pending.provider_transaction_id = ANY($3::text[])
            )
        ),
        snapshots AS (
          SELECT
            candidate.*,
            '{}'::jsonb
              || CASE
                WHEN candidate.metadata_state IS NOT NULL
                  THEN jsonb_build_object(
                    'metadata', candidate.metadata_state
                  )
                ELSE '{}'::jsonb
              END
              || CASE
                WHEN COALESCE(
                  (candidate.metadata_state ->>
                    'tags_overridden')::boolean,
                  false
                )
                  THEN jsonb_build_object('tags', candidate.tag_state)
                ELSE '{}'::jsonb
              END
              || CASE
                WHEN candidate.categorization_state IS NOT NULL
                  THEN jsonb_build_object(
                    'categorization_override',
                    candidate.categorization_state
                  )
                ELSE '{}'::jsonb
              END
              || CASE
                WHEN candidate.split_overridden = true
                  THEN jsonb_build_object(
                    'splits', candidate.split_state,
                    'split_version', candidate.split_version,
                    'split_overridden', true,
                    'split_updated_at', candidate.split_updated_at,
                    'split_needs_review',
                      candidate.split_needs_review
                  )
                ELSE '{}'::jsonb
              END
              || CASE
                WHEN jsonb_array_length(candidate.recurring_state) > 0
                  THEN jsonb_build_object(
                    'recurring_patterns', candidate.recurring_state
                  )
                ELSE '{}'::jsonb
              END AS user_state
          FROM candidates candidate
        )
        INSERT INTO unmatched_pending_transaction_edits (
          id,
          workspace_id,
          account_id,
          pending_transaction_id,
          provider_pending_transaction_id,
          user_state,
          provider_facts,
          pending_created_at,
          pending_updated_at,
          recovered_at,
          updated_at
        )
        SELECT
          'pending-recovery-' || md5(
            snapshot.workspace_id || ':' || snapshot.id
          ),
          snapshot.workspace_id,
          snapshot.account_id,
          snapshot.id,
          snapshot.provider_transaction_id,
          snapshot.user_state,
          jsonb_build_object(
            'merchant_name', snapshot.merchant_name,
            'name', snapshot.name,
            'category_primary', snapshot.category_primary,
            'category_detailed', snapshot.category_detailed,
            'amount_minor', snapshot.amount_minor,
            'currency_code', snapshot.currency_code,
            'authorized_at', snapshot.authorized_at,
            'authorized_on', snapshot.authorized_on,
            'posted_at', snapshot.posted_at,
            'posted_on', snapshot.posted_on,
            'cash_flow_role', snapshot.cash_flow_role,
            'payment_channel', snapshot.payment_channel
          ),
          snapshot.created_at,
          snapshot.updated_at,
          now(),
          now()
        FROM snapshots snapshot
        WHERE snapshot.user_state <> '{}'::jsonb
        ON CONFLICT (
          workspace_id,
          provider_pending_transaction_id
        ) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          pending_transaction_id = EXCLUDED.pending_transaction_id,
          user_state = EXCLUDED.user_state,
          provider_facts = EXCLUDED.provider_facts,
          pending_created_at = EXCLUDED.pending_created_at,
          pending_updated_at = EXCLUDED.pending_updated_at,
          recovered_at = now(),
          updated_at = now()
        WHERE unmatched_pending_transaction_edits.attached_at IS NULL
          AND unmatched_pending_transaction_edits.dismissed_at IS NULL
      `,
      [removedIds, itemId, replacementProviderIds],
    );
  }

  async #attachRecoveredSplits(
    client,
    {
      workspaceId,
      transactionId,
      target,
      recovery,
      providerFacts,
      splits,
      splitOverridden,
      splitUpdatedAt,
      splitVersion,
      splitNeedsReview,
      userId,
    },
  ) {
    if (!splitOverridden) return;
    const sourceSplitUpdatedAt = timestampValue(
      splitUpdatedAt ?? recovery.pending_updated_at,
    );
    if (
      target.split_overridden === true &&
      timestampValue(target.split_updated_at) > sourceSplitUpdatedAt
    ) {
      return;
    }

    const sourceAmount = Number(providerFacts.amount_minor);
    const targetAmount = Number(target.amount_minor);
    const validSource =
      Number.isSafeInteger(sourceAmount) &&
      Number.isSafeInteger(targetAmount) &&
      sourceAmount !== 0 &&
      targetAmount !== 0 &&
      providerFacts.currency_code === target.currency_code &&
      Math.sign(sourceAmount) === Math.sign(targetAmount) &&
      splitNeedsReview !== true &&
      splits.length >= 2 &&
      splits.every(
        (line) =>
          Number.isSafeInteger(Number(line.amount_minor)) &&
          Math.sign(Number(line.amount_minor)) === Math.sign(sourceAmount),
      ) &&
      splits.reduce(
        (sum, line) => sum + Number(line.amount_minor),
        0,
      ) === sourceAmount;
    const largestIndex = splits.reduce(
      (winner, line, index, lines) => {
        const winnerAmount = Math.abs(
          Number(lines[winner]?.amount_minor ?? 0),
        );
        const amount = Math.abs(Number(line.amount_minor));
        if (amount > winnerAmount) return index;
        if (amount < winnerAmount) return winner;
        return Number(line.line_index) <
          Number(lines[winner]?.line_index ?? Number.MAX_SAFE_INTEGER)
          ? index
          : winner;
      },
      0,
    );
    const delta = targetAmount - sourceAmount;
    const adjustedLargest =
      Number(splits[largestIndex]?.amount_minor ?? 0) + delta;
    const canReconcile =
      validSource &&
      adjustedLargest !== 0 &&
      Math.sign(adjustedLargest) === Math.sign(targetAmount);
    const attachedSplits = splits.map((line, index) => ({
      id: randomUUID(),
      line_index: Number(line.line_index),
      category: String(line.category),
      category_id: line.category_id ?? null,
      amount_minor:
        Number(line.amount_minor) +
        (canReconcile && index === largestIndex ? delta : 0),
      note: line.note ?? null,
      created_by: line.created_by ?? userId,
    }));

    await client.query(
      `
        DELETE FROM transaction_splits
        WHERE workspace_id = $1 AND transaction_id = $2
      `,
      [workspaceId, transactionId],
    );
    if (attachedSplits.length) {
      await client.query(
        `
          INSERT INTO transaction_splits (
            id, workspace_id, transaction_id, line_index,
            category, category_id, amount_minor, note, created_by
          )
          SELECT
            row.id, $1, $2, row.line_index, row.category,
            row.category_id, row.amount_minor, row.note, row.created_by
          FROM jsonb_to_recordset($3::jsonb) AS row(
            id text,
            line_index smallint,
            category text,
            category_id text,
            amount_minor bigint,
            note text,
            created_by text
          )
        `,
        [workspaceId, transactionId, JSON.stringify(attachedSplits)],
      );
    }
    await client.query(
      `
        UPDATE transactions
        SET split_version = GREATEST(split_version, $4::integer) + 1,
            split_needs_review = $3,
            split_overridden = true,
            split_updated_at = $5::timestamptz,
            updated_at = now()
        WHERE workspace_id = $1 AND id = $2
      `,
      [
        workspaceId,
        transactionId,
        splits.length > 0 && !canReconcile,
        Number(splitVersion ?? 0),
        splitUpdatedAt ?? recovery.pending_updated_at,
      ],
    );
  }

  async #handoffPendingTransactionEdits(
    client,
    replacementProviderIds,
  ) {
    const providerIds = [...new Set(replacementProviderIds)].filter(Boolean);
    if (!providerIds.length) return;

    const handoffResult = await client.query(
      `
        SELECT
          posted.workspace_id,
          posted.id AS posted_id,
          pending.id AS pending_id,
          (
            split_state.split_count = 0
            OR (
              posted.currency_code = pending.currency_code
              AND sign(posted.amount_minor) = sign(pending.amount_minor)
              AND posted.amount_minor <> 0
              AND pending.amount_minor <> 0
              AND pending.split_needs_review = false
              AND (
                split_state.split_count >= 2
                AND split_state.split_total = pending.amount_minor
                AND split_state.all_match_pending_sign
                AND split_state.largest_amount_minor
                    + posted.amount_minor
                    - pending.amount_minor <> 0
                AND sign(
                  split_state.largest_amount_minor
                    + posted.amount_minor
                    - pending.amount_minor
                ) = sign(posted.amount_minor)
              )
            )
          ) AS handoff_safe,
          (
            pending.split_overridden = true
            AND (
              posted.split_overridden = false
              OR COALESCE(
                posted.split_updated_at,
                '-infinity'::timestamptz
              ) <= COALESCE(
                pending.split_updated_at,
                pending.updated_at
              )
            )
          ) AS copy_splits,
          (
            posted.currency_code = pending.currency_code
            AND sign(posted.amount_minor) = sign(pending.amount_minor)
            AND posted.amount_minor < 0
            AND pending.amount_minor <> 0
            AND COALESCE(
              NULLIF(posted.normalized_merchant, ''),
              NULLIF(posted.normalized_name, '')
            ) IS NOT NULL
          ) AS recurring_safe
        FROM transactions posted
        JOIN transactions pending
          ON pending.workspace_id = posted.workspace_id
         AND pending.provider_transaction_id =
           posted.provider_pending_transaction_id
         AND pending.pending = true
        LEFT JOIN LATERAL (
          SELECT
            count(*)::integer AS split_count,
            COALESCE(sum(split.amount_minor), 0)::bigint AS split_total,
            COALESCE(
              bool_and(
                sign(split.amount_minor) = sign(pending.amount_minor)
              ),
              true
            ) AS all_match_pending_sign,
            COALESCE(
              (
                array_agg(
                  split.amount_minor
                  ORDER BY
                    abs(split.amount_minor) DESC,
                    split.line_index,
                    split.id
                )
              )[1],
              0
            )::bigint AS largest_amount_minor
          FROM transaction_splits split
          WHERE split.workspace_id = pending.workspace_id
            AND split.transaction_id = pending.id
        ) split_state ON true
        WHERE posted.provider_pending_transaction_id = ANY($1::text[])
          AND posted.pending = false
        ORDER BY posted.workspace_id, posted.id
        FOR UPDATE OF posted, pending
      `,
      [providerIds],
    );
    const handoffPairs = handoffResult.rows;

    if (handoffPairs.length) {
      const pairs = handoffPairs.map((row) => ({
        workspace_id: row.workspace_id,
        pending_id: row.pending_id,
        posted_id: row.posted_id,
        copy_splits: Boolean(row.copy_splits),
        reconcile_splits: Boolean(row.handoff_safe),
        recurring_safe: Boolean(row.recurring_safe),
      }));
      const serializedPairs = JSON.stringify(pairs);

      await client.query(
        `
          WITH pairs AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS pair(
              workspace_id text,
              pending_id text,
              posted_id text,
              copy_splits boolean,
              recurring_safe boolean
            )
          ),
          transferable AS (
            SELECT pair.*
            FROM pairs pair
            JOIN transaction_metadata pending_metadata
              ON pending_metadata.workspace_id = pair.workspace_id
             AND pending_metadata.transaction_id = pair.pending_id
            LEFT JOIN transaction_metadata posted_metadata
              ON posted_metadata.workspace_id = pair.workspace_id
             AND posted_metadata.transaction_id = pair.posted_id
            WHERE pending_metadata.tags_overridden = true
              AND (
                posted_metadata.transaction_id IS NULL
                OR posted_metadata.tags_overridden = false
                OR COALESCE(
                  posted_metadata.tags_updated_at,
                  posted_metadata.updated_at
                ) <= COALESCE(
                  pending_metadata.tags_updated_at,
                  pending_metadata.updated_at
                )
              )
          )
          DELETE FROM transaction_tag_assignments assignment
          USING transferable
          WHERE assignment.workspace_id = transferable.workspace_id
            AND assignment.transaction_id = transferable.posted_id
        `,
        [serializedPairs],
      );
      await client.query(
        `
          WITH pairs AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS pair(
              workspace_id text,
              pending_id text,
              posted_id text,
              copy_splits boolean
            )
          ),
          transferable AS (
            SELECT pair.*
            FROM pairs pair
            JOIN transaction_metadata pending_metadata
              ON pending_metadata.workspace_id = pair.workspace_id
             AND pending_metadata.transaction_id = pair.pending_id
            LEFT JOIN transaction_metadata posted_metadata
              ON posted_metadata.workspace_id = pair.workspace_id
             AND posted_metadata.transaction_id = pair.posted_id
            WHERE pending_metadata.tags_overridden = true
              AND (
                posted_metadata.transaction_id IS NULL
                OR posted_metadata.tags_overridden = false
                OR COALESCE(
                  posted_metadata.tags_updated_at,
                  posted_metadata.updated_at
                ) <= COALESCE(
                  pending_metadata.tags_updated_at,
                  pending_metadata.updated_at
                )
              )
          )
          INSERT INTO transaction_tag_assignments (
            workspace_id,
            transaction_id,
            tag_id,
            created_by,
            created_at
          )
          SELECT
            assignment.workspace_id,
            transferable.posted_id,
            assignment.tag_id,
            assignment.created_by,
            assignment.created_at
          FROM transferable
          JOIN transaction_tag_assignments assignment
            ON assignment.workspace_id = transferable.workspace_id
           AND assignment.transaction_id = transferable.pending_id
          ON CONFLICT DO NOTHING
        `,
        [serializedPairs],
      );
      await client.query(
        `
          WITH pairs AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS pair(
              workspace_id text,
              pending_id text,
              posted_id text,
              copy_splits boolean
            )
          )
          INSERT INTO transaction_metadata (
            workspace_id,
            transaction_id,
            display_name,
            display_name_overridden,
            display_name_updated_at,
            tags_overridden,
            tags_updated_at,
            note,
            note_version,
            note_updated_by,
            note_updated_at,
            budget_month_on,
            budget_month_overridden,
            budget_month_updated_at,
            created_by,
            created_at,
            updated_at
          )
          SELECT
            pending_metadata.workspace_id,
            pair.posted_id,
            pending_metadata.display_name,
            pending_metadata.display_name_overridden,
            pending_metadata.display_name_updated_at,
            pending_metadata.tags_overridden,
            pending_metadata.tags_updated_at,
            pending_metadata.note,
            pending_metadata.note_version,
            pending_metadata.note_updated_by,
            pending_metadata.note_updated_at,
            pending_metadata.budget_month_on,
            pending_metadata.budget_month_overridden,
            pending_metadata.budget_month_updated_at,
            pending_metadata.created_by,
            pending_metadata.created_at,
            pending_metadata.updated_at
          FROM pairs pair
          JOIN transaction_metadata pending_metadata
            ON pending_metadata.workspace_id = pair.workspace_id
           AND pending_metadata.transaction_id = pair.pending_id
          ON CONFLICT (workspace_id, transaction_id) DO UPDATE SET
            display_name = CASE
              WHEN EXCLUDED.display_name_overridden = true
                AND (
                  transaction_metadata.display_name_overridden = false
                  OR COALESCE(
                    transaction_metadata.display_name_updated_at,
                    transaction_metadata.updated_at
                  ) <= COALESCE(
                    EXCLUDED.display_name_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN EXCLUDED.display_name
              ELSE transaction_metadata.display_name
            END,
            display_name_overridden = CASE
              WHEN EXCLUDED.display_name_overridden = true
                AND (
                  transaction_metadata.display_name_overridden = false
                  OR COALESCE(
                    transaction_metadata.display_name_updated_at,
                    transaction_metadata.updated_at
                  ) <= COALESCE(
                    EXCLUDED.display_name_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN true
              ELSE transaction_metadata.display_name_overridden
            END,
            display_name_updated_at = CASE
              WHEN EXCLUDED.display_name_overridden = true
                AND (
                  transaction_metadata.display_name_overridden = false
                  OR COALESCE(
                    transaction_metadata.display_name_updated_at,
                    transaction_metadata.updated_at
                  ) <= COALESCE(
                    EXCLUDED.display_name_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN COALESCE(
                  EXCLUDED.display_name_updated_at,
                  EXCLUDED.updated_at
                )
              ELSE transaction_metadata.display_name_updated_at
            END,
            tags_overridden = CASE
              WHEN EXCLUDED.tags_overridden = true
                AND (
                  transaction_metadata.tags_overridden = false
                  OR COALESCE(
                    transaction_metadata.tags_updated_at,
                    transaction_metadata.updated_at
                  ) <= COALESCE(
                    EXCLUDED.tags_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN true
              ELSE transaction_metadata.tags_overridden
            END,
            tags_updated_at = CASE
              WHEN EXCLUDED.tags_overridden = true
                AND (
                  transaction_metadata.tags_overridden = false
                  OR COALESCE(
                    transaction_metadata.tags_updated_at,
                    transaction_metadata.updated_at
                  ) <= COALESCE(
                    EXCLUDED.tags_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN COALESCE(
                  EXCLUDED.tags_updated_at,
                  EXCLUDED.updated_at
                )
              ELSE transaction_metadata.tags_updated_at
            END,
            note = CASE
              WHEN EXCLUDED.note_version > 0
                AND (
                  transaction_metadata.note_version = 0
                  OR transaction_metadata.note_updated_at IS NULL
                  OR transaction_metadata.note_updated_at <=
                    EXCLUDED.note_updated_at
                )
                THEN EXCLUDED.note
              ELSE transaction_metadata.note
            END,
            note_version = CASE
              WHEN EXCLUDED.note_version > 0
                AND (
                  transaction_metadata.note_version = 0
                  OR transaction_metadata.note_updated_at IS NULL
                  OR transaction_metadata.note_updated_at <=
                    EXCLUDED.note_updated_at
                )
                THEN EXCLUDED.note_version
              ELSE transaction_metadata.note_version
            END,
            note_updated_by = CASE
              WHEN EXCLUDED.note_version > 0
                AND (
                  transaction_metadata.note_version = 0
                  OR transaction_metadata.note_updated_at IS NULL
                  OR transaction_metadata.note_updated_at <=
                    EXCLUDED.note_updated_at
                )
                THEN EXCLUDED.note_updated_by
              ELSE transaction_metadata.note_updated_by
            END,
            note_updated_at = CASE
              WHEN EXCLUDED.note_version > 0
                AND (
                  transaction_metadata.note_version = 0
                  OR transaction_metadata.note_updated_at IS NULL
                  OR transaction_metadata.note_updated_at <=
                    EXCLUDED.note_updated_at
                )
                THEN EXCLUDED.note_updated_at
              ELSE transaction_metadata.note_updated_at
            END,
            budget_month_on = CASE
              WHEN EXCLUDED.budget_month_overridden = true
                AND (
                  transaction_metadata.budget_month_overridden = false
                  OR COALESCE(
                    transaction_metadata.budget_month_updated_at,
                    transaction_metadata.updated_at
                  ) <= COALESCE(
                    EXCLUDED.budget_month_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN EXCLUDED.budget_month_on
              ELSE transaction_metadata.budget_month_on
            END,
            budget_month_overridden = CASE
              WHEN EXCLUDED.budget_month_overridden = true
                AND (
                  transaction_metadata.budget_month_overridden = false
                  OR COALESCE(
                    transaction_metadata.budget_month_updated_at,
                    transaction_metadata.updated_at
                  ) <= COALESCE(
                    EXCLUDED.budget_month_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN true
              ELSE transaction_metadata.budget_month_overridden
            END,
            budget_month_updated_at = CASE
              WHEN EXCLUDED.budget_month_overridden = true
                AND (
                  transaction_metadata.budget_month_overridden = false
                  OR COALESCE(
                    transaction_metadata.budget_month_updated_at,
                    transaction_metadata.updated_at
                  ) <= COALESCE(
                    EXCLUDED.budget_month_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN COALESCE(
                  EXCLUDED.budget_month_updated_at,
                  EXCLUDED.updated_at
                )
              ELSE transaction_metadata.budget_month_updated_at
            END,
            created_at = LEAST(
              transaction_metadata.created_at,
              EXCLUDED.created_at
            ),
            updated_at = GREATEST(
              transaction_metadata.updated_at,
              EXCLUDED.updated_at
            )
        `,
        [serializedPairs],
      );
      await client.query(
        `
          WITH pairs AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS pair(
              workspace_id text,
              pending_id text,
              posted_id text,
              copy_splits boolean
            )
          )
          INSERT INTO categorization_overrides (
            id,
            workspace_id,
            transaction_id,
            category_primary,
            category_detailed,
            category_id,
            category_overridden,
            category_updated_at,
            excluded_from_spending,
            excluded_from_spending_overridden,
            excluded_from_spending_updated_at,
            is_fixed,
            is_fixed_overridden,
            is_fixed_updated_at,
            cash_flow_role,
            cash_flow_role_overridden,
            cash_flow_role_updated_at,
            created_by,
            created_at,
            updated_at
          )
          SELECT
            'pending-handoff-' || md5(
              pending_override.id || ':' || pair.posted_id
            ),
            pending_override.workspace_id,
            pair.posted_id,
            pending_override.category_primary,
            pending_override.category_detailed,
            pending_override.category_id,
            pending_override.category_overridden,
            pending_override.category_updated_at,
            pending_override.excluded_from_spending,
            pending_override.excluded_from_spending_overridden,
            pending_override.excluded_from_spending_updated_at,
            pending_override.is_fixed,
            pending_override.is_fixed_overridden,
            pending_override.is_fixed_updated_at,
            pending_override.cash_flow_role,
            pending_override.cash_flow_role_overridden,
            pending_override.cash_flow_role_updated_at,
            pending_override.created_by,
            pending_override.created_at,
            pending_override.updated_at
          FROM pairs pair
          JOIN categorization_overrides pending_override
            ON pending_override.workspace_id = pair.workspace_id
           AND pending_override.transaction_id = pair.pending_id
          ON CONFLICT (workspace_id, transaction_id)
            WHERE transaction_id IS NOT NULL
          DO UPDATE SET
            category_primary = CASE
              WHEN EXCLUDED.category_overridden = true
                AND (
                  categorization_overrides.category_overridden = false
                  OR COALESCE(
                    categorization_overrides.category_updated_at,
                    categorization_overrides.updated_at
                  ) <= COALESCE(
                    EXCLUDED.category_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN EXCLUDED.category_primary
              ELSE categorization_overrides.category_primary
            END,
            category_detailed = CASE
              WHEN EXCLUDED.category_overridden = true
                AND (
                  categorization_overrides.category_overridden = false
                  OR COALESCE(
                    categorization_overrides.category_updated_at,
                    categorization_overrides.updated_at
                  ) <= COALESCE(
                    EXCLUDED.category_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN EXCLUDED.category_detailed
              ELSE categorization_overrides.category_detailed
            END,
            category_id = CASE
              WHEN EXCLUDED.category_overridden = true
                AND (
                  categorization_overrides.category_overridden = false
                  OR COALESCE(
                    categorization_overrides.category_updated_at,
                    categorization_overrides.updated_at
                  ) <= COALESCE(
                    EXCLUDED.category_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN EXCLUDED.category_id
              ELSE categorization_overrides.category_id
            END,
            category_overridden = CASE
              WHEN EXCLUDED.category_overridden = true
                AND (
                  categorization_overrides.category_overridden = false
                  OR COALESCE(
                    categorization_overrides.category_updated_at,
                    categorization_overrides.updated_at
                  ) <= COALESCE(
                    EXCLUDED.category_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN true
              ELSE categorization_overrides.category_overridden
            END,
            category_updated_at = CASE
              WHEN EXCLUDED.category_overridden = true
                AND (
                  categorization_overrides.category_overridden = false
                  OR COALESCE(
                    categorization_overrides.category_updated_at,
                    categorization_overrides.updated_at
                  ) <= COALESCE(
                    EXCLUDED.category_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN COALESCE(
                  EXCLUDED.category_updated_at,
                  EXCLUDED.updated_at
                )
              ELSE categorization_overrides.category_updated_at
            END,
            excluded_from_spending = CASE
              WHEN EXCLUDED.excluded_from_spending_overridden = true
                AND (
                  categorization_overrides.excluded_from_spending_overridden
                    = false
                  OR COALESCE(
                    categorization_overrides.excluded_from_spending_updated_at,
                    categorization_overrides.updated_at
                  ) <= COALESCE(
                    EXCLUDED.excluded_from_spending_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN EXCLUDED.excluded_from_spending
              ELSE categorization_overrides.excluded_from_spending
            END,
            excluded_from_spending_overridden = CASE
              WHEN EXCLUDED.excluded_from_spending_overridden = true
                AND (
                  categorization_overrides.excluded_from_spending_overridden
                    = false
                  OR COALESCE(
                    categorization_overrides.excluded_from_spending_updated_at,
                    categorization_overrides.updated_at
                  ) <= COALESCE(
                    EXCLUDED.excluded_from_spending_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN true
              ELSE categorization_overrides.excluded_from_spending_overridden
            END,
            excluded_from_spending_updated_at = CASE
              WHEN EXCLUDED.excluded_from_spending_overridden = true
                AND (
                  categorization_overrides.excluded_from_spending_overridden
                    = false
                  OR COALESCE(
                    categorization_overrides.excluded_from_spending_updated_at,
                    categorization_overrides.updated_at
                  ) <= COALESCE(
                    EXCLUDED.excluded_from_spending_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN COALESCE(
                  EXCLUDED.excluded_from_spending_updated_at,
                  EXCLUDED.updated_at
                )
              ELSE categorization_overrides.excluded_from_spending_updated_at
            END,
            is_fixed = CASE
              WHEN EXCLUDED.is_fixed_overridden = true
                AND (
                  categorization_overrides.is_fixed_overridden = false
                  OR COALESCE(
                    categorization_overrides.is_fixed_updated_at,
                    categorization_overrides.updated_at
                  ) <= COALESCE(
                    EXCLUDED.is_fixed_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN EXCLUDED.is_fixed
              ELSE categorization_overrides.is_fixed
            END,
            is_fixed_overridden = CASE
              WHEN EXCLUDED.is_fixed_overridden = true
                AND (
                  categorization_overrides.is_fixed_overridden = false
                  OR COALESCE(
                    categorization_overrides.is_fixed_updated_at,
                    categorization_overrides.updated_at
                  ) <= COALESCE(
                    EXCLUDED.is_fixed_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN true
              ELSE categorization_overrides.is_fixed_overridden
            END,
            is_fixed_updated_at = CASE
              WHEN EXCLUDED.is_fixed_overridden = true
                AND (
                  categorization_overrides.is_fixed_overridden = false
                  OR COALESCE(
                    categorization_overrides.is_fixed_updated_at,
                    categorization_overrides.updated_at
                  ) <= COALESCE(
                    EXCLUDED.is_fixed_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN COALESCE(
                  EXCLUDED.is_fixed_updated_at,
                  EXCLUDED.updated_at
                )
              ELSE categorization_overrides.is_fixed_updated_at
            END,
            cash_flow_role = CASE
              WHEN EXCLUDED.cash_flow_role_overridden = true
                AND (
                  categorization_overrides.cash_flow_role_overridden = false
                  OR COALESCE(
                    categorization_overrides.cash_flow_role_updated_at,
                    categorization_overrides.updated_at
                  ) <= COALESCE(
                    EXCLUDED.cash_flow_role_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN EXCLUDED.cash_flow_role
              ELSE categorization_overrides.cash_flow_role
            END,
            cash_flow_role_overridden = CASE
              WHEN EXCLUDED.cash_flow_role_overridden = true
                AND (
                  categorization_overrides.cash_flow_role_overridden = false
                  OR COALESCE(
                    categorization_overrides.cash_flow_role_updated_at,
                    categorization_overrides.updated_at
                  ) <= COALESCE(
                    EXCLUDED.cash_flow_role_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN true
              ELSE categorization_overrides.cash_flow_role_overridden
            END,
            cash_flow_role_updated_at = CASE
              WHEN EXCLUDED.cash_flow_role_overridden = true
                AND (
                  categorization_overrides.cash_flow_role_overridden = false
                  OR COALESCE(
                    categorization_overrides.cash_flow_role_updated_at,
                    categorization_overrides.updated_at
                  ) <= COALESCE(
                    EXCLUDED.cash_flow_role_updated_at,
                    EXCLUDED.updated_at
                  )
                )
                THEN COALESCE(
                  EXCLUDED.cash_flow_role_updated_at,
                  EXCLUDED.updated_at
                )
              ELSE categorization_overrides.cash_flow_role_updated_at
            END,
            created_at = LEAST(
              categorization_overrides.created_at,
              EXCLUDED.created_at
            ),
            updated_at = GREATEST(
              categorization_overrides.updated_at,
              EXCLUDED.updated_at
            )
        `,
        [serializedPairs],
      );
      await client.query(
        `
          WITH pairs AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS pair(
              workspace_id text,
              pending_id text,
              posted_id text,
              copy_splits boolean,
              recurring_safe boolean
            )
          )
          INSERT INTO recurring_stream_transactions (
            stream_id,
            transaction_id
          )
          SELECT occurrence.stream_id, pair.posted_id
          FROM pairs pair
          JOIN recurring_stream_transactions occurrence
            ON occurrence.transaction_id = pair.pending_id
          JOIN transactions posted
            ON posted.workspace_id = pair.workspace_id
           AND posted.id = pair.posted_id
          WHERE pair.recurring_safe = true
            AND NOT EXISTS (
              SELECT 1
              FROM recurring_pattern_rules rule
              WHERE rule.workspace_id = pair.workspace_id
                AND rule.source_transaction_id = pair.pending_id
                AND rule.active = true
                AND rule.currency_code <> posted.currency_code
            )
          ON CONFLICT DO NOTHING
        `,
        [serializedPairs],
      );
      await client.query(
        `
          WITH pairs AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS pair(
              workspace_id text,
              pending_id text,
              posted_id text,
              recurring_safe boolean
            )
          ),
          source_rules AS (
            SELECT rule.*, pair.posted_id
            FROM pairs pair
            JOIN recurring_pattern_rules rule
              ON rule.workspace_id = pair.workspace_id
             AND rule.source_transaction_id = pair.pending_id
          )
          UPDATE recurring_pattern_rules target_rule
          SET active = false
          FROM source_rules source_rule
          WHERE target_rule.workspace_id = source_rule.workspace_id
            AND target_rule.source_transaction_id = source_rule.posted_id
            AND target_rule.id <> source_rule.id
            AND target_rule.active = true
            AND target_rule.updated_at <= source_rule.updated_at
        `,
        [serializedPairs],
      );
      await client.query(
        `
          WITH pairs AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS pair(
              workspace_id text,
              pending_id text,
              posted_id text,
              recurring_safe boolean
            )
          )
          UPDATE recurring_pattern_rules source_rule
          SET source_transaction_id = pair.posted_id,
              active = false
          FROM pairs pair
          WHERE source_rule.workspace_id = pair.workspace_id
            AND source_rule.source_transaction_id = pair.pending_id
            AND EXISTS (
              SELECT 1
              FROM recurring_pattern_rules target_rule
              WHERE target_rule.workspace_id = pair.workspace_id
                AND target_rule.source_transaction_id = pair.posted_id
                AND target_rule.id <> source_rule.id
                AND target_rule.active = true
                AND target_rule.updated_at > source_rule.updated_at
            )
        `,
        [serializedPairs],
      );
      await client.query(
        `
          WITH pairs AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS pair(
              workspace_id text,
              pending_id text,
              posted_id text,
              recurring_safe boolean
            )
          )
          UPDATE recurring_pattern_rules rule
          SET source_transaction_id = pair.posted_id,
              account_id = posted.account_id,
              match_field = CASE
                WHEN NULLIF(posted.normalized_merchant, '') IS NOT NULL
                  THEN 'normalized_merchant'
                ELSE 'normalized_name'
              END,
              normalized_match_value = COALESCE(
                NULLIF(posted.normalized_merchant, ''),
                NULLIF(posted.normalized_name, '')
              ),
              anchor_amount_minor = abs(posted.amount_minor),
              currency_code = posted.currency_code
          FROM pairs pair
          JOIN transactions posted
            ON posted.workspace_id = pair.workspace_id
           AND posted.id = pair.posted_id
          WHERE rule.workspace_id = pair.workspace_id
            AND rule.source_transaction_id = pair.pending_id
            AND pair.recurring_safe = true
            AND rule.currency_code = posted.currency_code
            AND COALESCE(
              NULLIF(posted.normalized_merchant, ''),
              NULLIF(posted.normalized_name, '')
            ) IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM recurring_pattern_rules target_rule
              WHERE target_rule.workspace_id = pair.workspace_id
                AND target_rule.source_transaction_id = pair.posted_id
                AND target_rule.id <> rule.id
                AND target_rule.active = true
                AND target_rule.updated_at > rule.updated_at
            )
        `,
        [serializedPairs],
      );
      await client.query(
        `
          WITH pairs AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS pair(
              workspace_id text,
              pending_id text,
              posted_id text,
              recurring_safe boolean
            )
          ),
          review_rules AS (
            UPDATE recurring_pattern_rules rule
            SET source_transaction_id = pair.posted_id,
                active = false
            FROM pairs pair
            JOIN transactions posted
              ON posted.workspace_id = pair.workspace_id
             AND posted.id = pair.posted_id
            WHERE rule.workspace_id = pair.workspace_id
              AND rule.source_transaction_id = pair.pending_id
              AND rule.active = true
              AND (
                pair.recurring_safe = false
                OR rule.currency_code <> posted.currency_code
                OR COALESCE(
                  NULLIF(posted.normalized_merchant, ''),
                  NULLIF(posted.normalized_name, '')
                ) IS NULL
              )
              AND NOT EXISTS (
                SELECT 1
                FROM recurring_pattern_rules target_rule
                WHERE target_rule.workspace_id = pair.workspace_id
                  AND target_rule.source_transaction_id = pair.posted_id
                  AND target_rule.id <> rule.id
                  AND target_rule.active = true
                  AND target_rule.updated_at > rule.updated_at
              )
            RETURNING
              rule.workspace_id,
              rule.source_transaction_id AS posted_id
          )
          UPDATE transactions posted
          SET recurring_needs_review = true,
              updated_at = now()
          FROM review_rules review
          WHERE posted.workspace_id = review.workspace_id
            AND posted.id = review.posted_id
        `,
        [serializedPairs],
      );
      await client.query(
        `
          WITH pairs AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS pair(
              workspace_id text,
              pending_id text,
              posted_id text,
              copy_splits boolean
            )
          )
          DELETE FROM transaction_splits posted_split
          USING pairs pair
          WHERE pair.copy_splits = true
            AND posted_split.workspace_id = pair.workspace_id
            AND posted_split.transaction_id = pair.posted_id
        `,
        [serializedPairs],
      );
      await client.query(
        `
          WITH pairs AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS pair(
              workspace_id text,
              pending_id text,
              posted_id text,
              copy_splits boolean,
              reconcile_splits boolean
            )
          ),
          ranked_splits AS (
            SELECT
              pair.workspace_id,
              pair.pending_id,
              pair.posted_id,
              pair.reconcile_splits,
              split.id AS pending_split_id,
              split.line_index,
              split.category,
              split.amount_minor,
              split.note,
              split.created_by,
              split.created_at,
              split.updated_at,
              split.category_id,
              row_number() OVER (
                PARTITION BY pair.workspace_id, pair.pending_id
                ORDER BY
                  abs(split.amount_minor) DESC,
                  split.line_index,
                  split.id
              ) AS adjustment_rank
            FROM pairs pair
            JOIN transaction_splits split
              ON split.workspace_id = pair.workspace_id
             AND split.transaction_id = pair.pending_id
            WHERE pair.copy_splits = true
          )
          INSERT INTO transaction_splits (
            id,
            workspace_id,
            transaction_id,
            line_index,
            category,
            amount_minor,
            note,
            created_by,
            created_at,
            updated_at,
            category_id
          )
          SELECT
            'pending-handoff-' || md5(
              ranked.pending_split_id || ':' || ranked.posted_id
            ),
            ranked.workspace_id,
            ranked.posted_id,
            ranked.line_index,
            ranked.category,
            ranked.amount_minor + CASE
              WHEN ranked.reconcile_splits = true
                AND ranked.adjustment_rank = 1
                THEN posted.amount_minor - pending.amount_minor
              ELSE 0
            END,
            ranked.note,
            ranked.created_by,
            ranked.created_at,
            ranked.updated_at,
            ranked.category_id
          FROM ranked_splits ranked
          JOIN transactions posted
            ON posted.workspace_id = ranked.workspace_id
           AND posted.id = ranked.posted_id
          JOIN transactions pending
            ON pending.workspace_id = ranked.workspace_id
           AND pending.id = ranked.pending_id
          ON CONFLICT (transaction_id, line_index) DO NOTHING
        `,
        [serializedPairs],
      );
      await client.query(
        `
          WITH pairs AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS pair(
              workspace_id text,
              pending_id text,
              posted_id text,
              copy_splits boolean,
              reconcile_splits boolean
            )
          )
          UPDATE transactions posted
          SET split_version = GREATEST(
                posted.split_version,
                pending.split_version
              ) + 1,
              split_needs_review = NOT pair.reconcile_splits,
              split_overridden = true,
              split_updated_at = COALESCE(
                pending.split_updated_at,
                pending.updated_at
              ),
              updated_at = now()
          FROM pairs pair
          JOIN transactions pending
            ON pending.workspace_id = pair.workspace_id
           AND pending.id = pair.pending_id
          WHERE pair.copy_splits = true
            AND posted.workspace_id = pair.workspace_id
            AND posted.id = pair.posted_id
        `,
        [serializedPairs],
      );
    }

    if (handoffPairs.length) {
      await client.query(
        `
          DELETE FROM transactions pending
          WHERE pending.id = ANY($1::text[])
            AND pending.pending = true
        `,
        [handoffPairs.map((row) => row.pending_id)],
      );
    }

    const refreshByWorkspace = new Map();
    for (const row of handoffPairs) {
      const ids = refreshByWorkspace.get(row.workspace_id) ?? [];
      ids.push(row.pending_id, row.posted_id);
      refreshByWorkspace.set(row.workspace_id, ids);
    }
    for (const [workspaceId, transactionIds] of refreshByWorkspace) {
      await this.#refreshTransactionSearchDocuments(
        client,
        workspaceId,
        transactionIds,
      );
    }
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
            CASE
              WHEN metadata.display_name_overridden
                THEN metadata.display_name
              ELSE COALESCE(
                metadata.display_name,
                cleanup_rule.display_name
              )
            END,
            t.merchant_name,
            t.name
          ),
          concat_ws(
            ' · ',
            a.name,
            COALESCE(
              effective_category.category_name,
              effective_category.source_category_label
            ),
            t.posted_on::text
          ),
          concat_ws(
            ' ',
            CASE
              WHEN metadata.display_name_overridden
                THEN metadata.display_name
              ELSE COALESCE(
                metadata.display_name,
                cleanup_rule.display_name
              )
            END,
            metadata.note,
            t.merchant_name,
            t.name,
            COALESCE(
              effective_category.category_name,
              effective_category.source_category_label
            ),
            split_categories.names,
            t.category_primary,
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
              CASE
                WHEN metadata.display_name_overridden
                  THEN metadata.display_name
                ELSE COALESCE(
                  metadata.display_name,
                  cleanup_rule.display_name
                )
              END,
              metadata.note,
              t.merchant_name,
              t.name,
              COALESCE(
                effective_category.category_name,
                effective_category.source_category_label
              ),
              split_categories.names,
              t.category_primary,
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
              'category_id', effective_category.category_id,
              'category', COALESCE(
                effective_category.category_name,
                effective_category.source_category_label
              ),
              'original_category', t.category_primary,
              'tags', effective_tags.tags,
              'note', metadata.note
            )
          )
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        LEFT JOIN transaction_effective_spending_categories
          effective_category
          ON effective_category.workspace_id = t.workspace_id
         AND effective_category.transaction_id = t.id
        LEFT JOIN LATERAL (
          SELECT string_agg(
            category_label.label,
            ' '
            ORDER BY category_label.label
          ) AS names
          FROM (
            SELECT DISTINCT concat_ws(
              ' ',
              spending_category_name_for_id(
                split.workspace_id,
                split.category_id
              ),
              split.category
            ) AS label
            FROM transaction_splits split
            WHERE split.workspace_id = t.workspace_id
              AND split.transaction_id = t.id
          ) category_label
        ) split_categories ON true
        LEFT JOIN transaction_metadata metadata
          ON metadata.workspace_id = t.workspace_id
         AND metadata.transaction_id = t.id
        LEFT JOIN LATERAL (
          SELECT rule.*
          FROM transaction_cleanup_rules rule
          WHERE rule.workspace_id = t.workspace_id
            AND rule.enabled = true
            AND transaction_cleanup_rule_matches(
              rule.match_field,
              rule.match_mode,
              rule.normalized_match_value,
              t.normalized_merchant,
              t.normalized_name
            )
            AND transaction_cleanup_rule_amount_matches(
              rule.match_amount_operator,
              rule.match_amount_minor,
              t.amount_minor
            )
          ORDER BY
            (rule.match_mode = 'exact') DESC,
            (rule.match_amount_operator IS NOT NULL) DESC,
            (rule.match_field = 'normalized_merchant') DESC,
            length(rule.normalized_match_value) DESC,
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
            AND transaction_cleanup_rule_matches(
              rule.match_field,
              rule.match_mode,
              rule.normalized_match_value,
              original.normalized_merchant,
              original.normalized_name
            )
            AND transaction_cleanup_rule_amount_matches(
              rule.match_amount_operator,
              rule.match_amount_minor,
              original.amount_minor
            )
          ORDER BY
            (rule.match_mode = 'exact') DESC,
            (rule.match_amount_operator IS NOT NULL) DESC,
            (rule.match_field = 'normalized_merchant') DESC,
            length(rule.normalized_match_value) DESC,
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
    {
      match_field: matchField,
      match_mode: matchMode = "exact",
      normalized_match_value: matchValue,
      match_amount_operator: matchAmountOperator = null,
      match_amount_minor: matchAmountMinor = null,
    },
  ) {
    const result = await client.query(
      `
        SELECT id
        FROM transactions
        WHERE workspace_id = $1
          AND transaction_cleanup_rule_matches(
            $2,
            $3,
            $4,
            normalized_merchant,
            normalized_name
          )
          AND transaction_cleanup_rule_amount_matches(
            $5,
            $6,
            amount_minor
          )
        ORDER BY id
      `,
      [
        workspaceId,
        matchField,
        matchMode,
        matchValue,
        matchAmountOperator,
        matchAmountMinor,
      ],
    );
    return result.rows.map((row) => row.id);
  }

  async #moveSpendingCategoryChildren(
    client,
    workspaceId,
    {
      sourceCategoryIds,
      parentCategoryId,
      userId = null,
    },
  ) {
    const roots = await client.query(
      `
        SELECT
          child.id,
          child.parent_category_id,
          spending_category_name_for_id(
            child.workspace_id,
            child.id
          ) AS path
        FROM spending_categories child
        WHERE child.workspace_id = $1
          AND child.parent_category_id = ANY($2::text[])
          AND child.merged_into_category_id IS NULL
          AND NOT child.id = ANY($2::text[])
        ORDER BY child.id
        FOR UPDATE
      `,
      [workspaceId, sourceCategoryIds],
    );
    if (!roots.rows.length) return [];

    const rootIds = roots.rows.map((row) => row.id);
    const descendantsBefore = await client.query(
      `
        SELECT DISTINCT
          descendant.category_id,
          spending_category_name_for_id(
            $1,
            descendant.category_id
          ) AS path
        FROM unnest($2::text[]) root(category_id)
        CROSS JOIN LATERAL spending_category_descendant_ids(
          $1,
          root.category_id
        ) descendant
        ORDER BY descendant.category_id
      `,
      [workspaceId, rootIds],
    );

    for (const entry of descendantsBefore.rows) {
      await client.query(
        `
          INSERT INTO spending_category_aliases (
            workspace_id,
            normalized_alias,
            alias,
            category_id,
            alias_type
          )
          VALUES (
            $1,
            normalize_spending_category_name($2),
            $2,
            $3,
            'former_name'
          )
          ON CONFLICT (workspace_id, normalized_alias) DO UPDATE SET
            alias_type = 'former_name'
          WHERE spending_category_aliases.category_id =
            EXCLUDED.category_id
        `,
        [workspaceId, entry.path, entry.category_id],
      );
    }

    await client.query(
      `
        UPDATE spending_categories
        SET parent_category_id = $3,
            version = version + 1,
            updated_by = $4,
            updated_at = now()
        WHERE workspace_id = $1
          AND id = ANY($2::text[])
      `,
      [workspaceId, rootIds, parentCategoryId, userId],
    );

    const movedCategoryIds = descendantsBefore.rows.map(
      (row) => row.category_id,
    );
    const descendantsAfter = await client.query(
      `
        SELECT
          category.id AS category_id,
          spending_category_name_for_id(
            category.workspace_id,
            category.id
          ) AS path
        FROM spending_categories category
        WHERE category.workspace_id = $1
          AND category.id = ANY($2::text[])
        ORDER BY category.id
      `,
      [workspaceId, movedCategoryIds],
    );

    for (const entry of descendantsAfter.rows) {
      const conflict = await client.query(
        `
          SELECT active_spending_category_id(
            workspace_id,
            category_id
          ) AS category_id
          FROM spending_category_aliases
          WHERE workspace_id = $1
            AND normalized_alias =
              normalize_spending_category_name($2)
        `,
        [workspaceId, entry.path],
      );
      if (
        conflict.rows[0] &&
        conflict.rows[0].category_id !== entry.category_id
      ) {
        const error = new Error("Category alias already exists");
        error.code = "CATEGORY_NAME_CONFLICT";
        throw error;
      }
      await client.query(
        `
          INSERT INTO spending_category_aliases (
            workspace_id,
            normalized_alias,
            alias,
            category_id,
            alias_type
          )
          VALUES (
            $1,
            normalize_spending_category_name($2),
            $2,
            $3,
            'name'
          )
          ON CONFLICT (workspace_id, normalized_alias) DO UPDATE SET
            alias = EXCLUDED.alias,
            alias_type = 'name'
          WHERE spending_category_aliases.category_id =
            EXCLUDED.category_id
        `,
        [workspaceId, entry.path, entry.category_id],
      );
    }

    for (const table of [
      "categorization_overrides",
      "transaction_cleanup_rules",
    ]) {
      await client.query(
        `
          UPDATE ${table}
          SET category_primary =
                spending_category_name_for_id(workspace_id, category_id),
              updated_at = now()
          WHERE workspace_id = $1
            AND category_id = ANY($2::text[])
        `,
        [workspaceId, movedCategoryIds],
      );
    }
    for (const table of [
      "transaction_splits",
      "budget_lines",
      "budget_default_revisions",
      "budget_category_versions",
    ]) {
      await client.query(
        `
          UPDATE ${table}
          SET category =
                spending_category_name_for_id(workspace_id, category_id),
              updated_at = now()
          WHERE workspace_id = $1
            AND category_id = ANY($2::text[])
        `,
        [workspaceId, movedCategoryIds],
      );
    }

    const pathsAfter = new Map(
      descendantsAfter.rows.map((row) => [row.category_id, row.path]),
    );
    for (const root of roots.rows) {
      await client.query(
        `
          INSERT INTO spending_category_events (
            id,
            workspace_id,
            category_id,
            event_type,
            actor_id,
            before_value,
            after_value
          )
          VALUES (
            $1,
            $2,
            $3,
            'rename',
            $4,
            jsonb_build_object(
              'path', $5::text,
              'parent_category_id', $6::text
            ),
            jsonb_build_object(
              'path', $7::text,
              'parent_category_id', $8::text,
              'moved_with_parent_merge', true
            )
          )
        `,
        [
          stableId("category-event", randomUUID()),
          workspaceId,
          root.id,
          userId,
          root.path,
          root.parent_category_id,
          pathsAfter.get(root.id),
          parentCategoryId,
        ],
      );
    }
    return movedCategoryIds;
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
            AND transaction_cleanup_rule_matches(
              rule.match_field,
              rule.match_mode,
              rule.normalized_match_value,
              t.normalized_merchant,
              t.normalized_name
            )
            AND transaction_cleanup_rule_amount_matches(
              rule.match_amount_operator,
              rule.match_amount_minor,
              t.amount_minor
            )
          ORDER BY
            (rule.match_mode = 'exact') DESC,
            (rule.match_amount_operator IS NOT NULL) DESC,
            (rule.match_field = 'normalized_merchant') DESC,
            length(rule.normalized_match_value) DESC,
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
    return this.#withTransaction(operation);
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
    return this.#withTransaction(async (client) => {
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

  async getUserAppearancePreference(userId) {
    if (typeof userId !== "string" || !userId.trim()) {
      throw new TypeError("userId is required");
    }
    const result = await this.#client().query(
      `
        SELECT appearance_preference
        FROM users
        WHERE id = $1
      `,
      [userId],
    );
    if (!result.rows[0]) {
      const error = new Error("The authenticated user does not exist.");
      error.code = "USER_NOT_FOUND";
      throw error;
    }
    const appearance = result.rows[0].appearance_preference;
    if (!APPEARANCE_PREFERENCES.has(appearance)) {
      throw new Error("The stored appearance preference is invalid.");
    }
    return appearance;
  }

  async updateUserAppearancePreference(userId, appearance) {
    if (typeof userId !== "string" || !userId.trim()) {
      throw new TypeError("userId is required");
    }
    if (!APPEARANCE_PREFERENCES.has(appearance)) {
      throw new TypeError(
        "appearance must be exactly system, light, or dark",
      );
    }
    const result = await this.#client().query(
      `
        UPDATE users
        SET appearance_preference = $2,
            updated_at = now()
        WHERE id = $1
        RETURNING appearance_preference
      `,
      [userId, appearance],
    );
    if (!result.rows[0]) {
      const error = new Error("The authenticated user does not exist.");
      error.code = "USER_NOT_FOUND";
      throw error;
    }
    return result.rows[0].appearance_preference;
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
    client = this.#client(),
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

  async getPlaidItem(itemId, client = this.#client()) {
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
    client = this.#client(),
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
    client = this.#client(),
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
    client = this.#client(),
  ) {
    const result = await client.query(
      `
        SELECT
          c.*,
          p.institution_id,
          p.coverage_warnings,
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
    client = this.#client(),
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
    client = this.#client(),
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
    return this.#withTransaction(async (client) => {
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
            cardholder_name, source_transaction_type, cash_flow_role
          )
          SELECT
            r.id, $2, $3, r.provider_transaction_id,
            r.provider_pending_transaction_id, r.merchant_name,
            r.normalized_merchant, r.name, r.normalized_name,
            r.category_primary, r.category_detailed, r.amount_minor,
            r.currency_code, r.authorized_on, r.posted_on, r.pending,
            r.excluded_from_spending, r.payment_channel,
            r.cardholder_name, r.source_transaction_type,
            COALESCE(
              r.cash_flow_role,
              CASE
                WHEN r.excluded_from_spending THEN 'transfer'
                ELSE 'spending'
              END
            )
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
            source_transaction_type text,
            cash_flow_role text
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
            cash_flow_role = EXCLUDED.cash_flow_role,
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
    return this.#withTransaction(async (client) => {
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
    client = this.#client(),
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
    if (lastSyncedAt != null) {
      await client.query(
        `
          UPDATE accounts
          SET last_synced_at = $2,
              updated_at = now()
          WHERE connection_id = $1
            AND active = true
        `,
        [itemId, lastSyncedAt],
      );
    }
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
    return this.#withTransaction(async (client) => {
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
    { syncedAt = null } = {},
    client = this.#client(),
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
          last_synced_at = COALESCE(
            EXCLUDED.last_synced_at,
            accounts.last_synced_at
          ),
          updated_at = now()
      `,
      [itemId, JSON.stringify(accounts), syncedAt],
    );
  }

  async deactivateMissingAccounts(
    itemId,
    activeProviderAccountIds,
    client = this.#client(),
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
    },
  ) {
    const changed = [...added, ...modified];
    const replacementIds = changed
      .map(
        (transaction) =>
          transaction.provider_pending_transaction_id ??
          transaction.providerPendingTransactionId,
      )
      .filter(Boolean);
    await this.#withTransaction(async (client) => {
      if (removedProviderIds.length) {
        await this.#snapshotUnmatchedPendingEdits(client, {
          providerIds: removedProviderIds,
          itemId,
          replacementProviderIds: replacementIds,
        });
        await client.query(
          `
            DELETE FROM transactions removed
            WHERE removed.provider_transaction_id = ANY($1::text[])
              AND NOT (
                removed.provider_transaction_id = ANY($3::text[])
              )
              AND removed.account_id IN (
                SELECT id FROM accounts WHERE connection_id = $2
              )
          `,
          [removedProviderIds, itemId, replacementIds],
        );
      }

      if (changed.length) {
        await client.query(
          `
            INSERT INTO transactions (
              id, workspace_id, account_id, provider_transaction_id,
              provider_pending_transaction_id, merchant_name, normalized_merchant,
              name, normalized_name, category_primary, category_detailed, amount_minor,
              currency_code, authorized_at, authorized_on, posted_at,
              posted_on, pending,
              excluded_from_spending, original_transaction_id,
              payment_channel, provider_location, cash_flow_role
            )
            SELECT
              r.id, a.workspace_id, a.id, r.provider_transaction_id,
              r.provider_pending_transaction_id, r.merchant_name,
              r.normalized_merchant, r.name, r.normalized_name, r.category_primary,
              r.category_detailed, r.amount_minor, r.currency_code,
              r.authorized_at, r.authorized_on, r.posted_at,
              r.posted_on, r.pending,
              r.excluded_from_spending, r.original_transaction_id,
              r.payment_channel, r.provider_location,
              COALESCE(
                r.cash_flow_role,
                CASE
                  WHEN r.excluded_from_spending THEN 'transfer'
                  ELSE 'spending'
                END
              )
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
              authorized_on date,
              posted_at timestamptz,
              posted_on date,
              pending boolean,
              excluded_from_spending boolean,
              original_transaction_id text,
              payment_channel text,
              provider_location jsonb,
              cash_flow_role text
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
              authorized_on = EXCLUDED.authorized_on,
              posted_at = EXCLUDED.posted_at,
              posted_on = EXCLUDED.posted_on,
              pending = EXCLUDED.pending,
              excluded_from_spending = EXCLUDED.excluded_from_spending,
              original_transaction_id = COALESCE(
                EXCLUDED.original_transaction_id,
                transactions.original_transaction_id
              ),
              payment_channel = EXCLUDED.payment_channel,
              provider_location = EXCLUDED.provider_location,
              cash_flow_role = EXCLUDED.cash_flow_role,
              updated_at = now()
          `,
          [JSON.stringify(changed), itemId],
        );

        if (replacementIds.length) {
          await this.#handoffPendingTransactionEdits(
            client,
            replacementIds,
          );
        }
      }

      await this.updatePlaidItemState(
        itemId,
        {
          cursor,
        },
        client,
      );
    });
  }

  async replaceInvestments(
    itemId,
    {
      securities = [],
      holdings,
      transactions = [],
      asOf = new Date(),
    },
  ) {
    await this.#withTransaction(async (client) => {
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

      if (holdings !== undefined) {
        await client.query(
          "DELETE FROM holdings WHERE account_id IN (SELECT id FROM accounts WHERE connection_id = $1)",
          [itemId],
        );
      }
      if (holdings?.length) {
        const inserted = await client.query(
          `
            INSERT INTO holdings (
              id, workspace_id, account_id, security_id, quantity,
              vested_quantity, institution_value_minor, vested_value_minor,
              institution_price_minor, cost_basis_minor, currency_code, as_of
            )
            SELECT
              r.id, a.workspace_id, a.id, s.id, r.quantity,
              r.vested_quantity, r.institution_value_minor,
              r.vested_value_minor, r.institution_price_minor,
              r.cost_basis_minor, r.currency_code, $2
            FROM jsonb_to_recordset($1::jsonb) AS r(
              id text,
              provider_account_id text,
              provider_security_id text,
              quantity numeric,
              vested_quantity numeric,
              institution_value_minor bigint,
              vested_value_minor bigint,
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
        if (inserted.rowCount !== holdings.length) {
          throw investmentPersistenceMismatch(
            "holdings",
            holdings.length,
            inserted.rowCount,
          );
        }
      }

      if (transactions.length) {
        const inserted = await client.query(
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
        if (inserted.rowCount !== transactions.length) {
          throw investmentPersistenceMismatch(
            "transactions",
            transactions.length,
            inserted.rowCount,
          );
        }
      }
    });
  }

  async replaceLiabilities(itemId, liabilities, { asOf = new Date() } = {}) {
    await this.#withTransaction(async (client) => {
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
    await this.#withTransaction(async (client) => {
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
            value_minor, quantity, institution_price_minor,
            vested_quantity, vested_value_minor, currency_code
          )
          SELECT
            h.workspace_id, h.account_id, h.security_id, $2,
            h.institution_value_minor, h.quantity,
            h.institution_price_minor, h.vested_quantity,
            h.vested_value_minor, h.currency_code
          FROM holdings h
          JOIN accounts a ON a.id = h.account_id
          JOIN finance_connections i ON i.id = a.connection_id
          WHERE h.workspace_id = $1
            AND a.active = true
            AND i.status <> 'removed'
          ON CONFLICT (account_id, security_id, snapshot_on) DO UPDATE SET
            value_minor = EXCLUDED.value_minor,
            quantity = EXCLUDED.quantity,
            institution_price_minor = EXCLUDED.institution_price_minor,
            vested_quantity = EXCLUDED.vested_quantity,
            vested_value_minor = EXCLUDED.vested_value_minor
        `,
        [workspaceId, snapshotOn],
      );
    });
  }

  async listAccounts(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { includeInactive = false } = {},
    client = this.#client(),
  ) {
    const result = await client.query(
      `
        SELECT
          a.*,
          p.institution_id,
          i.provider,
          i.ingestion_method,
          i.imported_through_on,
          i.balance_as_of,
          i.status AS connection_status,
          i.error_code AS connection_error_code,
          p.coverage_warnings AS connection_coverage_warnings
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
    return this.#withTransaction(async (client) => {
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

    return this.#withTransaction(async (client) => {
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
    const result = await this.#client().query(
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
    const result = await this.#client().query(
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

    return this.#withTransaction(async (client) => {
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
    const result = await this.#client().query(
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
    const result = await this.#client().query(
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
    const result = await this.#client().query(
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
    const result = await this.#client().query(
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
    const result = await this.#client().query(
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
    const result = await this.#client().query(
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
    const result = await this.#client().query(
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
    const result = await this.#client().query(
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
    return this.#withTransaction(async (client) => {
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
    return this.#withTransaction(async (client) => {
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
    const result = await this.#client().query(
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

  async listTransactionSplits(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      transactionIds = null,
      startOn = null,
      endOn = null,
      dateMode = "posted",
    } = {},
  ) {
    const useBudgetMonth = dateMode === "budget";
    const result = await this.#client().query(
      `
        SELECT
          split.*,
          active_spending_category_id(
            split.workspace_id,
            split.category_id
          ) AS resolved_category_id,
          spending_category_name_for_id(
            split.workspace_id,
            split.category_id
          ) AS resolved_category,
          category.classification = 'fixed' AS is_fixed,
          transaction.split_version
        FROM transaction_splits split
        JOIN transactions transaction
          ON transaction.workspace_id = split.workspace_id
         AND transaction.id = split.transaction_id
        LEFT JOIN transaction_metadata metadata
          ON metadata.workspace_id = transaction.workspace_id
         AND metadata.transaction_id = transaction.id
        JOIN spending_categories category
          ON category.workspace_id = split.workspace_id
         AND category.id = active_spending_category_id(
           split.workspace_id,
           split.category_id
         )
        WHERE split.workspace_id = $1
          AND ($2::text[] IS NULL OR split.transaction_id = ANY($2))
          AND (
            $3::date IS NULL
            OR (
              CASE
                WHEN $5::boolean
                  THEN COALESCE(
                    metadata.budget_month_on,
                    date_trunc('month', transaction.posted_on)::date
                  )
                ELSE transaction.posted_on
              END
            ) >= $3
          )
          AND (
            $4::date IS NULL
            OR (
              CASE
                WHEN $5::boolean
                  THEN COALESCE(
                    metadata.budget_month_on,
                    date_trunc('month', transaction.posted_on)::date
                  )
                ELSE transaction.posted_on
              END
            ) < $4
          )
        ORDER BY split.transaction_id, split.line_index
      `,
      [
        workspaceId,
        transactionIds,
        startOn,
        endOn,
        useBudgetMonth,
      ],
    );
    return result.rows.map(mapTransactionSplit);
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
      currencyCode = null,
      sort = "date",
      limit = 50,
      cursor = null,
      activeAccountsOnly = false,
      merchant = null,
      dateMode = "posted",
    } = {},
  ) {
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const normalizedSort = transactionSort(sort);
    const useBudgetMonth = dateMode === "budget";
    const decoded = decodeCursor(cursor, normalizedSort);
    const sortConfig = {
      date: {
        cursor: `
          ($8::text IS NULL OR
            (posted_on, id) < ($9::date, $10::text))
        `,
        order: "posted_on DESC, id DESC",
      },
      merchant: {
        cursor: `
          ($8::text IS NULL
            OR transaction_sort_merchant > $8
            OR (
              transaction_sort_merchant = $8
              AND (posted_on, id) < ($9::date, $10::text)
            ))
        `,
        order:
          "transaction_sort_merchant ASC, posted_on DESC, id DESC",
      },
      category: {
        cursor: `
          ($8::text IS NULL
            OR transaction_sort_category > $8
            OR (
              transaction_sort_category = $8
              AND (posted_on, id) < ($9::date, $10::text)
            ))
        `,
        order:
          "transaction_sort_category ASC, posted_on DESC, id DESC",
      },
      cost: {
        cursor: `
          ($8::text IS NULL
            OR transaction_sort_cost < $8::bigint
            OR (
              transaction_sort_cost = $8::bigint
              AND (posted_on, id) < ($9::date, $10::text)
            ))
        `,
        order:
          "transaction_sort_cost DESC, posted_on DESC, id DESC",
      },
    }[normalizedSort];
    const result = await this.#client().query(
      `
        WITH transaction_page AS (
        SELECT
          t.*,
          a.name AS account_name,
          a.mask AS account_mask,
          a.institution_name,
          CASE
            WHEN metadata.display_name_overridden
              THEN metadata.display_name
            ELSE COALESCE(
              metadata.display_name,
              cleanup_rule.display_name
            )
          END AS display_name,
          metadata.note,
          metadata.note_version,
          metadata.note_updated_by,
          metadata.note_updated_at,
          metadata.budget_month_on,
          lower(
            COALESCE(
              CASE
                WHEN metadata.display_name_overridden
                  THEN metadata.display_name
                ELSE COALESCE(
                  metadata.display_name,
                  cleanup_rule.display_name
                )
              END,
              t.merchant_name,
              t.name,
              ''
            )
          ) AS transaction_sort_merchant,
          effective_tags.tags,
          effective_category.category_id,
          COALESCE(
            effective_category.category_name,
            effective_category.source_category_label
          ) AS effective_category_primary,
          lower(
            COALESCE(
              category_split.category,
              effective_category.category_name,
              effective_category.source_category_label,
              t.category_primary,
              ''
            )
          ) AS transaction_sort_category,
          CASE
            WHEN COALESCE(
              category_split.amount_minor,
              t.amount_minor
            ) < 0
              THEN abs(
                COALESCE(
                  category_split.amount_minor,
                  t.amount_minor
                )
              )
            ELSE -1
          END AS transaction_sort_cost,
          category_split.category AS split_category,
          category_split.category_id AS split_category_id,
          category_split.amount_minor AS split_category_amount_minor,
          category_split.line_count AS split_category_line_count,
          COALESCE(
            transaction_override.category_detailed,
            merchant_override.category_detailed,
            original_override.category_detailed,
            original_merchant_override.category_detailed,
            original_transaction.category_detailed,
            t.category_detailed
          ) AS effective_category_detailed,
          effective_treatment.effective_excluded_from_spending,
          effective_treatment.effective_cash_flow_role,
          COALESCE(
            split_category_definition.classification,
            effective_category_definition.classification
          ) = 'fixed' AS is_fixed
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        JOIN finance_connections i ON i.id = a.connection_id
        LEFT JOIN transaction_effective_spending_categories
          effective_category
          ON effective_category.workspace_id = t.workspace_id
         AND effective_category.transaction_id = t.id
        LEFT JOIN transaction_effective_spending_treatments
          effective_treatment
          ON effective_treatment.workspace_id = t.workspace_id
         AND effective_treatment.transaction_id = t.id
        LEFT JOIN spending_categories effective_category_definition
          ON effective_category_definition.workspace_id = t.workspace_id
         AND effective_category_definition.id =
           effective_category.category_id
        LEFT JOIN transaction_metadata metadata
          ON metadata.workspace_id = t.workspace_id
         AND metadata.transaction_id = t.id
        LEFT JOIN LATERAL (
          SELECT rule.*
          FROM transaction_cleanup_rules rule
          WHERE rule.workspace_id = t.workspace_id
            AND rule.enabled = true
            AND transaction_cleanup_rule_matches(
              rule.match_field,
              rule.match_mode,
              rule.normalized_match_value,
              t.normalized_merchant,
              t.normalized_name
            )
            AND transaction_cleanup_rule_amount_matches(
              rule.match_amount_operator,
              rule.match_amount_minor,
              t.amount_minor
            )
          ORDER BY
            (rule.match_mode = 'exact') DESC,
            (rule.match_amount_operator IS NOT NULL) DESC,
            (rule.match_field = 'normalized_merchant') DESC,
            length(rule.normalized_match_value) DESC,
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
            AND transaction_cleanup_rule_matches(
              rule.match_field,
              rule.match_mode,
              rule.normalized_match_value,
              original_transaction.normalized_merchant,
              original_transaction.normalized_name
            )
            AND transaction_cleanup_rule_amount_matches(
              rule.match_amount_operator,
              rule.match_amount_minor,
              original_transaction.amount_minor
            )
          ORDER BY
            (rule.match_mode = 'exact') DESC,
            (rule.match_amount_operator IS NOT NULL) DESC,
            (rule.match_field = 'normalized_merchant') DESC,
            length(rule.normalized_match_value) DESC,
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
        LEFT JOIN LATERAL (
          SELECT
            spending_category_name_for_id(
              split_filter.workspace_id,
              split_filter.category_id
            ) AS category,
            active_spending_category_id(
              split_filter.workspace_id,
              split_filter.category_id
            ) AS category_id,
            SUM(split_filter.amount_minor)::bigint AS amount_minor,
            COUNT(*)::integer AS line_count
          FROM transaction_splits split_filter
          WHERE split_filter.workspace_id = t.workspace_id
            AND split_filter.transaction_id = t.id
            AND active_spending_category_id(
              split_filter.workspace_id,
              split_filter.category_id
            ) IN (
              SELECT category_id
              FROM spending_category_descendant_ids(
                t.workspace_id,
                COALESCE(
                  active_spending_category_id(t.workspace_id, $5),
                  spending_category_id_for_label(t.workspace_id, $5)
                )
              )
            )
          GROUP BY 1, 2
        ) category_split ON true
        LEFT JOIN spending_categories split_category_definition
          ON split_category_definition.workspace_id = t.workspace_id
         AND split_category_definition.id = category_split.category_id
        WHERE t.workspace_id = $1
          AND (
            $2::date IS NULL
            OR (
              CASE
                WHEN $17::boolean
                  THEN COALESCE(
                    metadata.budget_month_on,
                    date_trunc('month', t.posted_on)::date
                  )
                ELSE t.posted_on
              END
            ) >= $2
          )
          AND (
            $3::date IS NULL
            OR (
              CASE
                WHEN $17::boolean
                  THEN COALESCE(
                    metadata.budget_month_on,
                    date_trunc('month', t.posted_on)::date
                  )
                ELSE t.posted_on
              END
            ) < $3
          )
          AND ($4::text IS NULL OR t.account_id = $4)
          AND (
            $5::text IS NULL
            OR (
              effective_category.category_id IN (
                SELECT category_id
                FROM spending_category_descendant_ids(
                  t.workspace_id,
                  COALESCE(
                    active_spending_category_id(t.workspace_id, $5),
                    spending_category_id_for_label(t.workspace_id, $5)
                  )
                )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM transaction_splits split_override
                WHERE split_override.workspace_id = t.workspace_id
                  AND split_override.transaction_id = t.id
              )
            )
            OR category_split.category IS NOT NULL
          )
          AND ($6::boolean OR t.pending = false)
          AND (
            $12::text = 'all'
            OR ($12 = 'pending' AND t.pending = true)
            OR ($12 = 'posted' AND t.pending = false)
          )
          AND (
            $13::bigint IS NULL
            OR abs(
              COALESCE(category_split.amount_minor, t.amount_minor)
            ) >= $13
          )
          AND (
            $14::bigint IS NULL
            OR abs(
              COALESCE(category_split.amount_minor, t.amount_minor)
              ) <= $14
          )
          AND ($18::text IS NULL OR t.currency_code = $18)
          AND (
            $15::boolean = false
            OR (a.active = true AND i.status <> 'removed')
          )
          AND (
            $7::text IS NULL
            OR concat_ws(
                 ' ',
                 CASE
                   WHEN metadata.display_name_overridden
                     THEN metadata.display_name
                   ELSE COALESCE(
                     metadata.display_name,
                     cleanup_rule.display_name
                   )
                 END,
                 metadata.note,
                 t.merchant_name,
                 t.name,
                 effective_tags.tag_names,
                 effective_category.category_name,
                 effective_category.source_category_label
                 )
               ILIKE '%' || $7 || '%'
            OR EXISTS (
              SELECT 1
              FROM transaction_splits split_search
              WHERE split_search.workspace_id = t.workspace_id
                AND split_search.transaction_id = t.id
                AND concat_ws(
                  ' ',
                  spending_category_name_for_id(
                    split_search.workspace_id,
                    split_search.category_id
                  ),
                  split_search.category
                ) ILIKE '%' || $7 || '%'
                AND (
                  $5::text IS NULL
                  OR active_spending_category_id(
                    split_search.workspace_id,
                    split_search.category_id
                  ) IN (
                    SELECT category_id
                    FROM spending_category_descendant_ids(
                      split_search.workspace_id,
                      COALESCE(
                        active_spending_category_id(
                          split_search.workspace_id,
                          $5
                        ),
                        spending_category_id_for_label(
                          split_search.workspace_id,
                          $5
                        )
                      )
                    )
                  )
                )
            )
          )
          AND (
            $16::text IS NULL
            OR COALESCE(
              CASE
                WHEN metadata.display_name_overridden
                  THEN metadata.display_name
                ELSE COALESCE(
                  metadata.display_name,
                  cleanup_rule.display_name
                )
              END,
              t.merchant_name,
              t.name
            ) = $16
          )
        )
        SELECT *
        FROM transaction_page
        WHERE ${sortConfig.cursor}
        ORDER BY ${sortConfig.order}
        LIMIT $11
      `,
      [
        workspaceId,
        startOn,
        endOn,
        accountId,
        category,
        includePending,
        search?.trim() || null,
        decoded?.key ?? null,
        decoded?.posted_on ?? null,
        decoded?.id ?? null,
        boundedLimit + 1,
        status,
        minAmountMinor,
        maxAmountMinor,
        activeAccountsOnly,
        merchant,
        useBudgetMonth,
        currencyCode,
      ],
    );
    const hasMore = result.rows.length > boundedLimit;
    const rows = result.rows.slice(0, boundedLimit);
    return {
      transactions: rows.map(mapTransaction),
      pageInfo: {
        has_more: hasMore,
        next_cursor: hasMore
          ? encodeCursor(rows.at(-1), normalizedSort)
          : null,
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
      merchant = null,
      dateMode = "posted",
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
      merchant,
      dateMode,
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
        merchant,
        dateMode,
        limit: 100,
        cursor,
      });
      all.push(...page.transactions);
      cursor = page.pageInfo.next_cursor;
    }
    return all.filter((transaction) => !transaction.split_needs_review);
  }

  async getTransaction(
    workspaceId = DEFAULT_WORKSPACE_ID,
    transactionId,
    { includeProviderLocation = false } = {},
  ) {
    const result = await this.#client().query(
      `
        SELECT
          t.*,
          a.name AS account_name,
          a.mask AS account_mask,
          a.institution_name,
          CASE
            WHEN metadata.display_name_overridden
              THEN metadata.display_name
            ELSE COALESCE(
              metadata.display_name,
              cleanup_rule.display_name
            )
          END AS display_name,
          metadata.note,
          metadata.note_version,
          metadata.note_updated_by,
          metadata.note_updated_at,
          metadata.budget_month_on,
          CASE
            WHEN metadata.tags_overridden
              THEN COALESCE(tag_data.tags, '[]'::jsonb)
            WHEN cleanup_rule.tags IS NOT NULL
              THEN cleanup_rule.tags
            ELSE COALESCE(tag_data.tags, '[]'::jsonb)
          END AS tags,
          effective_category.category_id,
          COALESCE(
            effective_category.category_name,
            effective_category.source_category_label
          ) AS effective_category_primary,
          COALESCE(
            transaction_override.category_detailed,
            merchant_override.category_detailed,
            original_transaction_override.category_detailed,
            original_merchant_override.category_detailed,
            original_transaction.category_detailed,
            t.category_detailed
          )
            AS effective_category_detailed,
          effective_treatment.effective_excluded_from_spending,
          effective_treatment.effective_cash_flow_role,
          effective_category_definition.classification = 'fixed'
            AS is_fixed
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        LEFT JOIN transaction_effective_spending_categories
          effective_category
          ON effective_category.workspace_id = t.workspace_id
         AND effective_category.transaction_id = t.id
        LEFT JOIN transaction_effective_spending_treatments
          effective_treatment
          ON effective_treatment.workspace_id = t.workspace_id
         AND effective_treatment.transaction_id = t.id
        LEFT JOIN spending_categories effective_category_definition
          ON effective_category_definition.workspace_id = t.workspace_id
         AND effective_category_definition.id =
           effective_category.category_id
        LEFT JOIN transaction_metadata metadata
          ON metadata.workspace_id = t.workspace_id
         AND metadata.transaction_id = t.id
        LEFT JOIN LATERAL (
          SELECT rule.*
          FROM transaction_cleanup_rules rule
          WHERE rule.workspace_id = t.workspace_id
            AND rule.enabled = true
            AND transaction_cleanup_rule_matches(
              rule.match_field,
              rule.match_mode,
              rule.normalized_match_value,
              t.normalized_merchant,
              t.normalized_name
            )
            AND transaction_cleanup_rule_amount_matches(
              rule.match_amount_operator,
              rule.match_amount_minor,
              t.amount_minor
            )
          ORDER BY
            (rule.match_mode = 'exact') DESC,
            (rule.match_amount_operator IS NOT NULL) DESC,
            (rule.match_field = 'normalized_merchant') DESC,
            length(rule.normalized_match_value) DESC,
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
            AND transaction_cleanup_rule_matches(
              rule.match_field,
              rule.match_mode,
              rule.normalized_match_value,
              original_transaction.normalized_merchant,
              original_transaction.normalized_name
            )
            AND transaction_cleanup_rule_amount_matches(
              rule.match_amount_operator,
              rule.match_amount_minor,
              original_transaction.amount_minor
            )
          ORDER BY
            (rule.match_mode = 'exact') DESC,
            (rule.match_amount_operator IS NOT NULL) DESC,
            (rule.match_field = 'normalized_merchant') DESC,
            length(rule.normalized_match_value) DESC,
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
    return result.rows[0]
      ? mapTransaction(result.rows[0], { includeProviderLocation })
      : null;
  }

  async getTransactionsByIds(
    workspaceId = DEFAULT_WORKSPACE_ID,
    transactionIds = [],
  ) {
    const ids = [...new Set(transactionIds)].slice(0, 200);
    const transactions = await Promise.all(
      ids.map((id) => this.getTransaction(workspaceId, id)),
    );
    return transactions.filter(Boolean);
  }

  async listTransactionCleanupRules(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { includeDisabled = true, limit = 200 } = {},
  ) {
    const result = await this.#client().query(
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
              AND transaction_cleanup_rule_matches(
                rule.match_field,
                rule.match_mode,
                rule.normalized_match_value,
                t.normalized_merchant,
                t.normalized_name
              )
              AND transaction_cleanup_rule_amount_matches(
                rule.match_amount_operator,
                rule.match_amount_minor,
                t.amount_minor
              )
            ORDER BY
            (rule.match_mode = 'exact') DESC,
            (rule.match_amount_operator IS NOT NULL) DESC,
            (rule.match_field = 'normalized_merchant') DESC,
              length(rule.normalized_match_value) DESC,
              rule.updated_at DESC,
              rule.id
            LIMIT 1
          ) winner ON true
          WHERE t.workspace_id = $1
            AND t.pending = false
        )
        SELECT
          rule.*,
          spending_category_name_for_id(
            rule.workspace_id,
            rule.category_id
          ) AS resolved_category,
          active_spending_category_id(
            rule.workspace_id,
            rule.category_id
          ) AS resolved_category_id,
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
      matchMode = "exact",
      matchValue,
      normalizedMatchValue,
      matchAmountOperator = null,
      matchAmountMinor = null,
      displayName = null,
      categoryPrimary = null,
      cashFlowRole = null,
      tags = null,
      enabled = true,
      userId = null,
    },
  ) {
    return this.#withTransaction(async (client) => {
      const result = await client.query(
        `
          INSERT INTO transaction_cleanup_rules (
            id, workspace_id, match_field, match_mode,
            match_value, normalized_match_value,
            match_amount_operator, match_amount_minor, display_name,
            category_primary, cash_flow_role, tags, enabled,
            created_by, updated_by
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12::jsonb, $13, $14, $14
          )
          RETURNING *
        `,
        [
          id,
          workspaceId,
          matchField,
          matchMode,
          matchValue,
          normalizedMatchValue,
          matchAmountOperator,
          matchAmountMinor,
          displayName,
          categoryPrimary,
          cashFlowRole,
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
      matchMode = "exact",
      matchValue,
      normalizedMatchValue,
      matchAmountOperator = null,
      matchAmountMinor = null,
      displayName = null,
      categoryPrimary = null,
      cashFlowRole = null,
      tags = null,
      enabled,
      userId = null,
    },
  ) {
    return this.#withTransaction(async (client) => {
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
              match_mode = $4,
              match_value = $5,
              normalized_match_value = $6,
              match_amount_operator = $7,
              match_amount_minor = $8,
              display_name = $9,
              category_primary = $10,
              cash_flow_role = $11,
              tags = $12::jsonb,
              enabled = COALESCE($13::boolean, enabled),
              updated_by = $14,
              updated_at = now()
          WHERE workspace_id = $1 AND id = $2
          RETURNING *
        `,
        [
          workspaceId,
          ruleId,
          matchField,
          matchMode,
          matchValue,
          normalizedMatchValue,
          matchAmountOperator,
          matchAmountMinor,
          displayName,
          categoryPrimary,
          cashFlowRole,
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
    return this.#withTransaction(async (client) => {
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

  async rerunTransactionCleanupRules(
    workspaceId = DEFAULT_WORKSPACE_ID,
  ) {
    return this.#withTransaction(async (client) => {
      const transactions = await client.query(
        `
          SELECT id
          FROM transactions
          WHERE workspace_id = $1
            AND pending = false
          ORDER BY id
        `,
        [workspaceId],
      );
      const rules = await client.query(
        `
          SELECT count(*)::integer AS count
          FROM transaction_cleanup_rules
          WHERE workspace_id = $1
            AND enabled = true
        `,
        [workspaceId],
      );
      await this.#refreshTransactionSearchDocuments(
        client,
        workspaceId,
        transactions.rows.map((row) => row.id),
      );
      return {
        transaction_count: transactions.rows.length,
        rule_count: Number(rules.rows[0]?.count ?? 0),
      };
    });
  }

  async listTransactionTags(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { limit = 200 } = {},
  ) {
    const result = await this.#client().query(
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

  async autoTagIncomeBonuses(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { asOf = new Date().toISOString().slice(0, 10) } = {},
  ) {
    return this.#withTransaction(async (client) => {
      const bonusTagId = stableId("transaction-tag", `${workspaceId}:bonus`);
      await client.query(
        `
          INSERT INTO transaction_tags (
            id, workspace_id, name, normalized_name
          )
          VALUES ($1, $2, 'Bonus', 'bonus')
          ON CONFLICT (workspace_id, normalized_name)
          DO UPDATE SET name = EXCLUDED.name, updated_at = now()
        `,
        [bonusTagId, workspaceId],
      );
      const result = await client.query(
        `
          WITH income_candidates AS (
            SELECT
              t.id,
              t.account_id,
              t.currency_code,
              t.amount_minor,
              COALESCE(
                NULLIF(
                  btrim(regexp_replace(
                    lower(COALESCE(
                      CASE
                        WHEN metadata.display_name_overridden
                          THEN metadata.display_name
                        ELSE COALESCE(
                          metadata.display_name,
                          cleanup_rule.display_name
                        )
                      END,
                      ''
                    )),
                    '[^a-z0-9]+',
                    ' ',
                    'g'
                  )),
                  ''
                ),
                t.normalized_merchant,
                t.normalized_name
              ) AS income_identity
            FROM transactions t
            LEFT JOIN transaction_metadata metadata
              ON metadata.workspace_id = t.workspace_id
             AND metadata.transaction_id = t.id
            LEFT JOIN LATERAL (
              SELECT rule.*
              FROM transaction_cleanup_rules rule
              WHERE rule.workspace_id = t.workspace_id
                AND rule.enabled = true
                AND transaction_cleanup_rule_matches(
                  rule.match_field,
                  rule.match_mode,
                  rule.normalized_match_value,
                  t.normalized_merchant,
                  t.normalized_name
                )
                AND transaction_cleanup_rule_amount_matches(
                  rule.match_amount_operator,
                  rule.match_amount_minor,
                  t.amount_minor
                )
              ORDER BY
            (rule.match_mode = 'exact') DESC,
            (rule.match_amount_operator IS NOT NULL) DESC,
            (rule.match_field = 'normalized_merchant') DESC,
                length(rule.normalized_match_value) DESC,
                rule.updated_at DESC,
                rule.id
              LIMIT 1
            ) cleanup_rule ON true
            WHERE t.workspace_id = $1
              AND t.pending = false
              AND t.amount_minor > 0
              AND t.posted_on >= $2::date - 90
              AND t.posted_on <= $2::date
              AND concat_ws(
                ' ',
                metadata.display_name,
                cleanup_rule.display_name,
                t.merchant_name,
                t.name
              ) ~* '\\m(paycheck|payroll)\\M'
          ),
          peer_averages AS (
            SELECT
              candidate.id,
              avg(peer.amount_minor)::numeric AS peer_average_minor,
              count(*)::integer AS peer_count
            FROM income_candidates candidate
            JOIN income_candidates peer
              ON peer.id <> candidate.id
             AND peer.account_id = candidate.account_id
             AND peer.currency_code = candidate.currency_code
             AND peer.income_identity = candidate.income_identity
            WHERE NOT EXISTS (
              SELECT 1
              FROM transaction_tag_assignments assignment
              JOIN transaction_tags tag
                ON tag.workspace_id = assignment.workspace_id
               AND tag.id = assignment.tag_id
              WHERE assignment.workspace_id = $1
                AND assignment.transaction_id = peer.id
                AND tag.normalized_name = 'bonus'
            )
            GROUP BY candidate.id
            HAVING count(*) >= 2
          ),
          inferred_bonus AS (
            SELECT candidate.id
            FROM income_candidates candidate
            JOIN peer_averages peers ON peers.id = candidate.id
            WHERE candidate.amount_minor >=
              ceil(peers.peer_average_minor * 1.5)
              AND NOT EXISTS (
                SELECT 1
                FROM transaction_tag_assignments assignment
                JOIN transaction_tags tag
                  ON tag.workspace_id = assignment.workspace_id
                 AND tag.id = assignment.tag_id
                WHERE assignment.workspace_id = $1
                  AND assignment.transaction_id = candidate.id
                  AND tag.normalized_name = 'bonus'
              )
          )
          INSERT INTO transaction_tag_assignments (
            workspace_id, transaction_id, tag_id
          )
          SELECT $1, inferred_bonus.id, tag.id
          FROM inferred_bonus
          JOIN transaction_tags tag
            ON tag.workspace_id = $1
           AND tag.normalized_name = 'bonus'
          ON CONFLICT DO NOTHING
          RETURNING transaction_id
        `,
        [workspaceId, asOf],
      );
      return result.rows.map((row) => row.transaction_id);
    });
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
    const result = await this.#client().query(
      `
        WITH candidates AS (
          SELECT
            t.*,
            a.name AS account_name,
            a.mask AS account_mask,
            a.institution_name,
            CASE
              WHEN metadata.display_name_overridden
                THEN metadata.display_name
              ELSE COALESCE(
                metadata.display_name,
                cleanup_rule.display_name
              )
            END AS display_name,
            CASE
              WHEN metadata.tags_overridden
                THEN COALESCE(tag_data.tags, '[]'::jsonb)
              WHEN cleanup_rule.tags IS NOT NULL
                THEN cleanup_rule.tags
              ELSE COALESCE(tag_data.tags, '[]'::jsonb)
            END AS tags,
            effective_category.category_id,
            COALESCE(
              effective_category.category_name,
              effective_category.source_category_label
            ) AS effective_category_primary,
            COALESCE(
              transaction_override.category_detailed,
              merchant_override.category_detailed,
              original_transaction_override.category_detailed,
              original_merchant_override.category_detailed,
              original_transaction.category_detailed,
              t.category_detailed
            ) AS effective_category_detailed,
            effective_treatment.effective_excluded_from_spending,
            effective_treatment.effective_cash_flow_role,
            effective_category_definition.classification = 'fixed'
              AS is_fixed,
            GREATEST(
              similarity(COALESCE(t.normalized_merchant, ''), $3),
              similarity(COALESCE(t.normalized_name, ''), $3),
              similarity(
                lower(regexp_replace(
                  COALESCE(
                    CASE
                      WHEN metadata.display_name_overridden
                        THEN metadata.display_name
                      ELSE COALESCE(
                        metadata.display_name,
                        cleanup_rule.display_name
                      )
                    END,
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
          LEFT JOIN transaction_effective_spending_categories
            effective_category
            ON effective_category.workspace_id = t.workspace_id
           AND effective_category.transaction_id = t.id
          LEFT JOIN transaction_effective_spending_treatments
            effective_treatment
            ON effective_treatment.workspace_id = t.workspace_id
           AND effective_treatment.transaction_id = t.id
          LEFT JOIN spending_categories effective_category_definition
            ON effective_category_definition.workspace_id = t.workspace_id
           AND effective_category_definition.id =
             effective_category.category_id
          LEFT JOIN transaction_metadata metadata
            ON metadata.workspace_id = t.workspace_id
           AND metadata.transaction_id = t.id
          LEFT JOIN LATERAL (
            SELECT rule.*
            FROM transaction_cleanup_rules rule
            WHERE rule.workspace_id = t.workspace_id
              AND rule.enabled = true
              AND transaction_cleanup_rule_matches(
                rule.match_field,
                rule.match_mode,
                rule.normalized_match_value,
                t.normalized_merchant,
                t.normalized_name
              )
              AND transaction_cleanup_rule_amount_matches(
                rule.match_amount_operator,
                rule.match_amount_minor,
                t.amount_minor
              )
            ORDER BY
            (rule.match_mode = 'exact') DESC,
            (rule.match_amount_operator IS NOT NULL) DESC,
            (rule.match_field = 'normalized_merchant') DESC,
              length(rule.normalized_match_value) DESC,
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
              AND transaction_cleanup_rule_matches(
                rule.match_field,
                rule.match_mode,
                rule.normalized_match_value,
                original_transaction.normalized_merchant,
                original_transaction.normalized_name
              )
              AND transaction_cleanup_rule_amount_matches(
                rule.match_amount_operator,
                rule.match_amount_minor,
                original_transaction.amount_minor
              )
            ORDER BY
            (rule.match_mode = 'exact') DESC,
            (rule.match_amount_operator IS NOT NULL) DESC,
            (rule.match_field = 'normalized_merchant') DESC,
              length(rule.normalized_match_value) DESC,
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

  async listPendingEditRecoveries(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { includeResolved = false, limit = 100 } = {},
  ) {
    const result = await this.#client().query(
      `
        SELECT
          recovery.*,
          account.name AS account_name,
          account.mask AS account_mask,
          account.institution_name
        FROM unmatched_pending_transaction_edits recovery
        JOIN accounts account
          ON account.id = recovery.account_id
        WHERE recovery.workspace_id = $1
          AND (
            $2::boolean
            OR (
              recovery.attached_at IS NULL
              AND recovery.dismissed_at IS NULL
            )
          )
        ORDER BY recovery.recovered_at DESC, recovery.id
        LIMIT $3
      `,
      [
        workspaceId,
        includeResolved,
        Math.max(1, Math.min(200, Number(limit) || 100)),
      ],
    );
    return result.rows.map(mapPendingEditRecovery);
  }

  async dismissPendingEditRecovery(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { recoveryId, userId = null },
  ) {
    const result = await this.#client().query(
      `
        UPDATE unmatched_pending_transaction_edits
        SET dismissed_at = now(),
            dismissed_by = $3,
            updated_at = now()
        WHERE workspace_id = $1
          AND id = $2
          AND attached_at IS NULL
          AND dismissed_at IS NULL
        RETURNING *
      `,
      [workspaceId, recoveryId, userId],
    );
    if (result.rows[0]) {
      return mapPendingEditRecovery(result.rows[0]);
    }
    const existing = await this.#client().query(
      `
        SELECT *
        FROM unmatched_pending_transaction_edits
        WHERE workspace_id = $1
          AND id = $2
          AND dismissed_at IS NOT NULL
          AND attached_at IS NULL
      `,
      [workspaceId, recoveryId],
    );
    return existing.rows[0]
      ? mapPendingEditRecovery(existing.rows[0])
      : null;
  }

  async attachPendingEditRecovery(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { recoveryId, transactionId, userId = null },
  ) {
    return this.#withTransaction(async (client) => {
      const recoveryResult = await client.query(
        `
          SELECT *
          FROM unmatched_pending_transaction_edits
          WHERE workspace_id = $1
            AND id = $2
          FOR UPDATE
        `,
        [workspaceId, recoveryId],
      );
      const recovery = recoveryResult.rows[0];
      if (!recovery) return null;
      if (recovery.dismissed_at != null) return null;
      if (recovery.attached_at != null) {
        return recovery.attached_transaction_id === transactionId
          ? mapPendingEditRecovery(recovery)
          : null;
      }

      const targetResult = await client.query(
        `
          SELECT
            target.*,
            metadata.display_name_overridden,
            metadata.display_name_updated_at,
            metadata.tags_overridden,
            metadata.tags_updated_at,
            metadata.note_version AS metadata_note_version,
            metadata.note_updated_at AS metadata_note_updated_at,
            metadata.budget_month_overridden,
            metadata.budget_month_updated_at,
            metadata.updated_at AS metadata_updated_at,
            override.id AS override_id,
            override.category_overridden,
            override.category_updated_at,
            override.excluded_from_spending_overridden,
            override.excluded_from_spending_updated_at,
            override.cash_flow_role_overridden,
            override.cash_flow_role_updated_at,
            override.is_fixed_overridden,
            override.is_fixed_updated_at,
            override.updated_at AS override_updated_at,
            COALESCE(split_state.split_count, 0)::integer
              AS target_split_count
          FROM transactions target
          LEFT JOIN transaction_metadata metadata
            ON metadata.workspace_id = target.workspace_id
           AND metadata.transaction_id = target.id
          LEFT JOIN categorization_overrides override
            ON override.workspace_id = target.workspace_id
           AND override.transaction_id = target.id
          LEFT JOIN LATERAL (
            SELECT count(*)::integer AS split_count
            FROM transaction_splits split
            WHERE split.workspace_id = target.workspace_id
              AND split.transaction_id = target.id
          ) split_state ON true
          WHERE target.workspace_id = $1
            AND target.id = $2
            AND target.pending = false
          FOR UPDATE OF target
        `,
        [workspaceId, transactionId],
      );
      const target = targetResult.rows[0];
      if (!target) return null;

      const userState = jsonObject(recovery.user_state);
      const providerFacts = jsonObject(recovery.provider_facts);
      const fieldWins = (
        sourceOverridden,
        sourceUpdatedAt,
        targetOverridden,
        targetUpdatedAt,
      ) =>
        sourceOverridden === true &&
        (
          targetOverridden !== true ||
          targetUpdatedAt == null ||
          sourceUpdatedAt == null ||
          targetUpdatedAt <= sourceUpdatedAt
        );
      const metadata = jsonObject(userState.metadata, null);
      if (metadata) {
        const sourceDisplayUpdatedAtValue =
          metadata.display_name_updated_at ??
          metadata.updated_at ??
          recovery.pending_updated_at;
        const sourceTagsUpdatedAtValue =
          metadata.tags_updated_at ??
          metadata.updated_at ??
          recovery.pending_updated_at;
        const sourceBudgetMonthUpdatedAtValue =
          metadata.budget_month_updated_at ??
          metadata.updated_at ??
          recovery.pending_updated_at;
        const sourceDisplayUpdatedAt = timestampValue(
          sourceDisplayUpdatedAtValue,
        );
        const sourceTagsUpdatedAt = timestampValue(
          sourceTagsUpdatedAtValue,
        );
        const sourceBudgetMonthUpdatedAt = timestampValue(
          sourceBudgetMonthUpdatedAtValue,
        );
        const applyDisplay =
          fieldWins(
            metadata.display_name_overridden,
            sourceDisplayUpdatedAt,
            target.display_name_overridden,
            timestampValue(
              target.display_name_updated_at ??
                target.metadata_updated_at,
            ),
          );
        const applyTags =
          fieldWins(
            metadata.tags_overridden,
            sourceTagsUpdatedAt,
            target.tags_overridden,
            timestampValue(
              target.tags_updated_at ?? target.metadata_updated_at,
            ),
          );
        const applyBudgetMonth =
          fieldWins(
            metadata.budget_month_overridden,
            sourceBudgetMonthUpdatedAt,
            target.budget_month_overridden,
            timestampValue(
              target.budget_month_updated_at ??
                target.metadata_updated_at,
            ),
          );
        const sourceNoteVersion = Number(metadata.note_version ?? 0);
        const sourceNoteUpdatedAt = timestampValue(
          metadata.note_updated_at,
        );
        const targetNoteUpdatedAt = timestampValue(
          target.metadata_note_updated_at,
        );
        const applyNote =
          sourceNoteVersion > 0 &&
          (
            Number(target.metadata_note_version ?? 0) === 0 ||
            targetNoteUpdatedAt == null ||
            sourceNoteUpdatedAt == null ||
            targetNoteUpdatedAt <= sourceNoteUpdatedAt
          );

        if (applyTags) {
          const tags = Array.isArray(userState.tags)
            ? userState.tags
            : [];
          const tagRows = tags.map((tag) => {
            const normalized = normalizeTagName(tag.name);
            return {
              id: randomUUID(),
              name: normalized.name,
              normalized_name:
                tag.normalized_name ?? normalized.normalized_name,
            };
          });
          if (tagRows.length) {
            await client.query(
              `
                INSERT INTO transaction_tags (
                  id, workspace_id, name, normalized_name, created_by
                )
                SELECT row.id, $1, row.name, row.normalized_name, $3
                FROM jsonb_to_recordset($2::jsonb) AS row(
                  id text,
                  name text,
                  normalized_name text
                )
                ON CONFLICT (workspace_id, normalized_name)
                DO UPDATE SET name = EXCLUDED.name, updated_at = now()
              `,
              [workspaceId, JSON.stringify(tagRows), userId],
            );
          }
          await client.query(
            `
              DELETE FROM transaction_tag_assignments
              WHERE workspace_id = $1 AND transaction_id = $2
            `,
            [workspaceId, transactionId],
          );
          if (tagRows.length) {
            await client.query(
              `
                INSERT INTO transaction_tag_assignments (
                  workspace_id, transaction_id, tag_id, created_by
                )
                SELECT $1, $2, tag.id, $4
                FROM transaction_tags tag
                WHERE tag.workspace_id = $1
                  AND tag.normalized_name = ANY($3::text[])
                ON CONFLICT DO NOTHING
              `,
              [
                workspaceId,
                transactionId,
                tagRows.map((tag) => tag.normalized_name),
                userId,
              ],
            );
          }
        }

        if (applyDisplay || applyTags || applyNote || applyBudgetMonth) {
          await client.query(
            `
              INSERT INTO transaction_metadata (
                workspace_id, transaction_id,
                display_name, display_name_overridden,
                display_name_updated_at,
                tags_overridden, tags_updated_at,
                note, note_version, note_updated_by, note_updated_at,
                budget_month_on, budget_month_overridden,
                budget_month_updated_at,
                created_by, updated_at
              )
              VALUES (
                $1, $2,
                CASE WHEN $4::boolean THEN $3 ELSE NULL END, $4,
                CASE WHEN $4::boolean THEN $5::timestamptz ELSE NULL END,
                $6,
                CASE WHEN $6::boolean THEN $7::timestamptz ELSE NULL END,
                CASE WHEN $8::boolean THEN $9 ELSE NULL END,
                CASE WHEN $8::boolean THEN $10 ELSE 0 END,
                CASE WHEN $8::boolean THEN $11 ELSE NULL END,
                CASE WHEN $8::boolean THEN $12::timestamptz ELSE NULL END,
                CASE WHEN $14::boolean THEN $13::date ELSE NULL END,
                $14,
                CASE WHEN $14::boolean THEN $15::timestamptz ELSE NULL END,
                $16, COALESCE($17::timestamptz, now())
              )
              ON CONFLICT (workspace_id, transaction_id) DO UPDATE SET
                display_name = CASE WHEN $4::boolean
                  THEN EXCLUDED.display_name
                  ELSE transaction_metadata.display_name END,
                display_name_overridden =
                  transaction_metadata.display_name_overridden
                  OR $4::boolean,
                display_name_updated_at = CASE WHEN $4::boolean
                  THEN EXCLUDED.display_name_updated_at
                  ELSE transaction_metadata.display_name_updated_at END,
                tags_overridden =
                  transaction_metadata.tags_overridden OR $6::boolean,
                tags_updated_at = CASE WHEN $6::boolean
                  THEN EXCLUDED.tags_updated_at
                  ELSE transaction_metadata.tags_updated_at END,
                note = CASE WHEN $8::boolean
                  THEN EXCLUDED.note ELSE transaction_metadata.note END,
                note_version = CASE WHEN $8::boolean
                  THEN EXCLUDED.note_version
                  ELSE transaction_metadata.note_version END,
                note_updated_by = CASE WHEN $8::boolean
                  THEN EXCLUDED.note_updated_by
                  ELSE transaction_metadata.note_updated_by END,
                note_updated_at = CASE WHEN $8::boolean
                  THEN EXCLUDED.note_updated_at
                  ELSE transaction_metadata.note_updated_at END,
                budget_month_on = CASE WHEN $14::boolean
                  THEN EXCLUDED.budget_month_on
                  ELSE transaction_metadata.budget_month_on END,
                budget_month_overridden =
                  transaction_metadata.budget_month_overridden
                  OR $14::boolean,
                budget_month_updated_at = CASE WHEN $14::boolean
                  THEN EXCLUDED.budget_month_updated_at
                  ELSE transaction_metadata.budget_month_updated_at END,
                updated_at = GREATEST(
                  transaction_metadata.updated_at,
                  EXCLUDED.updated_at
                )
            `,
            [
              workspaceId,
              transactionId,
              metadata.display_name ?? null,
              applyDisplay,
              sourceDisplayUpdatedAtValue,
              applyTags,
              sourceTagsUpdatedAtValue,
              applyNote,
              metadata.note ?? null,
              sourceNoteVersion,
              metadata.note_updated_by ?? userId,
              metadata.note_updated_at ?? null,
              metadata.budget_month_on ?? null,
              applyBudgetMonth,
              sourceBudgetMonthUpdatedAtValue,
              metadata.created_by ?? userId,
              metadata.updated_at ?? recovery.pending_updated_at,
            ],
          );
        }
      }

      const categorization = jsonObject(
        userState.categorization_override,
        null,
      );
      if (categorization) {
        const sourceCategoryOverridden =
          categorization.category_overridden === true ||
          (
            categorization.category_overridden == null &&
            (
              categorization.category_primary != null ||
              categorization.category_detailed != null ||
              categorization.category_id != null
            )
          );
        const sourceExcludedOverridden =
          categorization.excluded_from_spending_overridden === true ||
          (
            categorization.excluded_from_spending_overridden == null &&
            categorization.excluded_from_spending != null
          );
        const sourceRoleOverridden =
          categorization.cash_flow_role_overridden === true ||
          (
            categorization.cash_flow_role_overridden == null &&
            categorization.cash_flow_role != null
          );
        const sourceFixedOverridden =
          categorization.is_fixed_overridden === true ||
          (
            categorization.is_fixed_overridden == null &&
            categorization.is_fixed != null
          );
        const sourceCategoryUpdatedAtValue =
          categorization.category_updated_at ??
          categorization.updated_at ??
          recovery.pending_updated_at;
        const sourceExcludedUpdatedAtValue =
          categorization.excluded_from_spending_updated_at ??
          categorization.updated_at ??
          recovery.pending_updated_at;
        const sourceRoleUpdatedAtValue =
          categorization.cash_flow_role_updated_at ??
          categorization.updated_at ??
          recovery.pending_updated_at;
        const sourceFixedUpdatedAtValue =
          categorization.is_fixed_updated_at ??
          categorization.updated_at ??
          recovery.pending_updated_at;
        const sourceCategoryUpdatedAt = timestampValue(
          sourceCategoryUpdatedAtValue,
        );
        const sourceExcludedUpdatedAt = timestampValue(
          sourceExcludedUpdatedAtValue,
        );
        const sourceRoleUpdatedAt = timestampValue(
          sourceRoleUpdatedAtValue,
        );
        const sourceFixedUpdatedAt = timestampValue(
          sourceFixedUpdatedAtValue,
        );
        const applyCategory = fieldWins(
          sourceCategoryOverridden,
          sourceCategoryUpdatedAt,
          target.category_overridden,
          timestampValue(
            target.category_updated_at ?? target.override_updated_at,
          ),
        );
        const applyExcluded = fieldWins(
          sourceExcludedOverridden,
          sourceExcludedUpdatedAt,
          target.excluded_from_spending_overridden,
          timestampValue(
            target.excluded_from_spending_updated_at ??
              target.override_updated_at,
          ),
        );
        const applyRole = fieldWins(
          sourceRoleOverridden,
          sourceRoleUpdatedAt,
          target.cash_flow_role_overridden,
          timestampValue(
            target.cash_flow_role_updated_at ?? target.override_updated_at,
          ),
        );
        const applyFixed = fieldWins(
          sourceFixedOverridden,
          sourceFixedUpdatedAt,
          target.is_fixed_overridden,
          timestampValue(
            target.is_fixed_updated_at ?? target.override_updated_at,
          ),
        );
        if (applyCategory || applyExcluded || applyRole || applyFixed) {
        await client.query(
          `
            INSERT INTO categorization_overrides (
              id, workspace_id, transaction_id,
              category_primary, category_detailed, category_id,
              category_overridden, category_updated_at,
              excluded_from_spending,
              excluded_from_spending_overridden,
              excluded_from_spending_updated_at,
              cash_flow_role, cash_flow_role_overridden,
              cash_flow_role_updated_at,
              is_fixed, is_fixed_overridden, is_fixed_updated_at,
              created_by, created_at, updated_at
            )
            VALUES (
              $1, $2, $3,
              CASE WHEN $7::boolean THEN $4 ELSE NULL END,
              CASE WHEN $7::boolean THEN $5 ELSE NULL END,
              CASE WHEN $7::boolean THEN $6 ELSE NULL END,
              $7, CASE WHEN $7::boolean THEN $8::timestamptz ELSE NULL END,
              CASE WHEN $10::boolean THEN $9::boolean ELSE NULL END,
              $10,
              CASE WHEN $10::boolean THEN $11::timestamptz ELSE NULL END,
              CASE WHEN $13::boolean THEN $12 ELSE NULL END,
              $13,
              CASE WHEN $13::boolean THEN $14::timestamptz ELSE NULL END,
              CASE WHEN $16::boolean THEN $15::boolean ELSE NULL END,
              $16,
              CASE WHEN $16::boolean THEN $17::timestamptz ELSE NULL END,
              $18, COALESCE($19::timestamptz, now()),
              COALESCE($20::timestamptz, now())
            )
            ON CONFLICT (workspace_id, transaction_id)
              WHERE transaction_id IS NOT NULL
            DO UPDATE SET
              category_primary = CASE WHEN $7::boolean
                THEN EXCLUDED.category_primary
                ELSE categorization_overrides.category_primary END,
              category_detailed = CASE WHEN $7::boolean
                THEN EXCLUDED.category_detailed
                ELSE categorization_overrides.category_detailed END,
              category_id = CASE WHEN $7::boolean
                THEN EXCLUDED.category_id
                ELSE categorization_overrides.category_id END,
              category_overridden =
                categorization_overrides.category_overridden
                OR $7::boolean,
              category_updated_at = CASE WHEN $7::boolean
                THEN EXCLUDED.category_updated_at
                ELSE categorization_overrides.category_updated_at END,
              excluded_from_spending = CASE WHEN $10::boolean
                THEN EXCLUDED.excluded_from_spending
                ELSE categorization_overrides.excluded_from_spending END,
              excluded_from_spending_overridden =
                categorization_overrides.excluded_from_spending_overridden
                OR $10::boolean,
              excluded_from_spending_updated_at = CASE WHEN $10::boolean
                THEN EXCLUDED.excluded_from_spending_updated_at
                ELSE categorization_overrides.excluded_from_spending_updated_at
              END,
              cash_flow_role = CASE WHEN $13::boolean
                THEN EXCLUDED.cash_flow_role
                ELSE categorization_overrides.cash_flow_role END,
              cash_flow_role_overridden =
                categorization_overrides.cash_flow_role_overridden
                OR $13::boolean,
              cash_flow_role_updated_at = CASE WHEN $13::boolean
                THEN EXCLUDED.cash_flow_role_updated_at
                ELSE categorization_overrides.cash_flow_role_updated_at END,
              is_fixed = CASE WHEN $16::boolean
                THEN EXCLUDED.is_fixed
                ELSE categorization_overrides.is_fixed END,
              is_fixed_overridden =
                categorization_overrides.is_fixed_overridden
                OR $16::boolean,
              is_fixed_updated_at = CASE WHEN $16::boolean
                THEN EXCLUDED.is_fixed_updated_at
                ELSE categorization_overrides.is_fixed_updated_at END,
              updated_at = GREATEST(
                categorization_overrides.updated_at,
                EXCLUDED.updated_at
              )
          `,
          [
            randomUUID(),
            workspaceId,
            transactionId,
            categorization.category_primary ?? null,
            categorization.category_detailed ?? null,
            categorization.category_id ?? null,
            applyCategory,
            sourceCategoryUpdatedAtValue,
            categorization.excluded_from_spending ?? null,
            applyExcluded,
            sourceExcludedUpdatedAtValue,
            categorization.cash_flow_role ?? null,
            applyRole,
            sourceRoleUpdatedAtValue,
            categorization.is_fixed ?? null,
            applyFixed,
            sourceFixedUpdatedAtValue,
            categorization.created_by ?? userId,
            categorization.created_at ?? null,
            categorization.updated_at ?? recovery.pending_updated_at,
          ],
        );
        }
      }

      await this.#attachRecoveredSplits(client, {
        workspaceId,
        transactionId,
        target,
        recovery,
        providerFacts,
        splits: Array.isArray(userState.splits) ? userState.splits : [],
        splitOverridden:
          userState.split_overridden === true ||
          Object.hasOwn(userState, "splits"),
        splitUpdatedAt: userState.split_updated_at ?? null,
        splitVersion: userState.split_version ?? 0,
        splitNeedsReview: userState.split_needs_review === true,
        userId,
      });

      const patterns = Array.isArray(userState.recurring_patterns)
        ? userState.recurring_patterns
        : [];
      const sourceRecurringAmount = Number(providerFacts.amount_minor);
      const targetRecurringAmount = Number(target.amount_minor);
      const recurringProviderFactsSafe =
        Number.isSafeInteger(sourceRecurringAmount) &&
        Number.isSafeInteger(targetRecurringAmount) &&
        sourceRecurringAmount !== 0 &&
        targetRecurringAmount !== 0 &&
        providerFacts.currency_code === target.currency_code &&
        Math.sign(sourceRecurringAmount) ===
          Math.sign(targetRecurringAmount);
      for (const pattern of patterns) {
        const matchField = target.normalized_merchant
          ? "normalized_merchant"
          : "normalized_name";
        const normalizedMatchValue = target[matchField]?.trim() ?? "";
        const recurringIntentSafe =
          recurringProviderFactsSafe &&
          targetRecurringAmount < 0 &&
          (pattern.currency_code ?? providerFacts.currency_code) ===
            target.currency_code &&
          Boolean(normalizedMatchValue);
        const sourceIntentUpdatedAt =
          pattern.updated_at ?? recovery.pending_updated_at;

        // Split-recency semantics apply to recurring intent too: a newer
        // explicit rule already authored on the posted row wins. When the
        // pending rule is newer, retire the older target rule before moving
        // the source anchor so one logical charge cannot create two streams.
        await client.query(
          `
            UPDATE recurring_pattern_rules target_rule
            SET active = false
            WHERE target_rule.workspace_id = $1
              AND target_rule.source_transaction_id = $2
              AND target_rule.id <> $3
              AND target_rule.active = true
              AND target_rule.updated_at <= $4::timestamptz
          `,
          [
            workspaceId,
            transactionId,
            pattern.id,
            sourceIntentUpdatedAt,
          ],
        );
        await client.query(
          `
            UPDATE recurring_pattern_rules source_rule
            SET active = false
            WHERE source_rule.workspace_id = $1
              AND source_rule.id = $2
              AND source_rule.updated_at <= $4::timestamptz
              AND (
                source_rule.source_transaction_id IS NULL
                OR source_rule.source_transaction_id = $3
              )
              AND EXISTS (
                SELECT 1
                FROM recurring_pattern_rules target_rule
                WHERE target_rule.workspace_id = $1
                  AND target_rule.source_transaction_id = $5
                  AND target_rule.id <> source_rule.id
                  AND target_rule.active = true
                  AND target_rule.updated_at > $4::timestamptz
              )
          `,
          [
            workspaceId,
            pattern.id,
            recovery.pending_transaction_id,
            sourceIntentUpdatedAt,
            transactionId,
          ],
        );

        if (recurringIntentSafe) {
          await client.query(
            `
              UPDATE recurring_pattern_rules rule
              SET source_transaction_id = $3,
                  account_id = $4,
                  match_field = $5,
                  normalized_match_value = $6,
                  anchor_amount_minor = abs($7::bigint),
                  currency_code = $8,
                  updated_by = $9
              WHERE rule.workspace_id = $1
                AND rule.id = $2
                AND rule.updated_at <= $10::timestamptz
                AND (
                  rule.source_transaction_id IS NULL
                  OR rule.source_transaction_id = $11
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM recurring_pattern_rules target_rule
                  WHERE target_rule.workspace_id = $1
                    AND target_rule.source_transaction_id = $3
                    AND target_rule.id <> rule.id
                    AND target_rule.active = true
                    AND target_rule.updated_at > $10::timestamptz
                )
            `,
            [
              workspaceId,
              pattern.id,
              transactionId,
              target.account_id,
              matchField,
              normalizedMatchValue,
              target.amount_minor,
              target.currency_code,
              userId,
              sourceIntentUpdatedAt,
              recovery.pending_transaction_id,
            ],
          );
          continue;
        }

        const review = await client.query(
          `
            UPDATE recurring_pattern_rules rule
            SET source_transaction_id = $3,
                active = false,
                updated_by = $4
            WHERE rule.workspace_id = $1
              AND rule.id = $2
              AND rule.active = true
              AND rule.updated_at <= $5::timestamptz
              AND (
                rule.source_transaction_id IS NULL
                OR rule.source_transaction_id = $6
              )
              AND NOT EXISTS (
                SELECT 1
                FROM recurring_pattern_rules target_rule
                WHERE target_rule.workspace_id = $1
                  AND target_rule.source_transaction_id = $3
                  AND target_rule.id <> rule.id
                  AND target_rule.active = true
                  AND target_rule.updated_at > $5::timestamptz
              )
            RETURNING rule.id
          `,
          [
            workspaceId,
            pattern.id,
            transactionId,
            userId,
            sourceIntentUpdatedAt,
            recovery.pending_transaction_id,
          ],
        );
        if (review.rows[0]) {
          await client.query(
            `
              UPDATE transactions
              SET recurring_needs_review = true,
                  updated_at = now()
              WHERE workspace_id = $1 AND id = $2
            `,
            [workspaceId, transactionId],
          );
        }
      }

      const attached = await client.query(
        `
          UPDATE unmatched_pending_transaction_edits
          SET attached_transaction_id = $3,
              attached_at = now(),
              attached_by = $4,
              updated_at = now()
          WHERE workspace_id = $1
            AND id = $2
            AND attached_at IS NULL
            AND dismissed_at IS NULL
          RETURNING *
        `,
        [workspaceId, recoveryId, transactionId, userId],
      );
      await this.#refreshTransactionSearchDocuments(
        client,
        workspaceId,
        [transactionId],
      );
      return attached.rows[0]
        ? mapPendingEditRecovery(attached.rows[0])
        : null;
    });
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
    const hasExcludedFromSpending = Object.hasOwn(
      changes,
      "excludedFromSpending",
    );
    const hasCashFlowRole = Object.hasOwn(changes, "cashFlowRole");
    const hasBudgetMonthOffset = Object.hasOwn(
      changes,
      "budgetMonthOffset",
    );
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

    return this.#withTransaction(async (client) => {
      const locked = await client.query(
        `
          SELECT
            candidate.id,
            candidate.posted_on,
            EXISTS (
              SELECT 1
              FROM recurring_pattern_rules rule
              WHERE rule.workspace_id = candidate.workspace_id
                AND rule.active = true
                AND rule.account_id = candidate.account_id
                AND rule.currency_code = candidate.currency_code
                AND CASE rule.match_field
                  WHEN 'normalized_merchant'
                    THEN rule.normalized_match_value =
                      candidate.normalized_merchant
                  WHEN 'normalized_name'
                    THEN rule.normalized_match_value =
                      candidate.normalized_name
                  ELSE false
                END
                AND abs(
                  rule.anchor_amount_minor -
                    abs(candidate.amount_minor)
                ) <= greatest(
                  200,
                  round(rule.anchor_amount_minor * 0.2)
                )
            ) AS has_active_recurring_pattern
          FROM transactions candidate
          WHERE candidate.workspace_id = $1
            AND candidate.id = ANY($2::text[])
          ORDER BY candidate.id
          FOR UPDATE OF candidate
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
      const targetCashFlowRole = hasCashFlowRole
        ? changes.cashFlowRole
        : hasExcludedFromSpending
          ? changes.excludedFromSpending
            ? "transfer"
            : "spending"
          : null;
      if (
        targetCashFlowRole === "transfer" &&
        locked.rows.some((row) => row.has_active_recurring_pattern)
      ) {
        return {
          conflict: "active_recurring_pattern",
          transactionIds: locked.rows
            .filter((row) => row.has_active_recurring_pattern)
            .map((row) => row.id),
        };
      }

      if (hasDisplayName) {
        await client.query(
          `
            INSERT INTO transaction_metadata (
              workspace_id,
              transaction_id,
              display_name,
              display_name_overridden,
              display_name_updated_at,
              created_by
            )
            SELECT $1, selected.transaction_id, $3, true, now(), $4
            FROM unnest($2::text[]) AS selected(transaction_id)
            ON CONFLICT (workspace_id, transaction_id) DO UPDATE SET
              display_name = EXCLUDED.display_name,
              display_name_overridden = true,
              display_name_updated_at = now(),
              updated_at = now()
          `,
          [workspaceId, ids, changes.displayName, userId],
        );
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
              category_detailed, category_id,
              category_overridden, category_updated_at, created_by
            )
            SELECT
              row.id, $1, row.transaction_id, $3, NULL, NULL,
              true, now(), $4
            FROM jsonb_to_recordset($2::jsonb) AS row(
              id text,
              transaction_id text
            )
            ON CONFLICT (workspace_id, transaction_id)
              WHERE transaction_id IS NOT NULL
            DO UPDATE SET
              category_primary = EXCLUDED.category_primary,
              category_detailed = NULL,
              category_id = NULL,
              category_overridden = true,
              category_updated_at = now(),
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

      if (hasExcludedFromSpending || hasCashFlowRole) {
        const overrideRows = ids.map((transactionId) => ({
          id: randomUUID(),
          transaction_id: transactionId,
        }));
        await client.query(
          `
            INSERT INTO categorization_overrides (
              id, workspace_id, transaction_id,
              excluded_from_spending,
              excluded_from_spending_overridden,
              excluded_from_spending_updated_at,
              cash_flow_role, cash_flow_role_overridden,
              cash_flow_role_updated_at, created_by
            )
            SELECT row.id, $1, row.transaction_id,
              $3, $6, CASE WHEN $6::boolean THEN now() ELSE NULL END,
              $4, true, now(), $5
            FROM jsonb_to_recordset($2::jsonb) AS row(
              id text,
              transaction_id text
            )
            ON CONFLICT (workspace_id, transaction_id)
              WHERE transaction_id IS NOT NULL
            DO UPDATE SET
              excluded_from_spending = CASE
                WHEN $6::boolean
                  THEN EXCLUDED.excluded_from_spending
                ELSE categorization_overrides.excluded_from_spending
              END,
              excluded_from_spending_overridden = CASE
                WHEN $6::boolean THEN true
                ELSE categorization_overrides.excluded_from_spending_overridden
              END,
              excluded_from_spending_updated_at = CASE
                WHEN $6::boolean THEN now()
                ELSE categorization_overrides.excluded_from_spending_updated_at
              END,
              cash_flow_role = EXCLUDED.cash_flow_role,
              cash_flow_role_overridden = true,
              cash_flow_role_updated_at = now(),
              updated_at = now()
          `,
          [
            workspaceId,
            JSON.stringify(overrideRows),
            hasExcludedFromSpending
              ? changes.excludedFromSpending
              : null,
            hasCashFlowRole
              ? changes.cashFlowRole
              : changes.excludedFromSpending
                ? "transfer"
                : "spending",
            userId,
            hasExcludedFromSpending,
          ],
        );
      }

      if (hasTags) {
        await client.query(
          `
            INSERT INTO transaction_metadata (
              workspace_id, transaction_id, tags_overridden,
              tags_updated_at, created_by
            )
            SELECT $1, selected.transaction_id, true, now(), $3
            FROM unnest($2::text[]) AS selected(transaction_id)
            ON CONFLICT (workspace_id, transaction_id) DO UPDATE SET
              tags_overridden = true,
              tags_updated_at = now(),
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

      if (hasBudgetMonthOffset) {
        await client.query(
          `
            INSERT INTO transaction_metadata (
              workspace_id,
              transaction_id,
              budget_month_on,
              budget_month_overridden,
              budget_month_updated_at,
              created_by
            )
            SELECT
              $1,
              selected.id,
              (
                date_trunc('month', selected.posted_on)
                + make_interval(months => $3::integer)
              )::date,
              true,
              now(),
              $4
            FROM transactions selected
            WHERE selected.workspace_id = $1
              AND selected.id = ANY($2::text[])
            ON CONFLICT (workspace_id, transaction_id) DO UPDATE SET
              budget_month_on = EXCLUDED.budget_month_on,
              budget_month_overridden = true,
              budget_month_updated_at = now(),
              updated_at = now()
          `,
          [
            workspaceId,
            ids,
            changes.budgetMonthOffset,
            userId,
          ],
        );
      }

      if (hasDisplayName || hasTags || hasBudgetMonthOffset) {
        await client.query(
          `
            DELETE FROM transaction_metadata
            WHERE workspace_id = $1
              AND transaction_id = ANY($2::text[])
              AND display_name IS NULL
              AND display_name_overridden = false
              AND tags_overridden = false
              AND note IS NULL
              AND note_version = 0
              AND budget_month_on IS NULL
              AND budget_month_overridden = false
          `,
          [workspaceId, ids],
        );
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

  async updateTransactionNote(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      transactionId,
      note,
      expectedVersion,
      userId = null,
    },
  ) {
    return this.#withTransaction(async (client) => {
      const transaction = await client.query(
        `
          SELECT id
          FROM transactions
          WHERE workspace_id = $1
            AND id = $2
          FOR UPDATE
        `,
        [workspaceId, transactionId],
      );
      if (!transaction.rows[0]) return null;

      const existing = await client.query(
        `
          SELECT note, note_version, note_updated_by, note_updated_at
          FROM transaction_metadata
          WHERE workspace_id = $1
            AND transaction_id = $2
          FOR UPDATE
        `,
        [workspaceId, transactionId],
      );
      const current = existing.rows[0] ?? null;
      const currentVersion = Number(current?.note_version ?? 0);
      if (currentVersion !== expectedVersion) {
        return {
          conflict: true,
          transaction_id: transactionId,
          note: current?.note ?? null,
          note_version: currentVersion,
          note_updated_by: current?.note_updated_by ?? null,
          note_updated_at: dateValue(current?.note_updated_at),
        };
      }

      if (!current && note == null) {
        return {
          transaction_id: transactionId,
          note: null,
          note_version: 0,
          note_updated_by: null,
          note_updated_at: null,
        };
      }

      const result = await client.query(
        `
          INSERT INTO transaction_metadata (
            workspace_id,
            transaction_id,
            note,
            note_version,
            note_updated_by,
            note_updated_at,
            created_by
          )
          VALUES ($1, $2, $3, 1, $4, now(), $4)
          ON CONFLICT (workspace_id, transaction_id) DO UPDATE SET
            note = EXCLUDED.note,
            note_version = transaction_metadata.note_version + 1,
            note_updated_by = EXCLUDED.note_updated_by,
            note_updated_at = now(),
            updated_at = now()
          RETURNING
            transaction_id,
            note,
            note_version,
            note_updated_by,
            note_updated_at
        `,
        [workspaceId, transactionId, note, userId],
      );
      await this.#refreshTransactionSearchDocuments(
        client,
        workspaceId,
        [transactionId],
      );
      const updated = result.rows[0];
      return {
        transaction_id: updated.transaction_id,
        note: updated.note ?? null,
        note_version: Number(updated.note_version),
        note_updated_by: updated.note_updated_by ?? null,
        note_updated_at: dateValue(updated.note_updated_at),
      };
    });
  }

  async linkRefundToOriginal(
    workspaceId = DEFAULT_WORKSPACE_ID,
    transactionId,
    originalTransactionId,
  ) {
    const result = await this.#client().query(
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

  async listSpendingCategories(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { includeMerged = false } = {},
  ) {
    const result = await this.#client().query(
      `
        WITH category_transactions AS (
          SELECT
            effective.category_id,
            effective.transaction_id
          FROM transaction_effective_spending_categories effective
          WHERE effective.workspace_id = $1
            AND effective.category_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM transaction_splits split
              WHERE split.workspace_id = effective.workspace_id
                AND split.transaction_id = effective.transaction_id
            )
          UNION
          SELECT
            active_spending_category_id(
              split.workspace_id,
              split.category_id
            ) AS category_id,
            split.transaction_id
          FROM transaction_splits split
          WHERE split.workspace_id = $1
        ),
        transaction_counts AS (
          SELECT category_id, COUNT(DISTINCT transaction_id)::integer AS count
          FROM category_transactions
          GROUP BY category_id
        ),
        budget_counts AS (
          SELECT
            active_spending_category_id(
              budget.workspace_id,
              budget.category_id
            ) AS category_id,
            COUNT(*)::integer AS count
          FROM budget_lines budget
          WHERE budget.workspace_id = $1
          GROUP BY 1
        )
        SELECT
          category.*,
          CASE
            WHEN category.merged_into_category_id IS NOT NULL
              THEN concat_ws(
                ' / ',
                spending_category_name_for_id(
                  category.workspace_id,
                  category.parent_category_id
                ),
                category.name
              )
            ELSE spending_category_name_for_id(
              category.workspace_id,
              category.id
            )
          END AS path,
          CASE
            WHEN category.merged_into_category_id IS NOT NULL
              THEN spending_category_name_for_id(
                category.workspace_id,
                category.merged_into_category_id
              )
          END AS merged_into_path,
          COALESCE(merge_destination.is_system, false)
            AS merged_into_is_system,
          COALESCE(transaction_counts.count, 0) AS transaction_count,
          COALESCE(budget_counts.count, 0) AS budget_line_count,
          COALESCE(alias_data.aliases, '[]'::jsonb) AS aliases
        FROM spending_categories category
        LEFT JOIN transaction_counts
          ON transaction_counts.category_id = category.id
        LEFT JOIN budget_counts
          ON budget_counts.category_id = category.id
        LEFT JOIN spending_categories merge_destination
          ON merge_destination.workspace_id = category.workspace_id
         AND merge_destination.id = category.merged_into_category_id
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(
            jsonb_build_object(
              'label', alias.alias,
              'type', alias.alias_type
            )
            ORDER BY alias.alias
          ) AS aliases
          FROM spending_category_aliases alias
          WHERE alias.workspace_id = category.workspace_id
            AND (
              (
                category.merged_into_category_id IS NULL
                AND active_spending_category_id(
                  alias.workspace_id,
                  alias.category_id
                ) = category.id
              )
              OR (
                category.merged_into_category_id IS NOT NULL
                AND alias.category_id = category.id
              )
            )
        ) alias_data ON true
        WHERE category.workspace_id = $1
          AND ($2::boolean OR category.merged_into_category_id IS NULL)
        ORDER BY
          category.merged_into_category_id IS NOT NULL,
          category.is_system,
          path,
          category.id
      `,
      [workspaceId, includeMerged],
    );
    return result.rows.map(mapSpendingCategory);
  }

  async resolveSpendingCategory(
    workspaceId = DEFAULT_WORKSPACE_ID,
    value,
  ) {
    const result = await this.#client().query(
      `
        SELECT
          category.id,
          category.name,
          category.classification,
          category.parent_category_id,
          category.version,
          spending_category_name_for_id(
            category.workspace_id,
            category.id
          ) AS path
        FROM spending_categories category
        WHERE category.workspace_id = $1
          AND category.id = COALESCE(
            active_spending_category_id($1, $2),
            spending_category_id_for_label($1, $2)
          )
      `,
      [workspaceId, value],
    );
    return result.rows[0] ? mapSpendingCategory(result.rows[0]) : null;
  }

  async createSpendingCategory(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      name,
      classification,
      parentCategoryId = null,
      userId = null,
    },
  ) {
    const categoryId = stableId("category", randomUUID());
    try {
      await this.#withTransaction(async (client) => {
        if (parentCategoryId) {
          const parent = await client.query(
            `
              SELECT id
              FROM spending_categories
              WHERE workspace_id = $1
                AND id = $2
                AND merged_into_category_id IS NULL
                AND is_system = false
              FOR UPDATE
            `,
            [workspaceId, parentCategoryId],
          );
          if (!parent.rows[0]) {
            const error = new Error("Parent category not found");
            error.code = "CATEGORY_PARENT_NOT_FOUND";
            throw error;
          }
        }
        const aliasConflict = await client.query(
          `
            SELECT active_spending_category_id(
              alias.workspace_id,
              alias.category_id
            ) AS category_id
            FROM spending_category_aliases alias
            WHERE alias.workspace_id = $1
              AND alias.normalized_alias =
                normalize_spending_category_name($2)
          `,
          [workspaceId, name],
        );
        if (aliasConflict.rows[0]) {
          const error = new Error("Category name already exists");
          error.code = "CATEGORY_NAME_CONFLICT";
          throw error;
        }
        await client.query(
          `
            INSERT INTO spending_categories (
              id, workspace_id, name, normalized_name, classification,
              parent_category_id, created_by, updated_by
            )
            VALUES (
              $1, $2, $3, normalize_spending_category_name($3), $4,
              $5, $6, $6
            )
          `,
          [
            categoryId,
            workspaceId,
            name,
            classification,
            parentCategoryId,
            userId,
          ],
        );
        const pathResult = await client.query(
          `
            SELECT spending_category_name_for_id($1, $2) AS path
          `,
          [workspaceId, categoryId],
        );
        const path = pathResult.rows[0].path;
        for (const [alias, aliasType] of [
          [name, "name"],
          [path, "name"],
        ]) {
          const conflict = await client.query(
            `
              SELECT active_spending_category_id(
                workspace_id,
                category_id
              ) AS category_id
              FROM spending_category_aliases
              WHERE workspace_id = $1
                AND normalized_alias =
                  normalize_spending_category_name($2)
            `,
            [workspaceId, alias],
          );
          if (
            conflict.rows[0] &&
            conflict.rows[0].category_id !== categoryId
          ) {
            const error = new Error("Category alias already exists");
            error.code = "CATEGORY_NAME_CONFLICT";
            throw error;
          }
          await client.query(
            `
              INSERT INTO spending_category_aliases (
                workspace_id, normalized_alias, alias, category_id,
                alias_type
              )
              VALUES (
                $1, normalize_spending_category_name($2), $2, $3, $4
              )
              ON CONFLICT (workspace_id, normalized_alias) DO NOTHING
            `,
            [workspaceId, alias, categoryId, aliasType],
          );
        }
        await client.query(
          `
            INSERT INTO spending_category_events (
              id, workspace_id, category_id, event_type, actor_id,
              after_value
            )
            VALUES (
              $1, $2, $3, 'create', $4,
              jsonb_build_object(
                'name', $5::text,
                'path', $6::text,
                'classification', $7::text,
                'parent_category_id', $8::text
              )
            )
          `,
          [
            stableId("category-event", randomUUID()),
            workspaceId,
            categoryId,
            userId,
            name,
            path,
            classification,
            parentCategoryId,
          ],
        );
      });
    } catch (error) {
      if (error?.code === "23505") {
        error.code = "CATEGORY_NAME_CONFLICT";
      }
      throw error;
    }
    const categories = await this.listSpendingCategories(workspaceId);
    return categories.find((category) => category.id === categoryId);
  }

  async updateSpendingCategory(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      categoryId,
      name,
      classification,
      parentCategoryId,
      expectedVersion,
      userId = null,
    },
  ) {
    let changed = false;
    try {
      changed = await this.#withTransaction(async (client) => {
        const currentResult = await client.query(
          `
            SELECT
              category.*,
              spending_category_name_for_id(
                category.workspace_id,
                category.id
              ) AS path
            FROM spending_categories category
            WHERE category.workspace_id = $1
              AND category.id = $2
            FOR UPDATE
          `,
          [workspaceId, categoryId],
        );
        const current = currentResult.rows[0];
        if (!current || current.merged_into_category_id) return null;
        if (current.is_system) return "protected";
        if (Number(current.version) !== Number(expectedVersion)) {
          return "stale";
        }
        const nextName = name ?? current.name;
        const nextClassification =
          classification ?? current.classification;
        const nextParentCategoryId =
          parentCategoryId === undefined
            ? current.parent_category_id
            : parentCategoryId;
        if (nextParentCategoryId) {
          const invalidParent = await client.query(
            `
              SELECT 1
              WHERE NOT EXISTS (
                SELECT 1
                FROM spending_categories parent
                WHERE parent.workspace_id = $1
                  AND parent.id = $3
                  AND parent.merged_into_category_id IS NULL
                  AND parent.is_system = false
              )
              OR EXISTS (
                SELECT 1
                FROM spending_category_descendant_ids($1, $2)
                WHERE category_id = $3
              )
              LIMIT 1
            `,
            [workspaceId, categoryId, nextParentCategoryId],
          );
          if (invalidParent.rows[0]) return "invalid_parent";
        }

        const descendantsBefore = await client.query(
          `
            SELECT
              category_id,
              spending_category_name_for_id($1, category_id) AS path
            FROM spending_category_descendant_ids($1, $2)
          `,
          [workspaceId, categoryId],
        );
        const aliasConflict = await client.query(
          `
            SELECT active_spending_category_id(
              alias.workspace_id,
              alias.category_id
            ) AS category_id
            FROM spending_category_aliases alias
            WHERE alias.workspace_id = $1
              AND alias.normalized_alias =
                normalize_spending_category_name($2)
              AND active_spending_category_id(
                alias.workspace_id,
                alias.category_id
              ) <> $3
          `,
          [workspaceId, nextName, categoryId],
        );
        if (aliasConflict.rows[0]) return "conflict";

        const updated = await client.query(
          `
            UPDATE spending_categories
            SET name = $3,
                normalized_name = normalize_spending_category_name($3),
                classification = $4,
                parent_category_id = $5,
                version = version + 1,
                updated_by = $6,
                updated_at = now()
            WHERE workspace_id = $1
              AND id = $2
            RETURNING *
          `,
          [
            workspaceId,
            categoryId,
            nextName,
            nextClassification,
            nextParentCategoryId,
            userId,
          ],
        );
        const next = updated.rows[0];
        const descendantsAfter = await client.query(
          `
            SELECT
              category_id,
              spending_category_name_for_id($1, category_id) AS path
            FROM spending_category_descendant_ids($1, $2)
          `,
          [workspaceId, categoryId],
        );
        for (const entry of descendantsAfter.rows) {
          const pathConflict = await client.query(
            `
              SELECT active_spending_category_id(
                workspace_id,
                category_id
              ) AS category_id
              FROM spending_category_aliases
              WHERE workspace_id = $1
                AND normalized_alias =
                  normalize_spending_category_name($2)
            `,
            [workspaceId, entry.path],
          );
          if (
            pathConflict.rows[0] &&
            pathConflict.rows[0].category_id !== entry.category_id
          ) {
            const error = new Error("Category alias already exists");
            error.code = "CATEGORY_NAME_CONFLICT";
            throw error;
          }
        }
        for (const entry of descendantsBefore.rows) {
          await client.query(
            `
              INSERT INTO spending_category_aliases (
                workspace_id, normalized_alias, alias, category_id,
                alias_type
              )
              VALUES (
                $1, normalize_spending_category_name($2), $2, $3,
                'former_name'
              )
              ON CONFLICT (workspace_id, normalized_alias) DO NOTHING
            `,
            [workspaceId, entry.path, entry.category_id],
          );
        }
        for (const entry of descendantsAfter.rows) {
          await client.query(
            `
              INSERT INTO spending_category_aliases (
                workspace_id, normalized_alias, alias, category_id,
                alias_type
              )
              VALUES (
                $1, normalize_spending_category_name($2), $2, $3, 'name'
              )
              ON CONFLICT (workspace_id, normalized_alias) DO UPDATE SET
                alias = EXCLUDED.alias,
                alias_type = CASE
                  WHEN spending_category_aliases.category_id =
                    EXCLUDED.category_id
                    THEN 'name'
                  ELSE spending_category_aliases.alias_type
                END
              WHERE spending_category_aliases.category_id =
                EXCLUDED.category_id
            `,
            [workspaceId, entry.path, entry.category_id],
          );
        }
        await client.query(
          `
            INSERT INTO spending_category_aliases (
              workspace_id, normalized_alias, alias, category_id, alias_type
            )
            VALUES (
              $1, normalize_spending_category_name($2), $2, $3, 'name'
            )
            ON CONFLICT (workspace_id, normalized_alias) DO NOTHING
          `,
          [workspaceId, nextName, categoryId],
        );
        if (
          nextName !== current.name ||
          nextParentCategoryId !== current.parent_category_id
        ) {
          await client.query(
            `
              INSERT INTO spending_category_events (
                id, workspace_id, category_id, event_type, actor_id,
                before_value, after_value
              )
              VALUES (
                $1, $2, $3, 'rename', $4,
                jsonb_build_object(
                  'name', $5::text,
                  'path', $6::text,
                  'parent_category_id', $7::text
                ),
                jsonb_build_object(
                  'name', $8::text,
                  'path', spending_category_name_for_id($2, $3),
                  'parent_category_id', $9::text
                )
              )
            `,
            [
              stableId("category-event", randomUUID()),
              workspaceId,
              categoryId,
              userId,
              current.name,
              current.path,
              current.parent_category_id,
              next.name,
              next.parent_category_id,
            ],
          );
        }
        if (nextClassification !== current.classification) {
          await client.query(
            `
              INSERT INTO spending_category_events (
                id, workspace_id, category_id, event_type, actor_id,
                before_value, after_value
              )
              VALUES (
                $1, $2, $3, 'reclassify', $4,
                jsonb_build_object('classification', $5::text),
                jsonb_build_object('classification', $6::text)
              )
            `,
            [
              stableId("category-event", randomUUID()),
              workspaceId,
              categoryId,
              userId,
              current.classification,
              nextClassification,
            ],
          );
        }

        for (const table of [
          "categorization_overrides",
          "transaction_cleanup_rules",
        ]) {
          await client.query(
            `
              UPDATE ${table}
              SET category_primary =
                spending_category_name_for_id(workspace_id, category_id),
                  updated_at = now()
              WHERE workspace_id = $1
                AND category_id IN (
                  SELECT category_id
                  FROM spending_category_descendant_ids($1, $2)
                )
            `,
            [workspaceId, categoryId],
          );
        }
        for (const table of [
          "transaction_splits",
          "budget_lines",
          "budget_default_revisions",
          "budget_category_versions",
        ]) {
          await client.query(
            `
              UPDATE ${table}
              SET category =
                spending_category_name_for_id(workspace_id, category_id),
                  updated_at = now()
              WHERE workspace_id = $1
                AND category_id IN (
                  SELECT category_id
                  FROM spending_category_descendant_ids($1, $2)
                )
            `,
            [workspaceId, categoryId],
          );
        }
        await this.#assertBudgetHierarchy(client, workspaceId);
        const affected = await client.query(
          `
            SELECT transaction_id
            FROM transaction_effective_spending_categories
            WHERE workspace_id = $1
              AND category_id = ANY(
                ARRAY(
                  SELECT category_id
                  FROM spending_category_descendant_ids($1, $2)
                )
              )
          `,
          [workspaceId, categoryId],
        );
        await this.#refreshTransactionSearchDocuments(
          client,
          workspaceId,
          affected.rows.map((row) => row.transaction_id),
        );
        return true;
      });
    } catch (error) {
      if (error?.code === "BUDGET_HIERARCHY_CONFLICT") {
        return { invalidBudgetHierarchy: true };
      }
      if (
        error?.code === "23505" ||
        error?.code === "CATEGORY_NAME_CONFLICT"
      ) {
        return { conflict: true };
      }
      throw error;
    }
    if (changed === "stale") return { stale: true };
    if (changed === "conflict") return { conflict: true };
    if (changed === "invalid_parent") return { invalidParent: true };
    if (changed === "protected") return { protected: true };
    if (!changed) return null;
    const categories = await this.listSpendingCategories(workspaceId);
    return categories.find((category) => category.id === categoryId);
  }

  async mergeSpendingCategories(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      sourceCategoryIds,
      destinationCategoryId = null,
      destination = null,
      expectedVersions,
      userId = null,
      operation = "merge",
    },
  ) {
    let result;
    try {
      result = await this.#withTransaction(async (client) => {
        const locked = await client.query(
          `
            SELECT *
            FROM spending_categories
            WHERE workspace_id = $1
              AND id = ANY($2::text[])
            ORDER BY id
            FOR UPDATE
          `,
          [
            workspaceId,
            [
              ...sourceCategoryIds,
              ...(destinationCategoryId ? [destinationCategoryId] : []),
            ],
          ],
        );
        const byId = new Map(locked.rows.map((row) => [row.id, row]));
        if (
          sourceCategoryIds.some(
            (id) => !byId.has(id) || byId.get(id).merged_into_category_id,
          ) ||
          (destinationCategoryId &&
            (!byId.has(destinationCategoryId) ||
              byId.get(destinationCategoryId).merged_into_category_id))
        ) {
          return "not_found";
        }
        if (
          sourceCategoryIds.some((id) => byId.get(id).is_system) ||
          (
            operation !== "delete" &&
            destinationCategoryId &&
            byId.get(destinationCategoryId).is_system
          )
        ) {
          return "protected";
        }
        for (const [id, version] of Object.entries(expectedVersions)) {
          if (!byId.has(id) || Number(byId.get(id).version) !== Number(version)) {
            return "stale";
          }
        }
        let targetId = destinationCategoryId;
        let mergeSourceIds = [...sourceCategoryIds];
        if (!targetId) {
          let createdNewTarget = false;
          targetId = stableId("category", randomUUID());
          const parentCategoryId = destination.parentCategoryId ?? null;
          if (
            parentCategoryId &&
            sourceCategoryIds.includes(parentCategoryId)
          ) {
            return "invalid_parent";
          }
          if (parentCategoryId) {
            const parent = await client.query(
              `
                SELECT id
                FROM spending_categories
                WHERE workspace_id = $1
                  AND id = $2
                  AND merged_into_category_id IS NULL
                  AND is_system = false
              `,
              [workspaceId, parentCategoryId],
            );
            if (!parent.rows[0]) return "invalid_parent";
            const descendantParent = await client.query(
              `
                SELECT 1
                FROM unnest($2::text[]) source(category_id)
                CROSS JOIN LATERAL spending_category_descendant_ids(
                  $1,
                  source.category_id
                ) descendant
                WHERE descendant.category_id = $3
                LIMIT 1
              `,
              [workspaceId, sourceCategoryIds, parentCategoryId],
            );
            if (descendantParent.rows[0]) return "invalid_parent";
          }
          const conflict = await client.query(
            `
              SELECT active_spending_category_id(
                workspace_id,
                category_id
              ) AS category_id
              FROM spending_category_aliases
              WHERE workspace_id = $1
                AND normalized_alias =
                  normalize_spending_category_name($2)
            `,
            [workspaceId, destination.name],
          );
          const conflictingCategoryId = conflict.rows[0]?.category_id ?? null;
          if (
            conflictingCategoryId &&
            !sourceCategoryIds.includes(conflictingCategoryId)
          ) {
            return "conflict";
          }
          if (conflictingCategoryId) {
            targetId = conflictingCategoryId;
            mergeSourceIds = mergeSourceIds.filter((id) => id !== targetId);
            const previousTarget = byId.get(targetId);
            await client.query(
              `
                UPDATE spending_categories
                SET name = $3,
                    normalized_name =
                      normalize_spending_category_name($3),
                    classification = $4,
                    parent_category_id = $5,
                    version = version + 1,
                    updated_by = $6,
                    updated_at = now()
                WHERE workspace_id = $1 AND id = $2
              `,
              [
                workspaceId,
                targetId,
                destination.name,
                destination.classification,
                parentCategoryId,
                userId,
              ],
            );
            await client.query(
              `
                INSERT INTO spending_category_events (
                  id, workspace_id, category_id, event_type, actor_id,
                  before_value, after_value
                )
                VALUES (
                  $1, $2, $3, 'merge', $4,
                  jsonb_build_object(
                    'name', $5::text,
                    'classification', $6::text,
                    'parent_category_id', $7::text
                  ),
                  jsonb_build_object(
                    'name', $8::text,
                    'classification', $9::text,
                    'parent_category_id', $10::text,
                    'promoted_to_destination', true
                  )
                )
              `,
              [
                stableId("category-event", randomUUID()),
                workspaceId,
                targetId,
                userId,
                previousTarget.name,
                previousTarget.classification,
                previousTarget.parent_category_id,
                destination.name,
                destination.classification,
                parentCategoryId,
              ],
            );
          } else {
            createdNewTarget = true;
            await client.query(
              `
                INSERT INTO spending_categories (
                  id, workspace_id, name, normalized_name, classification,
                  parent_category_id, created_by, updated_by
                )
                VALUES (
                  $1, $2, $3, normalize_spending_category_name($3), $4,
                  $5, $6, $6
                )
              `,
              [
                targetId,
                workspaceId,
                destination.name,
                destination.classification,
                parentCategoryId,
                userId,
              ],
            );
          }
          const path = await client.query(
            `SELECT spending_category_name_for_id($1, $2) AS path`,
            [workspaceId, targetId],
          );
          for (const alias of new Set([destination.name, path.rows[0].path])) {
            const insertedAlias = await client.query(
              `
                INSERT INTO spending_category_aliases (
                  workspace_id, normalized_alias, alias, category_id,
                  alias_type
                )
                VALUES (
                  $1, normalize_spending_category_name($2), $2, $3, 'name'
                )
                ON CONFLICT (workspace_id, normalized_alias) DO NOTHING
                RETURNING category_id
              `,
              [workspaceId, alias, targetId],
            );
            if (!insertedAlias.rows[0]) {
              const existingAlias = await client.query(
                `
                  SELECT active_spending_category_id(
                    workspace_id,
                    category_id
                  ) AS category_id
                  FROM spending_category_aliases
                  WHERE workspace_id = $1
                    AND normalized_alias =
                      normalize_spending_category_name($2)
                `,
                [workspaceId, alias],
              );
              if (existingAlias.rows[0]?.category_id !== targetId) {
                const aliasConflict = new Error("Category alias conflict");
                aliasConflict.code = "23505";
                throw aliasConflict;
              }
            }
          }
          if (createdNewTarget) {
            await client.query(
              `
                INSERT INTO spending_category_events (
                  id, workspace_id, category_id, event_type, actor_id,
                  after_value
                )
                VALUES (
                  $1, $2, $3, 'create', $4,
                  jsonb_build_object(
                    'name', $5::text,
                    'path', $6::text,
                    'classification', $7::text,
                    'parent_category_id', $8::text,
                    'created_as_merge_destination', true
                  )
                )
              `,
              [
                stableId("category-event", randomUUID()),
                workspaceId,
                targetId,
                userId,
                destination.name,
                path.rows[0].path,
                destination.classification,
                parentCategoryId,
              ],
            );
          }
        }
        if (destinationCategoryId && sourceCategoryIds.includes(targetId)) {
          return "self_merge";
        }

        const descendantTarget = await client.query(
          `
            SELECT 1
            FROM unnest($2::text[]) source(category_id)
            CROSS JOIN LATERAL spending_category_descendant_ids(
              $1,
              source.category_id
            ) descendant
            WHERE descendant.category_id = $3
            LIMIT 1
          `,
          [workspaceId, sourceCategoryIds, targetId],
        );
        if (descendantTarget.rows[0]) return "invalid_parent";

        const target = await client.query(
          `
            SELECT
              category.*,
              spending_category_name_for_id(
                category.workspace_id,
                category.id
              ) AS path
            FROM spending_categories category
            WHERE category.workspace_id = $1 AND category.id = $2
          `,
          [workspaceId, targetId],
        );
        const targetRow = target.rows[0];
        const childParentId =
          operation === "delete"
            ? byId.get(sourceCategoryIds[0]).parent_category_id
            : targetId;
        const movedCategoryIds =
          await this.#moveSpendingCategoryChildren(
            client,
            workspaceId,
            {
              sourceCategoryIds: mergeSourceIds,
              parentCategoryId: childParentId,
              userId,
            },
          );
        const allCategoryIds = [...mergeSourceIds, targetId];

        const defaults = await client.query(
          `
            SELECT
              category_id,
              effective_month_on::text AS effective_month_on,
              amount_minor,
              currency_code,
              tracking_mode,
              is_removed,
              updated_by
            FROM budget_default_revisions
            WHERE workspace_id = $1
              AND category_id = ANY($2::text[])
            ORDER BY effective_month_on, category_id
          `,
          [workspaceId, allCategoryIds],
        );
        const timeline = mergedBudgetTimeline(
          allCategoryIds,
          defaults.rows,
        );

        await client.query(
          `
            WITH moved AS (
              DELETE FROM budget_lines
              WHERE workspace_id = $1
                AND category_id = ANY($2::text[])
              RETURNING *
            )
            INSERT INTO budget_lines (
              workspace_id, month_on, category, category_id, amount_minor,
              currency_code, tracking_mode, updated_by, updated_at
            )
            SELECT
              $1,
              month_on,
              $3,
              $4,
              SUM(amount_minor),
              currency_code,
              CASE
                WHEN bool_and(tracking_mode = 'informational')
                  THEN 'informational'
                ELSE 'tracked'
              END,
              $5,
              now()
            FROM moved
            GROUP BY month_on, currency_code
          `,
          [workspaceId, allCategoryIds, targetRow.path, targetId, userId],
        );
        await client.query(
          `
            DELETE FROM budget_default_revisions
            WHERE workspace_id = $1
              AND category_id = ANY($2::text[])
          `,
          [workspaceId, allCategoryIds],
        );
        for (const revision of timeline) {
          await client.query(
            `
              INSERT INTO budget_default_revisions (
                workspace_id, category, category_id, effective_month_on,
                amount_minor, currency_code, tracking_mode, is_removed,
                updated_by, updated_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
            `,
            [
              workspaceId,
              targetRow.path,
              targetId,
              revision.effectiveMonthOn,
              revision.amountMinor,
              revision.currencyCode,
              revision.trackingMode,
              revision.isRemoved,
              userId,
            ],
          );
        }
        const versions = await client.query(
          `
            DELETE FROM budget_category_versions
            WHERE workspace_id = $1
              AND category_id = ANY($2::text[])
            RETURNING version
          `,
          [workspaceId, allCategoryIds],
        );
        const nextBudgetVersion =
          Math.max(0, ...versions.rows.map((row) => Number(row.version))) + 1;
        await client.query(
          `
            INSERT INTO budget_category_versions (
              workspace_id, category, category_id, version, updated_at
            )
            VALUES ($1, $2, $3, $4, now())
          `,
          [workspaceId, targetRow.path, targetId, nextBudgetVersion],
        );

        await client.query(
          `
            UPDATE spending_categories
            SET merged_into_category_id = $3,
                version = version + 1,
                updated_by = $4,
                updated_at = now()
            WHERE workspace_id = $1
              AND id = ANY($2::text[])
          `,
          [workspaceId, mergeSourceIds, targetId, userId],
        );
        for (const sourceCategoryId of mergeSourceIds) {
          await client.query(
            `
              INSERT INTO spending_category_events (
                id, workspace_id, category_id, event_type, actor_id,
                before_value, after_value
              )
              VALUES (
                $1, $2, $3, $9, $4,
                jsonb_build_object(
                  'name', $5::text,
                  'classification', $6::text
                ),
                jsonb_build_object(
                  'merged_into_category_id', $7::text,
                  'merged_into_path', $8::text
                )
              )
            `,
            [
              stableId("category-event", randomUUID()),
              workspaceId,
              sourceCategoryId,
              userId,
              byId.get(sourceCategoryId).name,
              byId.get(sourceCategoryId).classification,
              targetId,
              targetRow.path,
              operation === "delete" ? "delete" : "merge",
            ],
          );
        }
        await this.#assertBudgetHierarchy(client, workspaceId);
        const affected = await client.query(
          `
            SELECT transaction_id
            FROM transaction_effective_spending_categories
            WHERE workspace_id = $1
              AND category_id = ANY($2::text[])
            UNION
            SELECT transaction_id
            FROM transaction_splits
            WHERE workspace_id = $1
              AND active_spending_category_id(
                    workspace_id,
                    category_id
                  ) = ANY($2::text[])
          `,
          [workspaceId, [targetId, ...movedCategoryIds]],
        );
        await this.#refreshTransactionSearchDocuments(
          client,
          workspaceId,
          affected.rows.map((row) => row.transaction_id),
        );
        return targetId;
      });
    } catch (error) {
      if (error?.code === "BUDGET_HIERARCHY_CONFLICT") {
        return { invalidBudgetHierarchy: true };
      }
      if (
        error?.code === "23505" ||
        error?.code === "CATEGORY_NAME_CONFLICT"
      ) {
        return { conflict: true };
      }
      throw error;
    }
    if (result === "not_found") return null;
    if (result === "stale") return { stale: true };
    if (result === "invalid_parent") return { invalidParent: true };
    if (result === "conflict") return { conflict: true };
    if (result === "self_merge") return { selfMerge: true };
    if (result === "protected") return { protected: true };
    const categories = await this.listSpendingCategories(workspaceId);
    return categories.find((category) => category.id === result);
  }

  async deleteSpendingCategory(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      categoryId,
      expectedVersion,
      userId = null,
    },
  ) {
    const other = await this.#client().query(
      `
        SELECT id, version
        FROM spending_categories
        WHERE workspace_id = $1
          AND is_system = true
          AND merged_into_category_id IS NULL
        LIMIT 1
      `,
      [workspaceId],
    );
    if (!other.rows[0]) {
      const error = new Error("System category not found");
      error.code = "CATEGORY_SYSTEM_MISSING";
      throw error;
    }
    return this.mergeSpendingCategories(
      workspaceId,
      {
        sourceCategoryIds: [categoryId],
        destinationCategoryId: other.rows[0].id,
        expectedVersions: {
          [categoryId]: expectedVersion,
          [other.rows[0].id]: Number(other.rows[0].version),
        },
        userId,
        operation: "delete",
      },
    );
  }

  async splitSpendingCategory(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      categoryId,
      expectedVersion,
      userId = null,
    },
  ) {
    let result;
    try {
      result = await this.#withTransaction(async (client) => {
        const currentResult = await client.query(
          `
            SELECT
              category.*,
              spending_category_name_for_id(
                category.workspace_id,
                category.merged_into_category_id
              ) AS merged_into_path
            FROM spending_categories category
            WHERE category.workspace_id = $1
              AND category.id = $2
            FOR UPDATE
          `,
          [workspaceId, categoryId],
        );
        const current = currentResult.rows[0];
        if (!current) return "not_found";
        if (!current.merged_into_category_id) return "not_merged";
        if (Number(current.version) !== Number(expectedVersion)) {
          return "stale";
        }

        const aliasConflict = await client.query(
          `
            SELECT active_category.id
            FROM spending_category_aliases source_alias
            JOIN spending_categories active_category
              ON active_category.workspace_id = source_alias.workspace_id
             AND active_category.normalized_name =
               source_alias.normalized_alias
             AND active_category.merged_into_category_id IS NULL
             AND active_category.id <> $2
            WHERE source_alias.workspace_id = $1
              AND source_alias.category_id = $2
            LIMIT 1
          `,
          [workspaceId, categoryId],
        );
        if (aliasConflict.rows[0]) return "conflict";

        let nextParentCategoryId = current.parent_category_id;
        if (nextParentCategoryId) {
          const activeParent = await client.query(
            `
              SELECT active_spending_category_id($1, $2) AS category_id
            `,
            [workspaceId, nextParentCategoryId],
          );
          nextParentCategoryId =
            activeParent.rows[0]?.category_id ?? null;
        }

        await client.query(
          `
            UPDATE spending_categories
            SET merged_into_category_id = NULL,
                parent_category_id = $3,
                version = version + 1,
                updated_by = $4,
                updated_at = now()
            WHERE workspace_id = $1
              AND id = $2
          `,
          [workspaceId, categoryId, nextParentCategoryId, userId],
        );
        const pathResult = await client.query(
          `
            SELECT spending_category_name_for_id($1, $2) AS path
          `,
          [workspaceId, categoryId],
        );
        const restoredPath = pathResult.rows[0].path;

        await client.query(
          `
            INSERT INTO spending_category_events (
              id, workspace_id, category_id, event_type, actor_id,
              before_value, after_value
            )
            VALUES (
              $1, $2, $3, 'split', $4,
              jsonb_build_object(
                'merged_into_category_id', $5::text,
                'merged_into_path', $6::text
              ),
              jsonb_build_object(
                'name', $7::text,
                'path', $8::text,
                'parent_category_id', $9::text
              )
            )
          `,
          [
            stableId("category-event", randomUUID()),
            workspaceId,
            categoryId,
            userId,
            current.merged_into_category_id,
            current.merged_into_path,
            current.name,
            restoredPath,
            nextParentCategoryId,
          ],
        );

        for (const table of [
          "categorization_overrides",
          "transaction_cleanup_rules",
        ]) {
          await client.query(
            `
              UPDATE ${table}
              SET category_primary = $3,
                  updated_at = now()
              WHERE workspace_id = $1
                AND category_id = $2
            `,
            [workspaceId, categoryId, restoredPath],
          );
        }
        await client.query(
          `
            UPDATE transaction_splits
            SET category = $3,
                updated_at = now()
            WHERE workspace_id = $1
              AND category_id = $2
          `,
          [workspaceId, categoryId, restoredPath],
        );

        const affected = await client.query(
          `
            SELECT transaction_id
            FROM transaction_effective_spending_categories
            WHERE workspace_id = $1
              AND category_id = $2
          `,
          [workspaceId, categoryId],
        );
        await this.#refreshTransactionSearchDocuments(
          client,
          workspaceId,
          affected.rows.map((row) => row.transaction_id),
        );
        return categoryId;
      });
    } catch (error) {
      if (error?.code === "23505") return { conflict: true };
      throw error;
    }
    if (result === "not_found") return null;
    if (result === "not_merged") return { notMerged: true };
    if (result === "stale") return { stale: true };
    if (result === "conflict") return { conflict: true };
    const categories = await this.listSpendingCategories(workspaceId, {
      includeMerged: true,
    });
    return categories.find((category) => category.id === result);
  }

  async listTransactionCategories(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { limit = 100 } = {},
  ) {
    const categories = await this.listSpendingCategories(workspaceId);
    return categories
      .slice(0, Math.max(1, Math.min(250, Number(limit) || 100)))
      .map((category) => category.path);

    /* c8 ignore start -- retained for old-schema test doubles */
    const result = await this.#client().query(
      `
        WITH base_categories AS (
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
            AND transaction_cleanup_rule_matches(
              rule.match_field,
              rule.match_mode,
              rule.normalized_match_value,
              t.normalized_merchant,
              t.normalized_name
            )
            AND transaction_cleanup_rule_amount_matches(
              rule.match_amount_operator,
              rule.match_amount_minor,
              t.amount_minor
            )
          ORDER BY
            (rule.match_mode = 'exact') DESC,
            (rule.match_amount_operator IS NOT NULL) DESC,
            (rule.match_field = 'normalized_merchant') DESC,
            length(rule.normalized_match_value) DESC,
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
            AND transaction_cleanup_rule_matches(
              rule.match_field,
              rule.match_mode,
              rule.normalized_match_value,
              original_transaction.normalized_merchant,
              original_transaction.normalized_name
            )
            AND transaction_cleanup_rule_amount_matches(
              rule.match_amount_operator,
              rule.match_amount_minor,
              original_transaction.amount_minor
            )
          ORDER BY
            (rule.match_mode = 'exact') DESC,
            (rule.match_amount_operator IS NOT NULL) DESC,
            (rule.match_field = 'normalized_merchant') DESC,
            length(rule.normalized_match_value) DESC,
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
            AND NOT EXISTS (
              SELECT 1
              FROM transaction_splits split_override
              WHERE split_override.workspace_id = t.workspace_id
                AND split_override.transaction_id = t.id
            )
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
        ),
        categories AS (
          SELECT category FROM base_categories
          UNION
          SELECT split.category
          FROM transaction_splits split
          JOIN transactions transaction
            ON transaction.workspace_id = split.workspace_id
           AND transaction.id = split.transaction_id
          WHERE split.workspace_id = $1
        )
        SELECT category
        FROM categories
        ORDER BY category
        LIMIT $2
      `,
      [workspaceId, Math.max(1, Math.min(250, Number(limit) || 100))],
    );
    return result.rows.map((row) => row.category);
    /* c8 ignore stop */
  }

  async getAccountSnapshots(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { startOn = null, endOn = null } = {},
  ) {
    const result = await this.#client().query(
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
    const result = await this.#client().query(
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
      vested_quantity:
        row.vested_quantity == null
          ? null
          : Number(row.vested_quantity),
      value_minor: integer(row.institution_value_minor),
      vested_value_minor: integer(row.vested_value_minor),
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
    const result = await this.#client().query(
      `
        SELECT
          s.*,
          sec.name,
          sec.ticker_symbol,
          sec.security_type,
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
      security_type: row.security_type,
      snapshot_on: String(row.snapshot_on),
      value_minor: integer(row.value_minor),
      quantity: Number(row.quantity),
      vested_quantity:
        row.vested_quantity == null
          ? null
          : Number(row.vested_quantity),
      vested_value_minor: integer(row.vested_value_minor),
      price_minor: integer(row.institution_price_minor),
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
    const result = await this.#client().query(
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
    await this.#withTransaction(async (client) => {
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
        const inheritedOverride = await client.query(
          `
            SELECT
              r.stream_type_override,
              r.override_source_finding_id,
              r.override_updated_by,
              r.override_updated_at
            FROM recurring_streams r
            WHERE r.workspace_id = $1
              AND r.stream_type_override IS NOT NULL
              AND (
                r.id = $2
                OR (
                  r.account_id IS NOT DISTINCT FROM $3
                  AND EXISTS (
                    SELECT 1
                    FROM recurring_stream_transactions rst
                    WHERE rst.stream_id = r.id
                      AND rst.transaction_id = ANY($4::text[])
                  )
                )
              )
            ORDER BY
              (r.id = $2) DESC,
              r.override_updated_at DESC NULLS LAST,
              r.updated_at DESC
            LIMIT 1
          `,
          [
            workspaceId,
            stream.id,
            stream.account_id,
            stream.transaction_ids ?? [],
          ],
        );
        const override = inheritedOverride.rows[0] ?? {};
        await client.query(
          `
            INSERT INTO recurring_streams (
              id, workspace_id, service_family, display_name, stream_type,
              cadence, account_id, expected_amount_minor, min_amount_minor,
              max_amount_minor, monthly_equivalent_minor, currency_code,
              first_seen_on, last_seen_on, next_expected_on,
              confidence_basis_points, status, classification_signals,
              stream_type_override, override_source_finding_id,
              override_updated_by, override_updated_at
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9,
              $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb,
              $19, $20, $21, $22
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
              classification_signals = EXCLUDED.classification_signals,
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
            JSON.stringify(stream.classification_signals ?? {}),
            override.stream_type_override ?? null,
            override.override_source_finding_id ?? null,
            override.override_updated_by ?? null,
            override.override_updated_at ?? null,
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

  async listRecurringPatternRules(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { activeOnly = false } = {},
  ) {
    const result = await this.#client().query(
      `
        SELECT *
        FROM recurring_pattern_rules
        WHERE workspace_id = $1
          AND ($2::boolean = false OR active = true)
        ORDER BY updated_at DESC, id
      `,
      [workspaceId, activeOnly],
    );
    return result.rows.map(mapRecurringPatternRule);
  }

  async getTransactionRecurringContext(
    workspaceId = DEFAULT_WORKSPACE_ID,
    transactionId,
  ) {
    const result = await this.#client().query(
      `
        SELECT
          t.id AS transaction_id,
          effective_treatment.effective_cash_flow_role
            AS cash_flow_role,
          a.active = true AND connection.status <> 'removed'
            AS account_active,
          COALESCE(
            NULLIF(btrim(t.normalized_merchant), ''),
            NULLIF(btrim(t.normalized_name), '')
          ) IS NOT NULL AS has_stable_identity,
          pattern.id AS pattern_id,
          pattern.stream_id AS pattern_stream_id,
          pattern.stream_type AS pattern_stream_type,
          pattern.cadence AS pattern_cadence,
          pattern.active AS pattern_active,
          pattern.updated_at AS pattern_updated_at,
          linked.id AS linked_stream_id,
          COALESCE(linked.stream_type_override, linked.stream_type)
            AS linked_stream_type,
          linked.cadence AS linked_cadence
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        JOIN finance_connections connection
          ON connection.id = a.connection_id
        LEFT JOIN transaction_effective_spending_treatments
          effective_treatment
          ON effective_treatment.workspace_id = t.workspace_id
         AND effective_treatment.transaction_id = t.id
        LEFT JOIN LATERAL (
          SELECT rule.*
          FROM recurring_pattern_rules rule
          WHERE rule.workspace_id = t.workspace_id
            AND rule.active = true
            AND rule.account_id = t.account_id
            AND rule.currency_code = t.currency_code
            AND CASE rule.match_field
              WHEN 'normalized_merchant'
                THEN rule.normalized_match_value = t.normalized_merchant
              WHEN 'normalized_name'
                THEN rule.normalized_match_value = t.normalized_name
              ELSE false
            END
            AND abs(
              rule.anchor_amount_minor - abs(t.amount_minor)
            ) <= greatest(
              200,
              round(rule.anchor_amount_minor * 0.2)
            )
          ORDER BY
            abs(rule.anchor_amount_minor - abs(t.amount_minor)),
            rule.updated_at DESC,
            rule.id
          LIMIT 1
        ) pattern ON true
        LEFT JOIN LATERAL (
          SELECT stream.*
          FROM recurring_stream_transactions occurrence
          JOIN recurring_streams stream
            ON stream.id = occurrence.stream_id
          WHERE occurrence.transaction_id = t.id
            AND stream.workspace_id = t.workspace_id
            AND stream.status IN ('active', 'resumed', 'irregular')
          ORDER BY
            (stream.id = pattern.stream_id) DESC,
            stream.updated_at DESC,
            stream.id
          LIMIT 1
        ) linked ON true
        WHERE t.workspace_id = $1 AND t.id = $2
        LIMIT 1
      `,
      [workspaceId, transactionId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      transaction_id: row.transaction_id,
      cash_flow_role: row.cash_flow_role ?? "spending",
      account_active: Boolean(row.account_active),
      has_stable_identity: Boolean(row.has_stable_identity),
      pattern: row.pattern_id
        ? {
            id: row.pattern_id,
            stream_id: row.pattern_stream_id,
            stream_type: row.pattern_stream_type,
            cadence: row.pattern_cadence,
            active: Boolean(row.pattern_active),
            updated_at: dateValue(row.pattern_updated_at),
          }
        : null,
      linked_stream: row.linked_stream_id
        ? {
            id: row.linked_stream_id,
            stream_type: row.linked_stream_type,
            cadence: row.linked_cadence,
          }
        : null,
    };
  }

  async upsertRecurringPatternRule(
    workspaceId = DEFAULT_WORKSPACE_ID,
    transactionId,
    {
      type,
      cadence,
      actorId = null,
    } = {},
  ) {
    return this.#withTransaction(async (client) => {
      const sourceResult = await client.query(
        `
          SELECT
            t.id,
            t.account_id,
            t.normalized_merchant,
            t.normalized_name,
            t.amount_minor,
            t.currency_code,
            a.active = true AND connection.status <> 'removed'
              AS account_active
          FROM transactions t
          JOIN accounts a ON a.id = t.account_id
          JOIN finance_connections connection
            ON connection.id = a.connection_id
          WHERE t.workspace_id = $1 AND t.id = $2
          FOR UPDATE OF t
        `,
        [workspaceId, transactionId],
      );
      const source = sourceResult.rows[0];
      if (!source) return null;
      if (!source.account_active) {
        throw new TypeError(
          "Recurring patterns require an active account",
        );
      }
      const matchField = source.normalized_merchant
        ? "normalized_merchant"
        : "normalized_name";
      const normalizedMatchValue =
        source[matchField]?.trim() ?? "";
      if (!normalizedMatchValue) {
        throw new TypeError(
          "Transaction has no stable merchant or statement match",
        );
      }
      const anchorAmountMinor = Math.abs(Number(source.amount_minor));
      const existingResult = await client.query(
        `
          SELECT *
          FROM recurring_pattern_rules
          WHERE workspace_id = $1
            AND account_id = $2
            AND match_field = $3
            AND normalized_match_value = $4
            AND currency_code = $5
            AND abs(anchor_amount_minor - $6::bigint) <= greatest(
              200,
              round(anchor_amount_minor * 0.2)
            )
          ORDER BY
            active DESC,
            abs(anchor_amount_minor - $6::bigint),
            updated_at DESC,
            id
          LIMIT 1
          FOR UPDATE
        `,
        [
          workspaceId,
          source.account_id,
          matchField,
          normalizedMatchValue,
          source.currency_code,
          anchorAmountMinor,
        ],
      );
      const existing = existingResult.rows[0];
      const id = existing?.id ?? randomUUID();
      const streamId =
        existing?.stream_id ??
        stableId("recurring", `manual:${id}`);
      const result = await client.query(
        `
          INSERT INTO recurring_pattern_rules (
            id, workspace_id, stream_id, source_transaction_id,
            account_id, match_field, normalized_match_value,
            anchor_amount_minor, currency_code, stream_type,
            cadence, active, created_by, updated_by
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11, true, $12, $12
          )
          ON CONFLICT (id) DO UPDATE SET
            source_transaction_id = EXCLUDED.source_transaction_id,
            anchor_amount_minor = EXCLUDED.anchor_amount_minor,
            stream_type = EXCLUDED.stream_type,
            cadence = EXCLUDED.cadence,
            active = true,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
          RETURNING *
        `,
        [
          id,
          workspaceId,
          streamId,
          source.id,
          source.account_id,
          matchField,
          normalizedMatchValue,
          anchorAmountMinor,
          source.currency_code,
          type,
          cadence,
          actorId,
        ],
      );
      await client.query(
        `
          UPDATE transactions
          SET recurring_needs_review = false,
              updated_at = now()
          WHERE workspace_id = $1 AND id = $2
        `,
        [workspaceId, transactionId],
      );
      return mapRecurringPatternRule(result.rows[0]);
    });
  }

  async deactivateRecurringPatternRule(
    workspaceId = DEFAULT_WORKSPACE_ID,
    transactionId,
    { actorId = null } = {},
  ) {
    return this.#withTransaction(async (client) => {
      const result = await client.query(
        `
          WITH source AS (
            SELECT *
            FROM transactions
            WHERE workspace_id = $1 AND id = $2
          ),
          selected AS (
            SELECT rule.id
            FROM recurring_pattern_rules rule
            JOIN source ON source.workspace_id = rule.workspace_id
            WHERE rule.active = true
              AND rule.account_id = source.account_id
              AND rule.currency_code = source.currency_code
              AND CASE rule.match_field
                WHEN 'normalized_merchant'
                  THEN rule.normalized_match_value =
                    source.normalized_merchant
                WHEN 'normalized_name'
                  THEN rule.normalized_match_value =
                    source.normalized_name
                ELSE false
              END
              AND abs(
                rule.anchor_amount_minor - abs(source.amount_minor)
              ) <= greatest(
                200,
                round(rule.anchor_amount_minor * 0.2)
              )
            ORDER BY
              abs(
                rule.anchor_amount_minor - abs(source.amount_minor)
              ),
              rule.updated_at DESC,
              rule.id
            LIMIT 1
          )
          UPDATE recurring_pattern_rules rule
          SET active = false,
              updated_by = $3,
              updated_at = now()
          FROM selected
          WHERE rule.id = selected.id
          RETURNING rule.*
        `,
        [workspaceId, transactionId, actorId],
      );
      const rule = result.rows[0];
      if (!rule) return null;
      await client.query(
        `
          UPDATE recurring_streams
          SET status = 'canceled',
              stream_type_override = NULL,
              override_source_finding_id = NULL,
              override_updated_by = $3,
              override_updated_at = now(),
              updated_at = now()
          WHERE workspace_id = $1 AND id = $2
        `,
        [workspaceId, rule.stream_id, actorId],
      );
      return mapRecurringPatternRule(rule);
    });
  }

  async listRecurringStreams(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { includeInactive = false } = {},
  ) {
    const result = await this.#client().query(
      `
        SELECT
          r.*,
          pattern.id AS manual_pattern_rule_id,
          a.name AS account_name,
          COALESCE(
            current_transaction.display_name,
            r.display_name
          ) AS current_display_name,
          current_transaction.category_primary
            AS current_category_primary,
          current_transaction.cash_flow_role
            AS current_cash_flow_role,
          last_payment.transaction_id AS last_transaction_id,
          last_payment.posted_on AS last_transaction_posted_on,
          last_payment.amount_minor AS last_transaction_amount_minor,
          last_payment.currency_code
            AS last_transaction_currency_code,
          pending_occurrence.transaction_id
            AS pending_transaction_id,
          pending_occurrence.posted_on
            AS pending_transaction_posted_on,
          pending_occurrence.authorized_at
            AS pending_transaction_authorized_at,
          pending_occurrence.amount_minor
            AS pending_transaction_amount_minor,
          pending_occurrence.currency_code
            AS pending_transaction_currency_code,
          COALESCE(
            stream_transactions.transaction_ids,
            '[]'::jsonb
          ) AS transaction_ids
        FROM recurring_streams r
        LEFT JOIN recurring_pattern_rules pattern
          ON pattern.workspace_id = r.workspace_id
         AND pattern.stream_id = r.id
         AND pattern.active = true
        LEFT JOIN accounts a ON a.id = r.account_id
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(
            rst.transaction_id
            ORDER BY t.posted_on, rst.transaction_id
          ) AS transaction_ids
          FROM recurring_stream_transactions rst
          JOIN transactions t ON t.id = rst.transaction_id
          WHERE rst.stream_id = r.id
        ) stream_transactions ON true
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(
              CASE
                WHEN metadata.display_name_overridden
                  THEN metadata.display_name
                ELSE COALESCE(
                  metadata.display_name,
                  cleanup_rule.display_name
                )
              END,
              t.merchant_name,
              t.name
            ) AS display_name,
            COALESCE(
              effective_category.category_name,
              effective_category.source_category_label,
              t.category_primary
            ) AS category_primary,
            effective_treatment.effective_cash_flow_role
              AS cash_flow_role
          FROM recurring_stream_transactions rst
          JOIN transactions t ON t.id = rst.transaction_id
          LEFT JOIN transaction_effective_spending_treatments
            effective_treatment
            ON effective_treatment.workspace_id = t.workspace_id
           AND effective_treatment.transaction_id = t.id
          LEFT JOIN transaction_metadata metadata
            ON metadata.workspace_id = t.workspace_id
           AND metadata.transaction_id = t.id
          LEFT JOIN transaction_effective_spending_categories
            effective_category
            ON effective_category.workspace_id = t.workspace_id
           AND effective_category.transaction_id = t.id
          LEFT JOIN LATERAL (
            SELECT rule.*
            FROM transaction_cleanup_rules rule
            WHERE rule.workspace_id = t.workspace_id
              AND rule.enabled = true
              AND transaction_cleanup_rule_matches(
                rule.match_field,
                rule.match_mode,
                rule.normalized_match_value,
                t.normalized_merchant,
                t.normalized_name
              )
              AND transaction_cleanup_rule_amount_matches(
                rule.match_amount_operator,
                rule.match_amount_minor,
                t.amount_minor
              )
            ORDER BY
            (rule.match_mode = 'exact') DESC,
            (rule.match_amount_operator IS NOT NULL) DESC,
            (rule.match_field = 'normalized_merchant') DESC,
              length(rule.normalized_match_value) DESC,
              rule.updated_at DESC,
              rule.id
            LIMIT 1
          ) cleanup_rule ON true
          WHERE rst.stream_id = r.id
          ORDER BY t.posted_on DESC, t.id DESC
          LIMIT 1
        ) current_transaction ON true
        LEFT JOIN LATERAL (
          SELECT
            t.id AS transaction_id,
            t.posted_on,
            t.amount_minor,
            t.currency_code
          FROM recurring_stream_transactions rst
          JOIN transactions t ON t.id = rst.transaction_id
          WHERE rst.stream_id = r.id
            AND t.pending = false
          ORDER BY t.posted_on DESC, t.id DESC
          LIMIT 1
        ) last_payment ON true
        LEFT JOIN LATERAL (
          SELECT
            pending_candidate.id AS transaction_id,
            pending_candidate.posted_on,
            pending_candidate.authorized_at,
            pending_candidate.amount_minor,
            pending_candidate.currency_code
          FROM transactions pending_candidate
          LEFT JOIN transaction_effective_spending_treatments
            pending_treatment
            ON pending_treatment.workspace_id =
                pending_candidate.workspace_id
           AND pending_treatment.transaction_id = pending_candidate.id
          WHERE pending_candidate.workspace_id = r.workspace_id
            AND pending_candidate.pending = true
            AND pending_candidate.account_id = r.account_id
            AND pending_candidate.currency_code = r.currency_code
            AND pending_candidate.amount_minor < 0
            AND COALESCE(
              pending_treatment.effective_cash_flow_role,
              pending_candidate.cash_flow_role
            ) <> 'transfer'
            AND r.next_expected_on IS NOT NULL
            AND pending_candidate.posted_on BETWEEN
              r.next_expected_on - CASE r.cadence
                WHEN 'weekly' THEN 3
                WHEN 'biweekly' THEN 5
                WHEN 'monthly' THEN 10
                WHEN 'quarterly' THEN 21
                WHEN 'annual' THEN 45
                ELSE 10
              END
              AND r.next_expected_on + CASE r.cadence
                WHEN 'weekly' THEN 3
                WHEN 'biweekly' THEN 5
                WHEN 'monthly' THEN 10
                WHEN 'quarterly' THEN 21
                WHEN 'annual' THEN 45
                ELSE 10
              END
            AND abs(
              abs(pending_candidate.amount_minor) -
                r.expected_amount_minor
            ) <= greatest(
              200,
              round(r.expected_amount_minor * 0.2)
            )
            AND (
              (
                pattern.id IS NOT NULL
                AND CASE pattern.match_field
                  WHEN 'normalized_merchant'
                    THEN pattern.normalized_match_value =
                      pending_candidate.normalized_merchant
                  WHEN 'normalized_name'
                    THEN pattern.normalized_match_value =
                      pending_candidate.normalized_name
                  ELSE false
                END
              )
              OR (
                pattern.id IS NULL
                AND EXISTS (
                  SELECT 1
                  FROM recurring_stream_transactions
                    identity_occurrence
                  JOIN transactions identity_transaction
                    ON identity_transaction.id =
                      identity_occurrence.transaction_id
                  WHERE identity_occurrence.stream_id = r.id
                    AND identity_transaction.pending = false
                    AND (
                      (
                        pending_candidate.normalized_merchant IS NOT NULL
                        AND pending_candidate.normalized_merchant =
                          identity_transaction.normalized_merchant
                      )
                      OR (
                        pending_candidate.normalized_name IS NOT NULL
                        AND pending_candidate.normalized_name =
                          identity_transaction.normalized_name
                      )
                    )
                )
              )
            )
          ORDER BY
            abs(pending_candidate.posted_on - r.next_expected_on),
            abs(
              abs(pending_candidate.amount_minor) -
                r.expected_amount_minor
            ),
            pending_candidate.created_at,
            pending_candidate.id
          LIMIT 1
        ) pending_occurrence ON true
        WHERE r.workspace_id = $1
          AND (
            $2::boolean
            OR r.status IN ('active', 'resumed', 'irregular')
          )
        ORDER BY
          r.monthly_equivalent_minor DESC,
          COALESCE(current_transaction.display_name, r.display_name)
      `,
      [workspaceId, includeInactive],
    );
    return result.rows.map(mapRecurring);
  }

  async updateRecurringClassification(
    workspaceId = DEFAULT_WORKSPACE_ID,
    streamId,
    {
      type,
      actorId = null,
      sourceFindingId = null,
    } = {},
  ) {
    if (
      !["subscription", "bill", "frequent_spending"].includes(type)
    ) {
      throw new TypeError("Invalid recurring classification");
    }
    return this.#withTransaction(async (client) => {
      if (type === "frequent_spending") {
        await client.query(
          `
            UPDATE recurring_pattern_rules
            SET active = false,
                updated_by = $3,
                updated_at = now()
            WHERE workspace_id = $1
              AND stream_id = $2
              AND active = true
          `,
          [workspaceId, streamId, actorId],
        );
      } else {
        await client.query(
          `
            UPDATE recurring_pattern_rules
            SET stream_type = $3,
                updated_by = $4,
                updated_at = now()
            WHERE workspace_id = $1
              AND stream_id = $2
              AND active = true
          `,
          [workspaceId, streamId, type, actorId],
        );
      }
      const result = await client.query(
        `
          UPDATE recurring_streams
          SET stream_type_override = $3,
              override_source_finding_id = $4,
              override_updated_by = $5,
              override_updated_at = now(),
              updated_at = now()
          WHERE workspace_id = $1 AND id = $2
          RETURNING *
        `,
        [workspaceId, streamId, type, sourceFindingId, actorId],
      );
      return result.rows[0] ? mapRecurring(result.rows[0]) : null;
    });
  }

  async clearRecurringClassificationFromFinding(
    workspaceId = DEFAULT_WORKSPACE_ID,
    findingId,
  ) {
    const result = await this.#client().query(
      `
        UPDATE recurring_streams
        SET stream_type_override = NULL,
            override_source_finding_id = NULL,
            override_updated_by = NULL,
            override_updated_at = NULL,
            updated_at = now()
        WHERE workspace_id = $1
          AND override_source_finding_id = $2
        RETURNING id
      `,
      [workspaceId, findingId],
    );
    return result.rows.map((row) => row.id);
  }

  async replaceInsightFindings(
    workspaceId = DEFAULT_WORKSPACE_ID,
    family,
    findings,
  ) {
    await this.#withTransaction(async (client) => {
      const preferenceResult = await client.query(
        `
          SELECT finding_key, disposition, reason_code, updated_by, updated_at
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
    const result = await this.#client().query(
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
    const result = await this.#client().query(
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

  async getInsightStorageSummary(
    workspaceId = DEFAULT_WORKSPACE_ID,
  ) {
    const result = await this.#client().query(
      `
        SELECT
          count(*) FILTER (
            WHERE is_current = true AND state = 'active'
          ) AS active_count,
          count(*) FILTER (
            WHERE is_current = false OR state <> 'active'
          ) AS archived_count,
          count(*) AS total_count,
          max(generated_at) AS last_findings_generated_at
        FROM insight_findings
        WHERE workspace_id = $1
      `,
      [workspaceId],
    );
    const row = result.rows[0] ?? {};
    return {
      active_count: Number(row.active_count ?? 0),
      archived_count: Number(row.archived_count ?? 0),
      total_count: Number(row.total_count ?? 0),
      last_findings_generated_at: dateValue(
        row.last_findings_generated_at,
      ),
    };
  }

  async getInsightSettings(
    workspaceId = DEFAULT_WORKSPACE_ID,
  ) {
    const result = await this.#client().query(
      `
        SELECT enabled, updated_by, updated_at
        FROM insight_settings
        WHERE workspace_id = $1
      `,
      [workspaceId],
    );
    return result.rows[0]
      ? mapInsightSettings(result.rows[0])
      : {
          enabled: true,
          updated_by: null,
          updated_at: null,
        };
  }

  async updateInsightSettings(
    workspaceId = DEFAULT_WORKSPACE_ID,
    { enabled, updatedBy = null },
  ) {
    const result = await this.#client().query(
      `
        INSERT INTO insight_settings (
          workspace_id,
          enabled,
          updated_by,
          updated_at
        )
        VALUES ($1, $2, $3, now())
        ON CONFLICT (workspace_id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()
        RETURNING enabled, updated_by, updated_at
      `,
      [workspaceId, enabled, updatedBy],
    );
    return mapInsightSettings(result.rows[0]);
  }

  async getInsightLlmSettings(
    workspaceId = DEFAULT_WORKSPACE_ID,
  ) {
    const result = await this.#client().query(
      `
        SELECT *
        FROM insight_llm_settings
        WHERE workspace_id = $1
      `,
      [workspaceId],
    );
    return result.rows[0]
      ? mapInsightLlmSettings(result.rows[0])
      : null;
  }

  async upsertInsightLlmSettings(
    workspaceId = DEFAULT_WORKSPACE_ID,
    {
      expectedRevision,
      baseGuidance,
      familyGuidance,
      candidateLimit,
      resultLimit,
      feedbackMode,
      feedbackLimit,
      contextLength,
      updatedBy = null,
    },
  ) {
    return this.#withTransaction(async (client) => {
      const currentResult = await client.query(
        `
          SELECT *
          FROM insight_llm_settings
          WHERE workspace_id = $1
        `,
        [workspaceId],
      );
      const currentRow = currentResult.rows[0] ?? null;
      const currentRevision = currentRow
        ? Number(currentRow.revision)
        : 0;
      if (currentRevision !== Number(expectedRevision)) {
        return {
          conflict: true,
          current: currentRow
            ? mapInsightLlmSettings(currentRow)
            : null,
        };
      }
      const params = [
        workspaceId,
        baseGuidance,
        JSON.stringify(familyGuidance),
        candidateLimit,
        resultLimit,
        feedbackMode,
        feedbackLimit,
        contextLength,
        updatedBy,
      ];
      const result = currentRow
        ? await client.query(
            `
              UPDATE insight_llm_settings
              SET revision = revision + 1,
                  base_guidance = $2,
                  family_guidance = $3::jsonb,
                  candidate_limit = $4,
                  result_limit = $5,
                  feedback_mode = $6,
                  feedback_limit = $7,
                  context_length = $8,
                  updated_by = $9,
                  updated_at = now()
              WHERE workspace_id = $1
                AND revision = $10
              RETURNING *
            `,
            [...params, expectedRevision],
          )
        : await client.query(
            `
              INSERT INTO insight_llm_settings (
                workspace_id,
                revision,
                base_guidance,
                family_guidance,
                candidate_limit,
                result_limit,
                feedback_mode,
                feedback_limit,
                context_length,
                updated_by
              )
              VALUES (
                $1, 1, $2, $3::jsonb, $4, $5, $6, $7,
                $8, $9
              )
              ON CONFLICT (workspace_id) DO NOTHING
              RETURNING *
            `,
            params,
          );
      if (!result.rows[0]) {
        const latest = await client.query(
          `
            SELECT *
            FROM insight_llm_settings
            WHERE workspace_id = $1
          `,
          [workspaceId],
        );
        return {
          conflict: true,
          current: latest.rows[0]
            ? mapInsightLlmSettings(latest.rows[0])
            : null,
        };
      }
      return {
        conflict: false,
        settings: mapInsightLlmSettings(result.rows[0]),
      };
    });
  }

  async listInsightLlmCallStatuses(
    workspaceId = DEFAULT_WORKSPACE_ID,
  ) {
    const result = await this.#client().query(
      `
        SELECT *
        FROM insight_llm_call_status
        WHERE workspace_id = $1
        ORDER BY
          CASE family
            WHEN 'weekly' THEN 0
            WHEN 'investments' THEN 1
            WHEN 'subscriptions' THEN 2
            ELSE 3
          END
      `,
      [workspaceId],
    );
    return result.rows.map(mapInsightLlmCallStatus);
  }

  async getInsightLlmCallStatuses(
    workspaceId = DEFAULT_WORKSPACE_ID,
  ) {
    return this.listInsightLlmCallStatuses(workspaceId);
  }

  async getInsightLlmCallStatus(
    workspaceId = DEFAULT_WORKSPACE_ID,
    family,
  ) {
    const result = await this.#client().query(
      `
        SELECT *
        FROM insight_llm_call_status
        WHERE workspace_id = $1 AND family = $2
      `,
      [workspaceId, family],
    );
    return result.rows[0]
      ? mapInsightLlmCallStatus(result.rows[0])
      : null;
  }

  async upsertInsightLlmCallStatus(
    workspaceId = DEFAULT_WORKSPACE_ID,
    telemetry,
  ) {
    const result = await this.#client().query(
      `
        INSERT INTO insight_llm_call_status (
          workspace_id,
          family,
          run_id,
          guidance_revision,
          model,
          status,
          estimated_input_tokens,
          prompt_tokens,
          completion_tokens,
          total_tokens,
          context_length,
          finish_reason,
          latency_ms,
          called_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13,
          COALESCE($14::timestamptz, now())
        )
        ON CONFLICT (workspace_id, family) DO UPDATE SET
          run_id = EXCLUDED.run_id,
          guidance_revision = EXCLUDED.guidance_revision,
          model = EXCLUDED.model,
          status = EXCLUDED.status,
          estimated_input_tokens = EXCLUDED.estimated_input_tokens,
          prompt_tokens = EXCLUDED.prompt_tokens,
          completion_tokens = EXCLUDED.completion_tokens,
          total_tokens = EXCLUDED.total_tokens,
          context_length = EXCLUDED.context_length,
          finish_reason = EXCLUDED.finish_reason,
          latency_ms = EXCLUDED.latency_ms,
          called_at = EXCLUDED.called_at
        WHERE insight_llm_call_status.called_at <= EXCLUDED.called_at
        RETURNING *
      `,
      [
        workspaceId,
        telemetry.family,
        telemetry.run_id ?? telemetry.runId,
        telemetry.guidance_revision ??
          telemetry.guidanceRevision ??
          0,
        telemetry.model,
        telemetry.status,
        telemetry.estimated_input_tokens ??
          telemetry.estimatedInputTokens ??
          0,
        telemetry.prompt_tokens ?? telemetry.promptTokens ?? null,
        telemetry.completion_tokens ??
          telemetry.completionTokens ??
          null,
        telemetry.total_tokens ?? telemetry.totalTokens ?? null,
        telemetry.context_length ??
          telemetry.contextLength ??
          null,
        telemetry.finish_reason ?? telemetry.finishReason ?? null,
        telemetry.latency_ms ?? telemetry.latencyMs ?? null,
        telemetry.called_at ?? telemetry.calledAt ?? null,
      ],
    );
    return result.rows[0]
      ? mapInsightLlmCallStatus(result.rows[0])
      : this.getInsightLlmCallStatus(workspaceId, telemetry.family);
  }

  async clearInsightOutput(
    workspaceId = DEFAULT_WORKSPACE_ID,
  ) {
    return this.#withTransaction(async (client) => {
      const searchDocuments = await client.query(
        `
          DELETE FROM search_documents
          WHERE workspace_id = $1 AND entity_type = 'insight'
        `,
        [workspaceId],
      );
      const narratives = await client.query(
        `
          DELETE FROM insight_narratives
          WHERE workspace_id = $1
        `,
        [workspaceId],
      );
      const findings = await client.query(
        `
          DELETE FROM insight_findings
          WHERE workspace_id = $1
        `,
        [workspaceId],
      );
      return {
        findings_deleted: findings.rowCount,
        narratives_deleted: narratives.rowCount,
        search_documents_deleted: searchDocuments.rowCount,
      };
    });
  }

  async getInsightRules(
    workspaceId = DEFAULT_WORKSPACE_ID,
    family = null,
  ) {
    const result = await this.#client().query(
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
      cashFlowRole = null,
      userId = null,
    },
  ) {
    return this.#withTransaction(async (client) => {
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
            category_detailed, category_overridden, category_updated_at,
            excluded_from_spending,
            excluded_from_spending_overridden,
            excluded_from_spending_updated_at,
            cash_flow_role, cash_flow_role_overridden,
            cash_flow_role_updated_at, created_by
          )
          VALUES (
            $1, $2, $3, $4, $5,
            ($4::text IS NOT NULL OR $5::text IS NOT NULL),
            CASE
              WHEN $4::text IS NOT NULL OR $5::text IS NOT NULL
                THEN now()
              ELSE NULL
            END,
            $6, ($6::boolean IS NOT NULL),
            CASE WHEN $6::boolean IS NOT NULL THEN now() ELSE NULL END,
            $7, ($7::text IS NOT NULL),
            CASE WHEN $7::text IS NOT NULL THEN now() ELSE NULL END,
            $8
          )
          ON CONFLICT (workspace_id, transaction_id)
            WHERE transaction_id IS NOT NULL
          DO UPDATE SET
            category_primary = COALESCE(
              EXCLUDED.category_primary,
              categorization_overrides.category_primary
            ),
            category_detailed = CASE
              WHEN EXCLUDED.category_primary IS NOT NULL
                THEN EXCLUDED.category_detailed
              ELSE categorization_overrides.category_detailed
            END,
            category_overridden = CASE
              WHEN EXCLUDED.category_overridden THEN true
              ELSE categorization_overrides.category_overridden
            END,
            category_updated_at = CASE
              WHEN EXCLUDED.category_overridden THEN now()
              ELSE categorization_overrides.category_updated_at
            END,
            excluded_from_spending = COALESCE(
              EXCLUDED.excluded_from_spending,
              categorization_overrides.excluded_from_spending
            ),
            excluded_from_spending_overridden = CASE
              WHEN EXCLUDED.excluded_from_spending_overridden THEN true
              ELSE categorization_overrides.excluded_from_spending_overridden
            END,
            excluded_from_spending_updated_at = CASE
              WHEN EXCLUDED.excluded_from_spending_overridden THEN now()
              ELSE categorization_overrides.excluded_from_spending_updated_at
            END,
            cash_flow_role = COALESCE(
              EXCLUDED.cash_flow_role,
              categorization_overrides.cash_flow_role
            ),
            cash_flow_role_overridden = CASE
              WHEN EXCLUDED.cash_flow_role_overridden THEN true
              ELSE categorization_overrides.cash_flow_role_overridden
            END,
            cash_flow_role_updated_at = CASE
              WHEN EXCLUDED.cash_flow_role_overridden THEN now()
              ELSE categorization_overrides.cash_flow_role_updated_at
            END,
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
          cashFlowRole ??
            (excludedFromSpending == null
              ? null
              : excludedFromSpending
                ? "transfer"
                : "spending"),
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
    const result = await this.#client().query(
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
    const result = await this.#client().query(
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
    { action, actorId = null, reasonCode = null } = {},
  ) {
    const targetStates = {
      archive: "archived",
      mark_bad: "bad",
      report_incorrect: "bad",
      restore: "active",
      dismiss: "dismissed",
      ignore: "dismissed",
      mark_expected: "resolved",
      confirm: "resolved",
    };
    if (action !== "delete" && !targetStates[action]) {
      throw new TypeError("Unsupported insight transition");
    }
    const allowedReasons = new Set([
      "not_subscription",
      "wrong_data",
      "wrong_interpretation",
      "other_false_positive",
    ]);
    const normalizedReason =
      ["mark_bad", "report_incorrect"].includes(action)
        ? reasonCode ?? "other_false_positive"
        : null;
    if (normalizedReason && !allowedReasons.has(normalizedReason)) {
      throw new TypeError("Unsupported insight feedback reason");
    }

    return this.#withTransaction(async (client) => {
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
            finding_type, action, from_state, to_state, actor_id,
            reason_code
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
          )
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
          normalizedReason,
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
        [
          "mark_bad",
          "report_incorrect",
          "dismiss",
          "ignore",
          "mark_expected",
          "confirm",
        ].includes(action)
      ) {
        await client.query(
          `
            INSERT INTO insight_finding_preferences (
              workspace_id, finding_key, disposition, reason_code,
              updated_by
            )
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (workspace_id, finding_key) DO UPDATE SET
              disposition = EXCLUDED.disposition,
              reason_code = EXCLUDED.reason_code,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()
          `,
          [
            workspaceId,
            row.finding_key ?? row.id,
            targetState,
            normalizedReason,
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

  async batchTransitionInsightFindings(
    workspaceId = DEFAULT_WORKSPACE_ID,
    findingIds,
    { action, actorId = null, reasonCode = null } = {},
  ) {
    const targetStates = {
      archive: "archived",
      ignore: "dismissed",
      report_incorrect: "bad",
      restore: "active",
    };
    const targetState = targetStates[action];
    if (!targetState) {
      throw new TypeError("Unsupported bulk insight transition");
    }
    const allowedReasons = new Set([
      "not_subscription",
      "wrong_data",
      "wrong_interpretation",
      "other_false_positive",
    ]);
    const normalizedReason =
      action === "report_incorrect" ? reasonCode : null;
    if (
      action === "report_incorrect" &&
      !allowedReasons.has(normalizedReason)
    ) {
      throw new TypeError("Unsupported insight feedback reason");
    }
    if (action !== "report_incorrect" && reasonCode != null) {
      throw new TypeError(
        "reasonCode is only supported for incorrect insights",
      );
    }

    const ids = [...new Set(findingIds)];
    if (!ids.length || ids.length !== findingIds.length) {
      throw new TypeError(
        "findingIds must contain unique insight finding IDs",
      );
    }

    return this.#withTransaction(async (client) => {
      const existing = await client.query(
        `
          SELECT *
          FROM insight_findings
          WHERE workspace_id = $1
            AND id = ANY($2::text[])
          ORDER BY id
          FOR UPDATE
        `,
        [workspaceId, ids],
      );
      if (existing.rows.length !== ids.length) return null;

      const recurringStreamIds = (row) =>
        (Array.isArray(row.evidence) ? row.evidence : [])
          .filter((entry) =>
            ["recurring", "recurring_stream"].includes(
              entry?.entity_type,
            ),
          )
          .map((entry) => entry.entity_id)
          .filter(Boolean);

      if (normalizedReason === "not_subscription") {
        const incompatibleFindingIds = existing.rows
          .filter(
            (row) =>
              row.family !== "subscriptions" ||
              recurringStreamIds(row).length === 0,
          )
          .map((row) => row.id);
        if (incompatibleFindingIds.length) {
          return { incompatibleFindingIds };
        }
      }

      if (action === "report_incorrect") {
        const duplicateStreamIds = [
          ...new Set(
            existing.rows
              .filter(
                (row) => row.finding_type === "possible_duplicate",
              )
              .flatMap(recurringStreamIds),
          ),
        ];
        if (duplicateStreamIds.length) {
          await client.query(
            `
              UPDATE recurring_streams
              SET duplicate_state = 'not_duplicate',
                  updated_at = now()
              WHERE workspace_id = $1
                AND id = ANY($2::text[])
            `,
            [workspaceId, duplicateStreamIds],
          );
        }

        if (normalizedReason === "not_subscription") {
          for (const row of existing.rows) {
            await client.query(
              `
                UPDATE recurring_streams
                SET stream_type_override = 'frequent_spending',
                    override_source_finding_id = $3,
                    override_updated_by = $4,
                    override_updated_at = now(),
                    updated_at = now()
                WHERE workspace_id = $1
                  AND id = ANY($2::text[])
              `,
              [
                workspaceId,
                recurringStreamIds(row),
                row.id,
                actorId,
              ],
            );
          }
        }
      }

      for (const row of existing.rows) {
        await client.query(
          `
            INSERT INTO insight_finding_events (
              id, workspace_id, finding_id, finding_key, family,
              finding_type, action, from_state, to_state, actor_id,
              reason_code
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
            )
          `,
          [
            randomUUID(),
            workspaceId,
            row.id,
            row.finding_key ?? row.id,
            row.family,
            row.finding_type,
            action,
            row.state,
            targetState,
            actorId,
            normalizedReason,
          ],
        );
      }

      const findingKeys = existing.rows.map(
        (row) => row.finding_key ?? row.id,
      );
      if (action === "restore") {
        await client.query(
          `
            DELETE FROM insight_finding_preferences
            WHERE workspace_id = $1
              AND finding_key = ANY($2::text[])
          `,
          [workspaceId, findingKeys],
        );
        await client.query(
          `
            UPDATE recurring_streams
            SET stream_type_override = NULL,
                override_source_finding_id = NULL,
                override_updated_by = NULL,
                override_updated_at = NULL,
                updated_at = now()
            WHERE workspace_id = $1
              AND override_source_finding_id = ANY($2::text[])
          `,
          [workspaceId, ids],
        );
      } else if (
        ["ignore", "report_incorrect"].includes(action)
      ) {
        for (const row of existing.rows) {
          await client.query(
            `
              INSERT INTO insight_finding_preferences (
                workspace_id, finding_key, disposition, reason_code,
                updated_by
              )
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT (workspace_id, finding_key) DO UPDATE SET
                disposition = EXCLUDED.disposition,
                reason_code = EXCLUDED.reason_code,
                updated_by = EXCLUDED.updated_by,
                updated_at = now()
            `,
            [
              workspaceId,
              row.finding_key ?? row.id,
              targetState,
              normalizedReason,
              actorId,
            ],
          );
        }
      }

      const updated = await client.query(
        `
          UPDATE insight_findings
          SET state = $3,
              state_changed_at = now(),
              state_changed_by = $4
          WHERE workspace_id = $1
            AND id = ANY($2::text[])
          RETURNING *
        `,
        [workspaceId, ids, targetState, actorId],
      );
      const updatedById = new Map(
        updated.rows.map((row) => [row.id, mapInsightFinding(row)]),
      );
      return {
        updatedFindings: ids
          .map((id) => updatedById.get(id))
          .filter(Boolean),
      };
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
      this.#client().query(
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
                WHEN 'mark_bad' THEN COALESCE(
                  e.reason_code,
                  'other_false_positive'
                )
                WHEN 'report_incorrect' THEN COALESCE(
                  e.reason_code,
                  'other_false_positive'
                )
                WHEN 'dismiss' THEN 'ignored'
                WHEN 'ignore' THEN 'ignored'
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
              'report_incorrect',
              'dismiss',
              'ignore',
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
      this.#client().query(
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
    const result = await this.#client().query(
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
      guidanceRevision = 0,
      promptHash = "legacy",
      model = "legacy",
      presentation = null,
      headline = presentation?.headline,
      bullets = presentation?.bullets,
      findingIds = presentation?.findingIds,
    },
  ) {
    await this.#client().query(
      `
        INSERT INTO insight_narratives (
          id, workspace_id, family, findings_hash,
          guidance_revision, prompt_hash, model,
          headline, bullets, finding_ids
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9::jsonb, $10::jsonb
        )
        ON CONFLICT (
          workspace_id,
          family,
          findings_hash,
          guidance_revision,
          prompt_hash,
          model
        ) DO UPDATE SET
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
        guidanceRevision,
        promptHash,
        model,
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
    const result = await this.#client().query(
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
          guidance_revision: Number(row.guidance_revision ?? 0),
          prompt_hash: row.prompt_hash ?? "legacy",
          model: row.model ?? "legacy",
        }
      : null;
  }

  async getDataFreshness(workspaceId = DEFAULT_WORKSPACE_ID) {
    const result = await this.#client().query(
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
    const result = await this.#client().query(
      `
        WITH search_settings AS MATERIALIZED (
          SELECT set_config(
            'pg_trgm.similarity_threshold',
            '0.2',
            true
          ) AS similarity_threshold
        ),
        split_matches AS (
          SELECT DISTINCT split.transaction_id
          FROM transaction_splits split
          WHERE split.workspace_id = $1
            AND lower(regexp_replace(
              concat_ws(
                ' ',
                spending_category_name_for_id(
                  split.workspace_id,
                  split.category_id
                ),
                split.category
              ),
              '[^[:alnum:]]+',
              ' ',
              'g'
            )) LIKE '%' || $2 || '%'
        ),
        candidates AS (
          SELECT
            entity_type, entity_id, title, subtitle, metadata,
            CASE
              WHEN normalized_text = $2 THEN 4
              WHEN normalized_text LIKE $2 || '%' THEN 3
              WHEN search_vector @@ plainto_tsquery('simple', $2) THEN 2
              ELSE 1
            END AS match_tier,
            similarity(normalized_text, $2) AS similarity_score
          FROM search_documents
          WHERE workspace_id = $1
            AND ($3::text[] IS NULL OR entity_type = ANY($3))
            AND (
              normalized_text LIKE $2 || '%'
              OR search_vector @@ plainto_tsquery('simple', $2)
              OR normalized_text % (
                SELECT $2
                FROM search_settings
                WHERE similarity_threshold = '0.2'
              )
            )

          UNION ALL

          SELECT
            document.entity_type,
            document.entity_id,
            document.title,
            document.subtitle,
            document.metadata,
            2 AS match_tier,
            similarity(document.normalized_text, $2) AS similarity_score
          FROM split_matches split
          JOIN search_documents document
            ON document.workspace_id = $1
           AND document.entity_type = 'transaction'
           AND document.entity_id = split.transaction_id
          WHERE ($3::text[] IS NULL OR document.entity_type = ANY($3))
            AND NOT (
              document.normalized_text LIKE $2 || '%'
              OR document.search_vector @@ plainto_tsquery('simple', $2)
              OR document.normalized_text % (
                SELECT $2
                FROM search_settings
                WHERE similarity_threshold = '0.2'
              )
            )
        )
        SELECT entity_type, entity_id, title, subtitle, metadata
        FROM candidates
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
    await this.#withTransaction(async (client) => {
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
            r.display_name,
            concat_ws(
              ' · ',
              r.cadence,
              COALESCE(r.stream_type_override, r.stream_type)
            ),
            concat_ws(
              ' ',
              r.display_name,
              r.service_family,
              r.cadence,
              COALESCE(r.stream_type_override, r.stream_type)
            ),
            lower(regexp_replace(
              concat_ws(
                ' ',
                r.display_name,
                r.service_family,
                r.cadence,
                COALESCE(r.stream_type_override, r.stream_type)
              ),
              '[^[:alnum:]]+', ' ', 'g'
            )),
            jsonb_build_object(
              'monthly_equivalent_minor',
              r.monthly_equivalent_minor,
              'type',
              COALESCE(r.stream_type_override, r.stream_type)
            )
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
    await this.#client().query(
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
    await this.#client().query(
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
    coverage_warnings: row.coverage_warnings ?? [],
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
    connection_status: row.connection_status ?? null,
    connection_error_code: row.connection_error_code ?? null,
    connection_coverage_warnings:
      row.connection_coverage_warnings ?? [],
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

function mapTransaction(
  row,
  { includeProviderLocation = false } = {},
) {
  const projectedSplitCategory = row.split_category ?? null;
  const providerAmountMinor = integer(row.amount_minor);
  const effectiveCashFlowRole =
    row.effective_cash_flow_role ??
    row.cash_flow_role ??
    (row.effective_excluded_from_spending ?? row.excluded_from_spending
      ? "transfer"
      : "spending");
  return {
    id: row.id,
    provider_transaction_id: row.provider_transaction_id ?? null,
    account_id: row.account_id,
    account_name: row.account_name,
    account_mask: row.account_mask,
    institution_name: row.institution_name,
    ...(includeProviderLocation
      ? { provider_location: row.provider_location ?? null }
      : {}),
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
    note: row.note ?? null,
    note_version: integer(row.note_version) ?? 0,
    note_updated_by: row.note_updated_by ?? null,
    note_updated_at: dateValue(row.note_updated_at),
    budget_month_on:
      row.budget_month_on == null
        ? null
        : String(row.budget_month_on),
    tags: Array.isArray(row.tags) ? row.tags : [],
    category_id:
      row.split_category_id ??
      row.category_id ??
      null,
    category_primary:
      projectedSplitCategory ??
      row.effective_category_primary ??
      row.category_primary ??
      null,
    category_detailed:
      projectedSplitCategory == null
        ? row.effective_category_detailed ?? row.category_detailed ?? null
        : null,
    original_category_primary: row.category_primary ?? null,
    original_category_detailed: row.category_detailed ?? null,
    amount_minor:
      integer(row.split_category_amount_minor) ?? providerAmountMinor,
    provider_amount_minor: providerAmountMinor,
    is_split_category_projection: projectedSplitCategory != null,
    split_category_line_count:
      projectedSplitCategory == null
        ? 0
        : Number(row.split_category_line_count ?? 0),
    currency_code: row.currency_code,
    authorized_at: dateValue(row.authorized_at),
    posted_at: dateValue(row.posted_at),
    posted_on: String(row.posted_on),
    pending: row.pending,
    cash_flow_role: effectiveCashFlowRole,
    excluded_from_spending:
      row.effective_excluded_from_spending ??
      effectiveCashFlowRole !== "spending",
    is_fixed: row.is_fixed ?? false,
    original_transaction_id: row.original_transaction_id ?? null,
    payment_channel: row.payment_channel,
    split_version: Number(row.split_version ?? 0),
    split_needs_review: Boolean(row.split_needs_review),
    recurring_needs_review: Boolean(row.recurring_needs_review),
    goal_spend_version: Number(row.goal_spend_version ?? 0),
  };
}

function mapTransactionSplit(row) {
  return {
    id: row.id,
    transaction_id: row.transaction_id,
    split_version: Number(row.split_version ?? 0),
    line_index: Number(row.line_index),
    category_id:
      row.resolved_category_id ??
      row.category_id ??
      null,
    category:
      row.resolved_category ??
      row.category,
    amount_minor: integer(row.amount_minor),
    note: row.note ?? null,
    is_fixed: Boolean(row.is_fixed),
    created_by: row.created_by ?? null,
    created_at: dateValue(row.created_at),
    updated_at: dateValue(row.updated_at),
  };
}

function mapSpendingCategory(row) {
  const aliases = Array.isArray(row.aliases)
    ? row.aliases
    : typeof row.aliases === "string"
      ? JSON.parse(row.aliases)
      : [];
  const path = row.path ?? row.name;
  return {
    id: row.id,
    name: row.name,
    path,
    depth: Math.max(0, String(path).split(" / ").length - 1),
    classification: row.classification,
    parent_category_id: row.parent_category_id ?? null,
    merged_into_category_id: row.merged_into_category_id ?? null,
    merged_into_path: row.merged_into_path ?? null,
    merged_into_is_system: Boolean(row.merged_into_is_system),
    is_system: Boolean(row.is_system),
    status: row.merged_into_category_id
      ? row.merged_into_is_system
        ? "deleted"
        : "merged"
      : "active",
    version: Number(row.version),
    transaction_count: Number(row.transaction_count ?? 0),
    budget_line_count: Number(row.budget_line_count ?? 0),
    aliases,
    created_at: dateValue(row.created_at),
    updated_at: dateValue(row.updated_at),
  };
}

function mergedBudgetTimeline(categoryIds, rows) {
  const ids = new Set(categoryIds);
  const byDate = new Map();
  for (const row of rows) {
    if (!ids.has(row.category_id)) continue;
    const date = String(row.effective_month_on);
    const entries = byDate.get(date) ?? [];
    entries.push(row);
    byDate.set(date, entries);
  }
  const current = new Map();
  const timeline = [];
  for (const date of [...byDate.keys()].sort()) {
    for (const row of byDate.get(date)) {
      current.set(row.category_id, {
        amountMinor: Number(row.amount_minor),
        currencyCode: row.currency_code,
        trackingMode: row.tracking_mode ?? "tracked",
        isRemoved: Boolean(row.is_removed),
      });
    }
    const values = [...current.values()].filter(
      (value) => !value.isRemoved,
    );
    const currencyCode = values[0]?.currencyCode ?? "USD";
    const amountMinor = values.reduce(
      (sum, value) => sum + value.amountMinor,
      0,
    );
    const trackingMode =
      values.length > 0 &&
      values.every(
        (value) => value.trackingMode === "informational",
      )
        ? "informational"
        : "tracked";
    const isRemoved = values.length === 0;
    const previous = timeline.at(-1);
    if (
      previous &&
      previous.amountMinor === amountMinor &&
      previous.currencyCode === currencyCode &&
      previous.trackingMode === trackingMode &&
      previous.isRemoved === isRemoved
    ) {
      continue;
    }
    timeline.push({
      effectiveMonthOn: date,
      amountMinor,
      currencyCode,
      trackingMode,
      isRemoved,
    });
  }
  return timeline;
}

function mapTransactionCleanupRule(row) {
  return {
    id: row.id,
    match_field: row.match_field,
    match_mode: row.match_mode ?? "exact",
    match_value: row.match_value,
    normalized_match_value: row.normalized_match_value,
    match_amount_operator: row.match_amount_operator ?? null,
    match_amount_minor: integer(row.match_amount_minor),
    display_name: row.display_name ?? null,
    category_id:
      row.resolved_category_id ??
      row.category_id ??
      null,
    category_primary:
      row.resolved_category ??
      row.category_primary ??
      null,
    cash_flow_role: row.cash_flow_role ?? null,
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

function mapPendingEditRecovery(row) {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    account_id: row.account_id,
    account_name: row.account_name ?? null,
    account_mask: row.account_mask ?? null,
    institution_name: row.institution_name ?? null,
    pending_transaction_id: row.pending_transaction_id,
    provider_pending_transaction_id:
      row.provider_pending_transaction_id,
    user_state: jsonObject(row.user_state),
    provider_facts: jsonObject(row.provider_facts),
    pending_created_at: dateValue(row.pending_created_at),
    pending_updated_at: dateValue(row.pending_updated_at),
    recovered_at: dateValue(row.recovered_at),
    updated_at: dateValue(row.updated_at),
    attached_transaction_id: row.attached_transaction_id ?? null,
    attached_at: dateValue(row.attached_at),
    attached_by: row.attached_by ?? null,
    dismissed_at: dateValue(row.dismissed_at),
    dismissed_by: row.dismissed_by ?? null,
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

function mapInsightSettings(row) {
  return {
    enabled: row.enabled !== false,
    updated_by: row.updated_by ?? null,
    updated_at: dateValue(row.updated_at),
  };
}

function mapInsightLlmSettings(row) {
  const familyGuidance =
    typeof row.family_guidance === "string"
      ? JSON.parse(row.family_guidance)
      : row.family_guidance;
  return {
    revision: Number(row.revision),
    base_guidance: row.base_guidance,
    family_guidance: {
      weekly: familyGuidance?.weekly ?? "",
      investments: familyGuidance?.investments ?? "",
      subscriptions: familyGuidance?.subscriptions ?? "",
    },
    candidate_limit: Number(row.candidate_limit),
    result_limit: Number(row.result_limit),
    feedback_mode: row.feedback_mode,
    feedback_limit: Number(row.feedback_limit),
    context_length: integer(row.context_length),
    updated_by: row.updated_by ?? null,
    updated_at: dateValue(row.updated_at),
  };
}

function mapInsightLlmCallStatus(row) {
  return {
    family: row.family,
    run_id: row.run_id,
    guidance_revision: Number(row.guidance_revision),
    model: row.model,
    status: row.status,
    estimated_input_tokens: Number(row.estimated_input_tokens),
    prompt_tokens: integer(row.prompt_tokens),
    completion_tokens: integer(row.completion_tokens),
    total_tokens: integer(row.total_tokens),
    context_length: integer(row.context_length),
    finish_reason: row.finish_reason ?? null,
    latency_ms: integer(row.latency_ms),
    called_at: dateValue(row.called_at),
  };
}

function mapRecurringPatternRule(row) {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    stream_id: row.stream_id,
    source_transaction_id: row.source_transaction_id ?? null,
    account_id: row.account_id,
    match_field: row.match_field,
    normalized_match_value: row.normalized_match_value,
    anchor_amount_minor: integer(row.anchor_amount_minor),
    currency_code: row.currency_code,
    stream_type: row.stream_type,
    cadence: row.cadence,
    active: Boolean(row.active),
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: dateValue(row.created_at),
    updated_at: dateValue(row.updated_at),
  };
}

function mapRecurring(row) {
  const detectedType = row.stream_type;
  const effectiveType = row.stream_type_override ?? detectedType;
  return {
    id: row.id,
    service_family: row.service_family,
    display_name: row.current_display_name ?? row.display_name,
    category_primary: row.current_category_primary ?? null,
    cash_flow_role: row.current_cash_flow_role ?? null,
    last_transaction: row.last_transaction_id
      ? {
          id: row.last_transaction_id,
          posted_on: String(row.last_transaction_posted_on),
          amount_minor: integer(row.last_transaction_amount_minor),
          currency_code:
            row.last_transaction_currency_code ?? row.currency_code,
        }
      : null,
    pending_transaction: row.pending_transaction_id
      ? {
          id: row.pending_transaction_id,
          posted_on: String(row.pending_transaction_posted_on),
          authorized_at: dateValue(
            row.pending_transaction_authorized_at,
          ),
          amount_minor: integer(
            row.pending_transaction_amount_minor,
          ),
          currency_code:
            row.pending_transaction_currency_code ?? row.currency_code,
        }
      : null,
    stream_type: effectiveType,
    detected_stream_type: detectedType,
    stream_type_override: row.stream_type_override ?? null,
    classification_signals: row.classification_signals ?? {},
    manual_pattern_rule_id:
      row.manual_pattern_rule_id ??
      row.classification_signals?.manual_pattern_rule_id ??
      null,
    override_source_finding_id:
      row.override_source_finding_id ?? null,
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
