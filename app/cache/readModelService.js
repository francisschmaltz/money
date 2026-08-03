import { performance } from "node:perf_hooks";

import {
  ensureWorkspaceReadModelRevision,
} from "../db/workspaceReadModelRevision.js";
import { log } from "../log.js";
import {
  READ_MODEL_SLOTS,
  readModelCacheKey,
  resolvePageReadModelPolicy,
  resolveSharedReadModelPolicy,
} from "./readModelPolicy.js";

const DEFAULT_WORKSPACE_ID = "shared";
const REQUEST_REVISION_PROMISE = Symbol("readModelRevisionPromise");
const REQUEST_OBSERVED_REVISIONS = Symbol("readModelObservedRevisions");
const REQUEST_CACHE_BYPASS = Symbol("readModelCacheBypass");

function roundedMilliseconds(value) {
  return Math.round(Math.max(0, value) * 10) / 10;
}

function serializedBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return null;
  }
}

function workspaceDate(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function monthStart(date) {
  return `${String(date).slice(0, 7)}-01`;
}

function validDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
}

function previousMonth(date) {
  const [year, month] = monthStart(date).split("-").map(Number);
  return new Date(Date.UTC(year, month - 2, 1))
    .toISOString()
    .slice(0, 10);
}

function shiftUtcDate(value, days) {
  const shifted = new Date(value);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function onlyKeys(object, allowed) {
  return Object.entries(object ?? {}).every(
    ([key, value]) => allowed.has(key) || value === undefined,
  );
}

function recordRequestTiming(request, timing) {
  if (!request || typeof request !== "object") return;
  const current = Array.isArray(request.readModelTimings)
    ? request.readModelTimings
    : [];
  current.push(timing);
  request.readModelTimings = current;
}

export class ReadModelService {
  #cache;
  #pool;
  #financeService;
  #planningService;
  #planningRepository;
  #workspaceId;
  #nodeEnvironment;
  #logger;
  #now;
  #revisionSource;

  constructor({
    cache,
    pool,
    financeService,
    planningService,
    planningRepository = null,
    workspaceId = DEFAULT_WORKSPACE_ID,
    nodeEnvironment = process.env.NODE_ENV || "development",
    logger = log,
    now = () => new Date(),
    revisionSource = null,
  } = {}) {
    if (!cache || !pool || !financeService || !planningService) {
      throw new TypeError(
        "cache, pool, financeService, and planningService are required",
      );
    }
    this.#cache = cache;
    this.#pool = pool;
    this.#financeService = financeService;
    this.#planningService = planningService;
    this.#planningRepository = planningRepository;
    this.#workspaceId = workspaceId;
    this.#nodeEnvironment = nodeEnvironment;
    this.#logger = logger;
    this.#now = now;
    this.#revisionSource = revisionSource;
  }

  status() {
    return this.#cache.status();
  }

  async recoverCache() {
    return this.#cache.probe?.() ?? false;
  }

  async runCoherentRequest(request, operation) {
    if (typeof operation !== "function") {
      throw new TypeError("coherent read-model operation is required");
    }
    if (!request || typeof request !== "object") return operation();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.#resetRequestCacheContext(request);
      const result = await operation();
      const revisions = request[REQUEST_OBSERVED_REVISIONS] ?? new Set();
      if (revisions.size <= 1) return result;
    }
    this.#resetRequestCacheContext(request);
    request[REQUEST_CACHE_BYPASS] = true;
    try {
      return await operation();
    } finally {
      delete request[REQUEST_CACHE_BYPASS];
    }
  }

  async getFinancePageData(view, request = {}, options = {}) {
    const policy = resolvePageReadModelPolicy({
      page: view,
      query: request.query ?? {},
      workspaceId: this.#workspaceId,
      nodeEnvironment: this.#nodeEnvironment,
      now: this.#now(),
    });
    if (
      !policy.eligible ||
      !["dashboard", "transactions"].includes(view)
    ) {
      return this.#financeService.getPageData(view, request);
    }

    if (policy.overlay?.kind === "transaction-detail") {
      const [base, overlay] = await Promise.all([
        this.#load({
          key: policy.key,
          model: "transactions",
          load: () =>
            this.#financeService.getPageData("transactions", {
              query: {},
            }),
          request,
          ...options,
        }),
        this.#financeService.getTransactionPageOverlay(
          policy.overlay.transactionId,
        ),
      ]);
      return { ...base, ...overlay };
    }

    return this.#load({
      key: policy.key,
      model: view,
      load: () => this.#financeService.getPageData(view, request),
      request,
      ...options,
    });
  }

  async getPlanningOverview(input = {}, request = null, options = {}) {
    const policy = resolvePageReadModelPolicy({
      page: "plan",
      query: {},
      workspaceId: this.#workspaceId,
      nodeEnvironment: this.#nodeEnvironment,
    });
    if (input?.month_on != null) {
      return this.#planningService.getPlanningOverview(input);
    }
    return this.#load({
      key: policy.key,
      model: "plan",
      load: () => this.#planningService.getPlanningOverview(input),
      request,
      ...options,
    });
  }

  async getSafeToSpend(_input = {}, request = null, options = {}) {
    const policy = resolveSharedReadModelPolicy({
      read: "safeToSpend",
      workspaceId: this.#workspaceId,
      nodeEnvironment: this.#nodeEnvironment,
    });
    return this.#load({
      key: policy.key,
      model: "safe-to-spend",
      load: () => this.#planningService.getSafeToSpend(),
      request,
      ...options,
    });
  }

  async getBudgetStatus(input = {}, request = null, options = {}) {
    const includeAvailableCategories =
      input?.include_available_categories;
    if (
      !onlyKeys(
        input,
        new Set(["month_on", "include_available_categories"]),
      ) ||
      (includeAvailableCategories !== undefined &&
        includeAvailableCategories !== false)
    ) {
      return this.#planningService.getBudgetStatus(input);
    }
    const { current, previous } = await this.#canonicalMonths();
    if (input?.month_on != null && !validDateOnly(input.month_on)) {
      return this.#planningService.getBudgetStatus(input);
    }
    const requested = input?.month_on == null
      ? current
      : monthStart(input.month_on);
    const slot = requested === current
      ? READ_MODEL_SLOTS.PLAN_BUDGET_CURRENT
      : requested === previous
        ? READ_MODEL_SLOTS.PLAN_BUDGET_PREVIOUS
        : null;
    if (!slot) return this.#planningService.getBudgetStatus(input);
    return this.#load({
      key: readModelCacheKey({
        workspaceId: this.#workspaceId,
        slot,
        nodeEnvironment: this.#nodeEnvironment,
      }),
      model: requested === current ? "budget-current" : "budget-previous",
      load: () => this.#planningService.getBudgetStatus({
        ...input,
        month_on: requested,
      }),
      request,
      ...options,
    });
  }

  async getFinanceOverview(input = {}, request = null, options = {}) {
    if (
      !onlyKeys(input, new Set(["asOf", "as_of"])) ||
      input?.asOf != null ||
      input?.as_of != null
    ) {
      return this.#financeService.getFinanceOverview(input);
    }
    return this.#loadShared(
      "overview",
      "overview",
      () => this.#financeService.getFinanceOverview(input),
      request,
      options,
    );
  }

  async listRecentTransactions(input = {}, request = null, options = {}) {
    const allowed = new Set(["limit", "status", "includePending"]);
    const canonical =
      onlyKeys(input, allowed) &&
      Number(input.limit) === 6 &&
      (input.status ?? "all") === "all" &&
      (input.includePending ?? true) === true;
    if (!canonical) return this.#financeService.listTransactions(input);
    return this.#loadShared(
      "recentTransactions",
      "recent-transactions",
      () => this.#financeService.listTransactions({ ...input, limit: 6 }),
      request,
      options,
    );
  }

  async listAccountCatalog(input = {}, request = null, options = {}) {
    const allowed = new Set(["limit", "includeClosed"]);
    const canonical =
      onlyKeys(input, allowed) &&
      Number(input.limit ?? 50) === 50 &&
      (input.includeClosed ?? false) === false;
    if (!canonical) return this.#financeService.listAccounts(input);
    return this.#loadShared(
      "accounts",
      "accounts",
      () => this.#financeService.listAccounts(input),
      request,
      options,
    );
  }

  async getActiveInsights(input = {}, request = null, options = {}) {
    const allowed = new Set([
      "section",
      "limitPerSection",
      "limit_per_section",
      "asOf",
      "as_of",
      "view",
    ]);
    const canonical =
      onlyKeys(input, allowed) &&
      (input.section ?? "all") === "all" &&
      input.asOf == null &&
      input.as_of == null &&
      (input.view ?? "active") === "active" &&
      input.limitPerSection == null &&
      input.limit_per_section == null;
    if (!canonical) return this.#financeService.getFinanceInsights(input);
    return this.#loadShared(
      "insights",
      "insights",
      () => this.#financeService.getFinanceInsights(input),
      request,
      options,
    );
  }

  async getBoundedHistory(input = {}, request = null, options = {}) {
    const now = this.#now();
    const canonical = {
      startOn: shiftUtcDate(now, -30),
      endOn: shiftUtcDate(now, 1),
      interval: "day",
      limit: 31,
      includeComponents: true,
    };
    const supplied = {
      startOn: input.startOn ?? input.start_on,
      endOn: input.endOn ?? input.end_on,
      interval: input.interval,
      limit: input.limit,
      includeComponents:
        input.includeComponents ?? input.include_components,
    };
    const allowed = new Set([
      "startOn",
      "start_on",
      "endOn",
      "end_on",
      "interval",
      "limit",
      "includeComponents",
      "include_components",
    ]);
    const cacheable =
      onlyKeys(input, allowed) &&
      supplied.startOn === canonical.startOn &&
      supplied.endOn === canonical.endOn &&
      supplied.interval === canonical.interval &&
      Number(supplied.limit) === canonical.limit &&
      supplied.includeComponents === true;
    if (!cacheable) return this.#financeService.getNetWorthHistory(input);
    return this.#loadShared(
      "boundedHistory",
      "bounded-history",
      () => this.#financeService.getNetWorthHistory(canonical),
      request,
      options,
    );
  }

  async listSpendingCategories(input = {}, request = null, options = {}) {
    if (!onlyKeys(input, new Set())) {
      return this.#financeService.listSpendingCategories(input);
    }
    return this.#loadShared(
      "spendingCategories",
      "spending-categories",
      () => this.#financeService.listSpendingCategories(input),
      request,
      options,
    );
  }

  async warmCanonicalModels({ reason = "scheduled" } = {}) {
    const initialFailureGeneration =
      this.#cache.failureGeneration?.() ?? null;
    const initialRevision = await this.#revision();
    const warm = {
      force: true,
      warmReason: reason,
      revisionRetries: 0,
    };
    const warmContext = { query: {} };
    Object.defineProperty(warmContext, REQUEST_REVISION_PROMISE, {
      value: Promise.resolve(initialRevision),
      configurable: true,
    });
    const assertWarmWriteSucceeded = () => {
      if (
        initialFailureGeneration != null &&
        this.#cache.failureGeneration() !== initialFailureGeneration
      ) {
        const error = new Error("Read-model Redis warm did not complete");
        error.name = "ReadModelCacheUnavailableError";
        throw error;
      }
    };
    let observedRevision = initialRevision;
    const warmStep = async (operation) => {
      await operation();
      assertWarmWriteSucceeded();
      observedRevision = await this.#revision();
      return observedRevision !== initialRevision;
    };
    const changed = () => ({
      revision: observedRevision,
      changedDuringWarm: true,
    });
    if (
      await warmStep(() =>
        this.getFinancePageData("dashboard", warmContext, warm))
    ) return changed();
    if (
      await warmStep(() =>
        this.getPlanningOverview({}, warmContext, warm))
    ) return changed();
    if (
      await warmStep(() =>
        this.getFinancePageData("transactions", warmContext, warm))
    ) return changed();
    if (
      await warmStep(() =>
        this.getSafeToSpend({}, warmContext, warm))
    ) return changed();
    const { current, previous } = await this.#canonicalMonths();
    if (
      await warmStep(() =>
        this.getBudgetStatus({ month_on: current }, warmContext, warm))
    ) return changed();
    if (
      await warmStep(() =>
        this.getBudgetStatus({ month_on: previous }, warmContext, warm))
    ) return changed();
    if (
      await warmStep(() =>
        this.getFinanceOverview({}, warmContext, warm))
    ) return changed();
    if (
      await warmStep(() =>
        this.getBoundedHistory(
          {
            startOn: shiftUtcDate(this.#now(), -30),
            endOn: shiftUtcDate(this.#now(), 1),
            interval: "day",
            limit: 31,
            includeComponents: true,
          },
          warmContext,
          warm,
        ))
    ) return changed();
    if (
      await warmStep(() =>
        this.listRecentTransactions({ limit: 6 }, warmContext, warm))
    ) return changed();
    if (
      await warmStep(() =>
        this.listAccountCatalog({}, warmContext, warm))
    ) return changed();
    if (
      await warmStep(() =>
        this.getActiveInsights({}, warmContext, warm))
    ) return changed();
    if (
      await warmStep(() =>
        this.listSpendingCategories({}, warmContext, warm))
    ) return changed();
    assertWarmWriteSucceeded();
    return {
      revision: observedRevision,
      changedDuringWarm: false,
    };
  }

  async rolloverToken() {
    const timeZone =
      (await this.#planningRepository?.getWorkspaceTimezone?.(
        this.#workspaceId,
      )) ?? "America/Los_Angeles";
    const now = this.#now();
    return `${now.toISOString().slice(0, 10)}:${workspaceDate(
      now,
      timeZone,
    )}`;
  }

  async #loadShared(read, model, load, request, options) {
    const policy = resolveSharedReadModelPolicy({
      read,
      workspaceId: this.#workspaceId,
      nodeEnvironment: this.#nodeEnvironment,
    });
    return this.#load({
      key: policy.key,
      model,
      load,
      request,
      ...options,
    });
  }

  async #load({
    key,
    model,
    load,
    request = null,
    force = false,
    warmReason = null,
    revisionRetries = 1,
  }) {
    const started = performance.now();
    let revisionMs = 0;
    let buildMs = 0;
    let revision = null;
    let cacheOutcome = null;
    const readInitialRevision = () => {
      if (!request || typeof request !== "object") {
        return this.#revision();
      }
      if (!request[REQUEST_REVISION_PROMISE]) {
        Object.defineProperty(request, REQUEST_REVISION_PROMISE, {
          value: Promise.resolve().then(() => this.#revision()),
          configurable: true,
        });
      }
      return request[REQUEST_REVISION_PROMISE];
    };
    const measuredRevision = async (reader) => {
      const revisionStarted = performance.now();
      try {
        revision = await reader();
        return revision;
      } finally {
        revisionMs += performance.now() - revisionStarted;
      }
    };
    const measuredLoad = async () => {
      const buildStarted = performance.now();
      try {
        return await load();
      } finally {
        buildMs += performance.now() - buildStarted;
      }
    };
    const bypass = Boolean(request?.[REQUEST_CACHE_BYPASS]);
    const payload = bypass
      ? await measuredLoad()
      : await this.#cache.getOrLoad(key, {
          getRevision: () => measuredRevision(readInitialRevision),
          recheckRevision: () =>
            measuredRevision(() => this.#revision()),
          load: measuredLoad,
          force,
          revisionRetries,
          onOutcome: (value) => {
            cacheOutcome = value;
          },
        });
    if (!bypass && revision != null && request && typeof request === "object") {
      if (!request[REQUEST_OBSERVED_REVISIONS]) {
        Object.defineProperty(request, REQUEST_OBSERVED_REVISIONS, {
          value: new Set(),
          configurable: true,
        });
      }
      request[REQUEST_OBSERVED_REVISIONS].add(String(revision));
    }
    const totalMs = performance.now() - started;
    const status = this.#cache.status();
    const outcome =
      bypass || status === "disabled"
        ? "bypass"
        : force
          ? "refresh"
          : cacheOutcome === "hit"
            ? "hit"
            : "miss";
    const timing = {
      model,
      outcome,
      totalMs: roundedMilliseconds(totalMs),
      redisMs: roundedMilliseconds(totalMs - buildMs - revisionMs),
      buildMs: roundedMilliseconds(buildMs),
    };
    recordRequestTiming(request, timing);
    this.#logger("info", "Read-model cache acquisition", {
      cache_model: model,
      cache_result: outcome,
      cache_status: status,
      redis_ms: timing.redisMs,
      build_ms: timing.buildMs,
      entry_bytes: serializedBytes(payload),
      revision,
      ...(warmReason ? { warm_reason: warmReason } : {}),
    });
    return payload;
  }

  async #revision() {
    if (this.#revisionSource?.read) {
      return this.#revisionSource.read();
    }
    return ensureWorkspaceReadModelRevision(
      this.#pool,
      this.#workspaceId,
    );
  }

  async #canonicalMonths() {
    const timeZone =
      (await this.#planningRepository?.getWorkspaceTimezone?.(
        this.#workspaceId,
      )) ?? "America/Los_Angeles";
    const current = monthStart(workspaceDate(this.#now(), timeZone));
    return { current, previous: previousMonth(current) };
  }

  #resetRequestCacheContext(request) {
    delete request[REQUEST_REVISION_PROMISE];
    delete request[REQUEST_OBSERVED_REVISIONS];
    request.readModelTimings = [];
  }
}

export function createReadModelService(options) {
  return new ReadModelService(options);
}
