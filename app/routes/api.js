import { Router } from "express";
import { readAppleCardMultipart } from "./appleCardMultipart.js";

const TOOL_ROUTES = Object.freeze([
  ["overview", "getFinanceOverview"],
  ["insights", "getFinanceInsights"],
  ["accounts", "listAccounts"],
  ["transactions", "listTransactions"],
  ["spending", "getSpendingSummary"],
  ["cash-flow", "getCashFlow"],
  ["recurring", "listRecurringPayments"],
  ["net-worth", "getNetWorthHistory"],
  ["portfolio", "getPortfolioSummary"],
]);
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

function unavailable(response, capability) {
  response.status(503).json({
    error: "capability_unavailable",
    message: `${capability} is unavailable until the database-backed service is configured.`,
  });
}

function stringValue(value, maximum = 200) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function booleanValue(value) {
  return value === true || value === "true" || value === "1";
}

function safeQuery(query) {
  return Object.fromEntries(
    Object.entries(query)
      .filter(([, value]) => typeof value === "string")
      .map(([key, value]) => [key, value.slice(0, 512)]),
  );
}

function integerValue(value, { minimum = 1, maximum = 500 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return undefined;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function exactInteger(value, { minimum = 0 } = {}) {
  if (value === "" || value === null || value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) return undefined;
  return parsed;
}

function signedIntegerValue(value) {
  if (value === "" || value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function currencyValue(value) {
  const currency = stringValue(value, 3)?.toUpperCase();
  return currency && /^[A-Z]{3}$/.test(currency) ? currency : undefined;
}

function dateValue(value) {
  const date = stringValue(value, 10);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
    ? undefined
    : date;
}

function invalidRequest(response, message) {
  response.status(400).json({
    error: "invalid_request",
    message,
  });
}

function creditScoreSourceInput(body, { partial = false } = {}) {
  const input = {};
  if (Object.hasOwn(body ?? {}, "label")) {
    const label =
      typeof body.label === "string" ? body.label.trim() : "";
    if (!label || label.length > 120) return null;
    input.label = label;
  }
  for (const field of ["bureau", "model"]) {
    if (!Object.hasOwn(body ?? {}, field)) continue;
    if (body[field] == null || String(body[field]).trim() === "") {
      input[field] = null;
      continue;
    }
    if (typeof body[field] !== "string") return null;
    const value = body[field].trim();
    if (!value || value.length > 80) return null;
    input[field] = value;
  }
  if ((!partial && !input.label) || Object.keys(input).length === 0) {
    return null;
  }
  return input;
}

function apiInput(path, query) {
  const values = safeQuery(query);
  const commonPeriod = {
    startOn: stringValue(values.start_on, 10),
    endOn: stringValue(values.end_on, 10),
  };
  if (path === "overview") {
    return { asOf: stringValue(values.as_of, 40) };
  }
  if (path === "insights") {
    return {
      section: stringValue(values.section, 20) || "all",
      asOf: stringValue(values.as_of, 40),
      limitPerSection: integerValue(values.limit_per_section, {
        maximum: 25,
      }),
    };
  }
  if (path === "accounts") {
    return {
      accountType: stringValue(values.account_type, 40) || "all",
      institutionId: stringValue(values.institution_id, 128),
      balanceGroup: stringValue(values.balance_group, 32),
      includeClosed: booleanValue(values.include_closed),
      limit: integerValue(values.limit, { maximum: 100 }),
      cursor: stringValue(values.cursor, 512),
    };
  }
  if (path === "transactions") {
    return {
      ...commonPeriod,
      accountId: stringValue(values.account_id, 128),
      category: stringValue(values.category, 100),
      search: stringValue(values.search, 120),
      status: stringValue(values.status, 20) || "all",
      minAmountMinor: signedIntegerValue(values.min_amount_minor),
      maxAmountMinor: signedIntegerValue(values.max_amount_minor),
      includePending:
        values.include_pending === undefined
          ? true
          : booleanValue(values.include_pending),
      limit: integerValue(values.limit, { maximum: 200 }),
      cursor: stringValue(values.cursor, 512),
    };
  }
  if (path === "spending") {
    return {
      ...commonPeriod,
      period: stringValue(values.period, 20) || "month",
      previousStartOn: stringValue(values.previous_start_on, 10),
      groupBy: stringValue(values.group_by, 20) || "category",
      accountId: stringValue(values.account_id, 128),
      category: stringValue(values.category, 100),
      segmentLimit: integerValue(values.segment_limit, { maximum: 30 }),
    };
  }
  if (path === "cash-flow") {
    return {
      ...commonPeriod,
      period: stringValue(values.period, 20) || "month",
      interval: stringValue(values.interval, 12) || "week",
      accountId: stringValue(values.account_id, 128),
      category: stringValue(values.category, 100),
      search: stringValue(values.search, 120),
    };
  }
  if (path === "recurring") {
    return {
      kind: stringValue(values.kind, 20) || "all",
      type: stringValue(values.type, 20) || "all",
      cadence: stringValue(values.cadence, 20) || "all",
      status: stringValue(values.status, 20) || "active",
      includeInactive: booleanValue(values.include_inactive),
      limit: integerValue(values.limit, { maximum: 100 }),
      cursor: stringValue(values.cursor, 512),
    };
  }
  if (path === "net-worth") {
    return {
      ...commonPeriod,
      interval: stringValue(values.interval, 20) || "week",
      limit: integerValue(values.limit, { maximum: 366 }),
    };
  }
  if (path === "portfolio") {
    return {
      ...commonPeriod,
      period: stringValue(values.period, 20) || "1m",
      accountId: stringValue(values.account_id, 128),
      scope: stringValue(values.scope, 20),
      retirementScope: stringValue(values.retirement_scope, 20),
      holdingsLimit: integerValue(values.holdings_limit, {
        maximum: 100,
      }),
    };
  }
  return {};
}

function invoke(service, method, input, response, next) {
  if (typeof service?.[method] !== "function") {
    unavailable(response, "Finance data");
    return;
  }
  Promise.resolve(service[method](input))
    .then((result) => response.json(result))
    .catch(next);
}

function invokeWithActor(
  service,
  method,
  input,
  actor,
  response,
  next,
) {
  if (typeof service?.[method] !== "function") {
    unavailable(response, "Finance data");
    return;
  }
  Promise.resolve(service[method](input, actor))
    .then((result) => response.json(result))
    .catch(next);
}

function invokeWithStatus(
  service,
  method,
  input,
  status,
  response,
  next,
) {
  if (typeof service?.[method] !== "function") {
    unavailable(response, "Finance data");
    return;
  }
  Promise.resolve(service[method](input))
    .then((result) => response.status(status).json(result))
    .catch(next);
}

function invokeWithActorAndStatus(
  service,
  method,
  input,
  actor,
  status,
  response,
  next,
) {
  if (typeof service?.[method] !== "function") {
    unavailable(response, "Finance data");
    return;
  }
  Promise.resolve(service[method](input, actor))
    .then((result) => response.status(status).json(result))
    .catch(next);
}

function invokePlanWrite(
  service,
  operation,
  method,
  input,
  actor,
  response,
  next,
  status = 200,
) {
  if (
    typeof input?.idempotency_key !== "string" ||
    input.idempotency_key.trim().length < 8
  ) {
    invalidRequest(
      response,
      "idempotency_key is required for planning writes.",
    );
    return;
  }
  const promise =
    typeof service?.executeIdempotentWrite === "function"
      ? service.executeIdempotentWrite(operation, input, actor)
      : typeof service?.[method] === "function"
        ? service[method](input, actor)
        : null;
  if (!promise) {
    unavailable(response, "Finance planning");
    return;
  }
  Promise.resolve(promise)
    .then((result) => response.status(status).json(result))
    .catch(next);
}

export function createApiRouter({
  requireAuth = (_request, _response, next) => next(),
  requireAdmin = (_request, _response, next) => next(),
  requireCsrf = (_request, _response, next) => next(),
  financeService,
  planningService = null,
  plaidSyncService,
  appleCardImportService,
} = {}) {
  const router = Router();

  router.use("/api", requireAuth);

  for (const [path, method] of TOOL_ROUTES) {
    router.get(`/api/v1/${path}`, (request, response, next) => {
      invoke(
        financeService,
        method,
        apiInput(path, request.query),
        response,
        next,
      );
    });
  }

  router.get(
    "/api/v1/credit-scores",
    (request, response, next) => {
      const period = stringValue(request.query.period, 8) || "1y";
      if (!["1w", "1m", "1y", "all"].includes(period)) {
        invalidRequest(response, "period must be 1w, 1m, 1y, or all.");
        return;
      }
      invoke(
        financeService,
        "getCreditScoreSummary",
        {
          period,
          current_user_id: request.user?.id,
        },
        response,
        next,
      );
    },
  );

  router.get(
    "/api/v1/plan/safe-to-spend",
    (request, response, next) => {
      invoke(
        planningService,
        "getSafeToSpend",
        {},
        response,
        next,
      );
    },
  );

  router.get(
    "/api/v1/plan/goals",
    (request, response, next) => {
      invoke(
        planningService,
        "listFinanceGoals",
        {
          status: stringValue(request.query.status, 16),
          purpose: stringValue(request.query.purpose, 16),
          limit: integerValue(request.query.limit, {
            minimum: 1,
            maximum: 8,
          }),
          cursor: stringValue(request.query.cursor, 128),
        },
        response,
        next,
      );
    },
  );

  router.get(
    "/api/v1/plan/budget",
    (request, response, next) => {
      invoke(
        planningService,
        "getBudgetStatus",
        { month_on: request.query.month_on ?? null },
        response,
        next,
      );
    },
  );

  router.post(
    "/api/v1/plan/scenarios",
    requireCsrf,
    (request, response, next) => {
      invoke(
        planningService,
        "modelFinancePlan",
        request.body ?? {},
        response,
        next,
      );
    },
  );

  router.post(
    "/api/v1/plan/goals",
    requireCsrf,
    (request, response, next) => {
      invokePlanWrite(
        planningService,
        "create_finance_goal",
        "createFinanceGoal",
        request.body ?? {},
        request.user,
        response,
        next,
        201,
      );
    },
  );

  router.put(
    "/api/v1/plan/goals/:goalId",
    requireCsrf,
    (request, response, next) => {
      invokePlanWrite(
        planningService,
        "update_finance_goal",
        "updateFinanceGoal",
        {
          ...(request.body ?? {}),
          goal_id: request.params.goalId,
        },
        request.user,
        response,
        next,
      );
    },
  );

  router.post(
    "/api/v1/plan/goals/:goalId/allocations",
    requireCsrf,
    (request, response, next) => {
      invokePlanWrite(
        planningService,
        "allocate_finance_goal",
        "allocateFinanceGoal",
        {
          ...(request.body ?? {}),
          goal_id: request.params.goalId,
        },
        request.user,
        response,
        next,
      );
    },
  );

  router.put(
    "/api/v1/plan/goals/:goalId/schedule",
    requireCsrf,
    (request, response, next) => {
      invokePlanWrite(
        planningService,
        "set_goal_funding_schedule",
        "setGoalFundingSchedule",
        {
          ...(request.body ?? {}),
          goal_id: request.params.goalId,
        },
        request.user,
        response,
        next,
      );
    },
  );

  router.post(
    "/api/v1/plan/goals/:goalId/finish",
    requireCsrf,
    (request, response, next) => {
      invokePlanWrite(
        planningService,
        "finish_finance_goal",
        "finishFinanceGoal",
        {
          ...(request.body ?? {}),
          goal_id: request.params.goalId,
        },
        request.user,
        response,
        next,
      );
    },
  );

  router.put(
    "/api/v1/plan/budget/:category",
    requireCsrf,
    (request, response, next) => {
      invokePlanWrite(
        planningService,
        "set_category_budget",
        "setCategoryBudget",
        {
          ...(request.body ?? {}),
          category: request.params.category,
        },
        request.user,
        response,
        next,
      );
    },
  );

  router.post(
    "/api/v1/plan/budget",
    requireCsrf,
    (request, response, next) => {
      invokePlanWrite(
        planningService,
        "set_category_budget",
        "setCategoryBudget",
        {
          ...(request.body ?? {}),
        },
        request.user,
        response,
        next,
      );
    },
  );

  router.put(
    "/api/v1/transactions/:transactionId/splits",
    requireCsrf,
    (request, response, next) => {
      invokePlanWrite(
        planningService,
        "split_transaction",
        "splitTransaction",
        {
          ...(request.body ?? {}),
          transaction_id: request.params.transactionId,
        },
        request.user,
        response,
        next,
      );
    },
  );

  router.get(
    "/api/v1/transactions/:transactionId/goal-spends",
    (request, response, next) => {
      invoke(
        planningService,
        "getTransactionGoalSpending",
        {
          transaction_id: request.params.transactionId,
        },
        response,
        next,
      );
    },
  );

  router.post(
    "/api/v1/transactions/:transactionId/goal-spends",
    requireCsrf,
    (request, response, next) => {
      invokePlanWrite(
        planningService,
        "spend_from_finance_goal",
        "spendFromFinanceGoal",
        {
          ...(request.body ?? {}),
          transaction_id: request.params.transactionId,
        },
        request.user,
        response,
        next,
        201,
      );
    },
  );

  router.delete(
    "/api/v1/transactions/:transactionId/goal-spends/:goalSpendId",
    requireCsrf,
    (request, response, next) => {
      invokePlanWrite(
        planningService,
        "reverse_goal_spend",
        "reverseGoalSpend",
        {
          ...(request.body ?? {}),
          transaction_id: request.params.transactionId,
          goal_spend_id: request.params.goalSpendId,
        },
        request.user,
        response,
        next,
      );
    },
  );

  router.post(
    "/api/v1/credit-score-sources",
    requireCsrf,
    (request, response, next) => {
      const input = creditScoreSourceInput(request.body);
      if (!input) {
        invalidRequest(
          response,
          "label is required; bureau and model are optional.",
        );
        return;
      }
      invokeWithActorAndStatus(
        financeService,
        "createCreditScoreSource",
        input,
        request.user,
        201,
        response,
        next,
      );
    },
  );

  router.put(
    "/api/v1/credit-score-sources/:sourceId",
    requireCsrf,
    (request, response, next) => {
      const input = creditScoreSourceInput(request.body, {
        partial: true,
      });
      if (!input) {
        invalidRequest(
          response,
          "At least one valid label, bureau, or model field is required.",
        );
        return;
      }
      invokeWithActor(
        financeService,
        "updateCreditScoreSource",
        {
          source_id: request.params.sourceId,
          ...input,
        },
        request.user,
        response,
        next,
      );
    },
  );

  router.delete(
    "/api/v1/credit-score-sources/:sourceId",
    requireCsrf,
    (request, response, next) => {
      invokeWithActor(
        financeService,
        "archiveCreditScoreSource",
        { source_id: request.params.sourceId },
        request.user,
        response,
        next,
      );
    },
  );

  router.put(
    "/api/v1/credit-score-sources/:sourceId/observations/:observedOn",
    requireCsrf,
    (request, response, next) => {
      const observedOn = dateValue(request.params.observedOn);
      const score = exactInteger(request.body?.score, {
        minimum: 300,
      });
      if (
        !observedOn ||
        score == null ||
        score > 850
      ) {
        invalidRequest(
          response,
          "observedOn must be a valid date and score must be an integer from 300 to 850.",
        );
        return;
      }
      invokeWithActor(
        financeService,
        "upsertCreditScoreObservation",
        {
          source_id: request.params.sourceId,
          observed_on: observedOn,
          score,
        },
        request.user,
        response,
        next,
      );
    },
  );

  router.post(
    "/api/v1/plaid/link-token",
    requireAdmin,
    requireCsrf,
    async (request, response, next) => {
      if (!plaidSyncService?.createLinkToken) {
        unavailable(response, "Plaid Link");
        return;
      }
      try {
        const result = await plaidSyncService.createLinkToken({
          userId: request.user?.email || request.user?.id,
          redirectUri: stringValue(request.body?.redirect_uri, 2_048),
        });
        response.json({
          link_token: result.linkToken,
          expiration: result.expiration,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/api/v1/plaid/exchange",
    requireAdmin,
    requireCsrf,
    async (request, response, next) => {
      if (!plaidSyncService?.exchangeAndLink) {
        unavailable(response, "Plaid Link");
        return;
      }
      const publicToken = stringValue(request.body?.public_token, 2_048);
      if (!publicToken) {
        response.status(400).json({
          error: "invalid_request",
          message: "public_token is required.",
        });
        return;
      }
      try {
        const result = await plaidSyncService.exchangeAndLink({
          publicToken,
          institutionId: stringValue(request.body?.institution_id),
          institutionName: stringValue(request.body?.institution_name),
          workspaceId: "shared",
        });
        response.status(201).json({
          item_id: result.itemId,
          status: result.status || "syncing",
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/api/v1/plaid/items/:itemId/link-token",
    requireAdmin,
    requireCsrf,
    async (request, response, next) => {
      if (!plaidSyncService?.createUpdateLinkToken) {
        unavailable(response, "Plaid update mode");
        return;
      }
      try {
        const result = await plaidSyncService.createUpdateLinkToken({
          itemId: request.params.itemId,
          userId: request.user?.email || request.user?.id,
          redirectUri: stringValue(request.body?.redirect_uri, 2_048),
        });
        response.json({
          link_token: result.linkToken,
          expiration: result.expiration,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/api/v1/plaid/items/:itemId/sync",
    requireAdmin,
    requireCsrf,
    async (request, response, next) => {
      if (!plaidSyncService?.queueSync && !plaidSyncService?.syncItem) {
        unavailable(response, "Plaid sync");
        return;
      }
      try {
        const result = plaidSyncService.queueSync
          ? await plaidSyncService.queueSync(request.params.itemId)
          : await plaidSyncService.syncItem(request.params.itemId);
        response.status(202).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete(
    "/api/v1/plaid/items/:itemId",
    requireAdmin,
    requireCsrf,
    async (request, response, next) => {
      if (!plaidSyncService?.removeItem) {
        unavailable(response, "Plaid connection removal");
        return;
      }
      try {
        await plaidSyncService.removeItem(request.params.itemId, {
          retainHistory: booleanValue(request.body?.retain_history),
        });
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/api/v1/apple-card/imports/preview",
    requireAdmin,
    requireCsrf,
    async (request, response, next) => {
      if (!appleCardImportService?.preview) {
        unavailable(response, "Apple Card CSV import");
        return;
      }
      try {
        const upload = await readAppleCardMultipart(request);
        const result = await appleCardImportService.preview(upload);
        response.json(result);
      } catch (error) {
        if (error instanceof TypeError && !error.statusCode) {
          error.statusCode = 400;
          error.expose = true;
        }
        next(error);
      }
    },
  );

  router.post(
    "/api/v1/apple-card/imports",
    requireAdmin,
    requireCsrf,
    async (request, response, next) => {
      if (!appleCardImportService?.import) {
        unavailable(response, "Apple Card CSV import");
        return;
      }
      try {
        const { fileBuffer, fields } =
          await readAppleCardMultipart(request);
        const result = await appleCardImportService.import(
          {
            fileBuffer,
            previewDigest: fields.preview_digest,
            balance: fields.balance,
            creditLimit: fields.credit_limit,
            balanceAsOf: fields.balance_as_of,
            lastFour: fields.last_four,
          },
          request.user,
        );
        response.status(201).json(result);
      } catch (error) {
        if (error instanceof TypeError && !error.statusCode) {
          error.statusCode = 400;
          error.expose = true;
        }
        next(error);
      }
    },
  );

  router.patch(
    "/api/v1/apple-card/account",
    requireAdmin,
    requireCsrf,
    async (request, response, next) => {
      if (!appleCardImportService?.updateAccount) {
        unavailable(response, "Apple Card account updates");
        return;
      }
      try {
        const result = await appleCardImportService.updateAccount(
          {
            balance: request.body?.balance,
            creditLimit: request.body?.credit_limit,
            balanceAsOf: request.body?.balance_as_of,
            lastFour: request.body?.last_four,
          },
          request.user,
        );
        response.json(result);
      } catch (error) {
        if (error instanceof TypeError && !error.statusCode) {
          error.statusCode = 400;
          error.expose = true;
        }
        next(error);
      }
    },
  );

  router.delete(
    "/api/v1/apple-card/connection",
    requireAdmin,
    requireCsrf,
    async (request, response, next) => {
      if (!appleCardImportService?.remove) {
        unavailable(response, "Apple Card connection removal");
        return;
      }
      try {
        await appleCardImportService.remove({
          retainHistory: booleanValue(request.body?.retain_history),
        });
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/api/v1/transaction-cleanup-rules",
    requireAdmin,
    (request, response, next) => {
      invoke(
        financeService,
        "listTransactionCleanupRules",
        {
          include_disabled:
            request.query?.include_disabled === undefined
              ? true
              : booleanValue(request.query.include_disabled),
        },
        response,
        next,
      );
    },
  );

  router.post(
    "/api/v1/transaction-cleanup-rules",
    requireAdmin,
    requireCsrf,
    (request, response, next) => {
      const input = transactionCleanupRuleInput(request.body);
      if (!input) {
        invalidRequest(
          response,
          "matcher and at least one valid cleanup change are required.",
        );
        return;
      }
      invokeWithActorAndStatus(
        financeService,
        "createTransactionCleanupRule",
        input,
        request.user,
        201,
        response,
        next,
      );
    },
  );

  router.put(
    "/api/v1/transaction-cleanup-rules/:ruleId",
    requireAdmin,
    requireCsrf,
    (request, response, next) => {
      const input = transactionCleanupRuleInput(request.body);
      if (!input) {
        invalidRequest(
          response,
          "matcher and at least one valid cleanup change are required.",
        );
        return;
      }
      invokeWithActor(
        financeService,
        "updateTransactionCleanupRule",
        {
          rule_id: request.params.ruleId,
          ...input,
        },
        request.user,
        response,
        next,
      );
    },
  );

  router.delete(
    "/api/v1/transaction-cleanup-rules/:ruleId",
    requireAdmin,
    requireCsrf,
    (request, response, next) => {
      invokeWithActor(
        financeService,
        "deleteTransactionCleanupRule",
        { rule_id: request.params.ruleId },
        request.user,
        response,
        next,
      );
    },
  );

  router.get(
    "/api/v1/transactions/matches",
    requireAdmin,
    (request, response, next) => {
      const transactionId = stringValue(
        request.query?.transaction_id,
        128,
      );
      const query = stringValue(request.query?.q, 120);
      if (!transactionId && !query) {
        invalidRequest(
          response,
          "transaction_id or a nonblank q value is required.",
        );
        return;
      }
      invokeWithActor(
        financeService,
        "findTransactionMatches",
        {
          transaction_id: transactionId,
          q: query,
          limit:
            integerValue(request.query?.limit, { maximum: 50 }) ?? 50,
        },
        request.user,
        response,
        next,
      );
    },
  );

  router.post(
    "/api/v1/transactions/batch-edit",
    requireAdmin,
    requireCsrf,
    (request, response, next) => {
      const input = transactionBatchEditInput(request.body);
      if (!input) {
        invalidRequest(
          response,
          "transaction_ids and at least one valid change are required.",
        );
        return;
      }
      invokeWithActor(
        financeService,
        "batchEditTransactions",
        input,
        request.user,
        response,
        next,
      );
    },
  );

  router.post(
    "/api/v1/transactions/:transactionId/classification",
    requireAdmin,
    requireCsrf,
    (request, response, next) => {
      invoke(
        financeService,
        "updateTransactionClassification",
        {
          transaction_id: request.params.transactionId,
          category_primary: stringValue(request.body?.category_primary, 100),
          category_detailed: stringValue(request.body?.category_detailed, 100),
          excluded_from_spending:
            request.body?.excluded_from_spending === undefined
              ? undefined
              : booleanValue(request.body.excluded_from_spending),
          is_fixed:
            request.body?.is_fixed === undefined
              ? undefined
              : booleanValue(request.body.is_fixed),
          user_id: request.user?.id,
        },
        response,
        next,
      );
    },
  );

  router.put(
    "/api/v1/accounts/:accountId/balance-group",
    requireAdmin,
    requireCsrf,
    (request, response, next) => {
      const rawGroup = request.body?.balance_group;
      const balanceGroup =
        rawGroup === null || rawGroup === ""
          ? null
          : stringValue(rawGroup, 32);
      if (
        balanceGroup !== null &&
        !BALANCE_GROUPS.has(balanceGroup)
      ) {
        invalidRequest(response, "balance_group is not supported.");
        return;
      }
      invoke(
        financeService,
        "updateAccountBalanceGroup",
        {
          account_id: request.params.accountId,
          balance_group: balanceGroup,
          user_id: request.user?.id,
        },
        response,
        next,
      );
    },
  );

  router.post(
    "/api/v1/manual-assets",
    requireAdmin,
    requireCsrf,
    (request, response, next) => {
      const input = manualAssetInput(request.body);
      if (!input) {
        invalidRequest(
          response,
          "name, asset_type, currency_code, value_minor, and valued_on are required.",
        );
        return;
      }
      invokeWithStatus(
        financeService,
        "createManualAsset",
        { ...input, user_id: request.user?.id },
        201,
        response,
        next,
      );
    },
  );

  router.put(
    "/api/v1/manual-assets/:assetId",
    requireAdmin,
    requireCsrf,
    (request, response, next) => {
      const input = manualAssetInput(request.body);
      if (!input) {
        invalidRequest(
          response,
          "name, asset_type, currency_code, value_minor, and valued_on are required.",
        );
        return;
      }
      invoke(
        financeService,
        "updateManualAsset",
        {
          asset_id: request.params.assetId,
          ...input,
          user_id: request.user?.id,
        },
        response,
        next,
      );
    },
  );

  router.delete(
    "/api/v1/manual-assets/:assetId",
    requireAdmin,
    requireCsrf,
    (request, response, next) => {
      invoke(
        financeService,
        "archiveManualAsset",
        {
          asset_id: request.params.assetId,
          user_id: request.user?.id,
        },
        response,
        next,
      );
    },
  );

  router.post(
    "/api/v1/insights/:findingId/actions/:action",
    requireAdmin,
    requireCsrf,
    (request, response, next) => {
      const action = request.params.action;
      if (
        ![
          "review",
          "recategorize",
          "mark_expected",
          "confirm",
          "dismiss",
          "archive",
          "mark_bad",
          "restore",
        ].includes(action)
      ) {
        response.status(400).json({
          error: "invalid_action",
          message: "This insight action is not supported.",
        });
        return;
      }
      invokeWithActor(
        financeService,
        "actOnFinding",
        {
          finding_id: request.params.findingId,
          action,
        },
        request.user,
        response,
        next,
      );
    },
  );

  router.delete(
    "/api/v1/insights/:findingId",
    requireAdmin,
    requireCsrf,
    (request, response, next) => {
      invokeWithActor(
        financeService,
        "actOnFinding",
        {
          finding_id: request.params.findingId,
          action: "delete",
        },
        request.user,
        response,
        next,
      );
    },
  );

  router.put(
    "/api/v1/settings/insight-rules/:ruleId",
    requireAdmin,
    requireCsrf,
    (request, response, next) => {
      invoke(
        financeService,
        "updateInsightRule",
        {
          rule_id: request.params.ruleId,
          enabled:
            request.body?.enabled === undefined
              ? undefined
              : booleanValue(request.body.enabled),
          settings: request.body?.settings,
        },
        response,
        next,
      );
    },
  );

  return router;
}

function transactionBatchEditInput(body = {}) {
  if (
    !Array.isArray(body.transaction_ids) ||
    body.transaction_ids.length < 1 ||
    body.transaction_ids.length > 50 ||
    !body.changes ||
    typeof body.changes !== "object" ||
    Array.isArray(body.changes)
  ) {
    return null;
  }
  const transactionIds = body.transaction_ids.map((value) => {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim();
    return normalized && normalized.length <= 128
      ? normalized
      : undefined;
  });
  if (
    transactionIds.some((value) => !value) ||
    new Set(transactionIds).size !== transactionIds.length
  ) {
    return null;
  }

  const changes = {};
  if (Object.hasOwn(body.changes, "display_name")) {
    const rawValue = body.changes.display_name;
    if (rawValue === null || rawValue === "") {
      changes.display_name = null;
    } else {
      if (typeof rawValue !== "string") return null;
      const value = rawValue.trim();
      if (!value || value.length > 160) return null;
      changes.display_name = value;
    }
  }
  if (Object.hasOwn(body.changes, "category_primary")) {
    const rawValue = body.changes.category_primary;
    if (typeof rawValue !== "string") return null;
    const value = rawValue.trim();
    if (!value || value.length > 100) return null;
    changes.category_primary = value;
  }

  if (Object.hasOwn(body.changes, "tags")) {
    if (
      !Array.isArray(body.changes.tags) ||
      body.changes.tags.length > 20
    ) {
      return null;
    }
    const tags = body.changes.tags.map((value) => {
      if (typeof value !== "string") return undefined;
      const normalized = value.trim();
      return normalized && normalized.length <= 64
        ? normalized
        : undefined;
    });
    if (
      tags.some((value) => !value) ||
      new Set(tags).size !== tags.length
    ) {
      return null;
    }
    changes.tags = tags;
  }

  if (Object.keys(changes).length === 0) return null;
  return {
    transaction_ids: transactionIds,
    changes,
  };
}

function transactionCleanupRuleInput(body = {}) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (key) => !["matcher", "changes", "enabled"].includes(key),
    ) ||
    !body.matcher ||
    typeof body.matcher !== "object" ||
    Array.isArray(body.matcher) ||
    Object.keys(body.matcher).some(
      (key) => !["field", "value"].includes(key),
    ) ||
    !body.changes ||
    typeof body.changes !== "object" ||
    Array.isArray(body.changes) ||
    Object.keys(body.changes).some(
      (key) =>
        !["display_name", "category_primary", "tags"].includes(key),
    )
  ) {
    return null;
  }
  const field = body.matcher.field;
  if (!["normalized_merchant", "normalized_name"].includes(field)) {
    return null;
  }
  if (typeof body.matcher.value !== "string") return null;
  const value = body.matcher.value.trim();
  if (!value || value.length > 160) return null;

  const changes = {};
  if (Object.hasOwn(body.changes, "display_name")) {
    if (typeof body.changes.display_name !== "string") return null;
    const displayName = body.changes.display_name.trim();
    if (!displayName || displayName.length > 160) return null;
    changes.display_name = displayName;
  }
  if (Object.hasOwn(body.changes, "category_primary")) {
    if (typeof body.changes.category_primary !== "string") return null;
    const category = body.changes.category_primary.trim();
    if (!category || category.length > 100) return null;
    changes.category_primary = category;
  }
  if (Object.hasOwn(body.changes, "tags")) {
    if (
      !Array.isArray(body.changes.tags) ||
      body.changes.tags.length > 20
    ) {
      return null;
    }
    const tags = body.changes.tags.map((tag) => {
      if (typeof tag !== "string") return undefined;
      const clean = tag.trim();
      return clean && clean.length <= 64 ? clean : undefined;
    });
    if (
      tags.some((tag) => !tag) ||
      new Set(tags).size !== tags.length
    ) {
      return null;
    }
    changes.tags = tags;
  }
  if (!Object.keys(changes).length) return null;
  if (
    body.enabled !== undefined &&
    typeof body.enabled !== "boolean"
  ) {
    return null;
  }
  return {
    matcher: { field, value },
    changes,
    ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
  };
}

function manualAssetInput(body = {}) {
  const name = stringValue(body.name, 120);
  const assetType = stringValue(body.asset_type, 40);
  const currencyCode = currencyValue(body.currency_code);
  const valueMinor = exactInteger(body.value_minor);
  const valuedOn = dateValue(body.valued_on);
  if (
    !name ||
    !MANUAL_ASSET_TYPES.has(assetType) ||
    !currencyCode ||
    valueMinor === undefined ||
    !valuedOn
  ) {
    return null;
  }
  return {
    name,
    asset_type: assetType,
    description: stringValue(body.description, 500) ?? null,
    currency_code: currencyCode,
    value_minor: valueMinor,
    valued_on: valuedOn,
  };
}

export function createPlaidWebhookRouter({ plaidSyncService } = {}) {
  const router = Router();

  router.post("/webhooks/plaid", async (request, response, next) => {
    if (!plaidSyncService?.handleWebhook) {
      unavailable(response, "Plaid webhooks");
      return;
    }
    try {
      const rawBody = request.rawBody;
      const verificationHeader = request.get("plaid-verification");
      const result = await plaidSyncService.handleWebhook({
        rawBody,
        verificationHeader,
      });
      response.status(result?.accepted === false ? 400 : 202).json({
        accepted: result?.accepted !== false,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
