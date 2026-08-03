import {
  bumpWorkspaceReadModelRevision,
  ensureWorkspaceReadModelRevision,
  markWorkspaceReadModelSourceUnstable,
  publishWorkspaceReadModelClock,
  publishStableWorkspaceReadModelRevision,
} from "../db/workspaceReadModelRevision.js";
import { log } from "../log.js";

const DEFAULT_WORKSPACE_ID = "shared";
const READ_MODEL_CHANGED = Symbol.for("money.readModelChanged");
const READ_MODEL_WARM_MAX_ATTEMPTS = 100;

const FINANCE_MUTATIONS = new Map(
  [
    "batchEditTransactions",
    "attachPendingEditRecovery",
    "dismissPendingEditRecovery",
    "updateTransactionNote",
    "createTransactionCleanupRule",
    "updateTransactionCleanupRule",
    "deleteTransactionCleanupRule",
    "rerunTransactionCleanupRules",
    "updateTransactionClassification",
    "updateAccountBalanceGroup",
    "createManualAsset",
    "updateManualAsset",
    "archiveManualAsset",
    "createCreditScoreSource",
    "updateCreditScoreSource",
    "archiveCreditScoreSource",
    "upsertCreditScoreObservation",
    "actOnFinding",
    "batchActOnFindings",
    "updateRecurringClassification",
    "upsertTransactionRecurringPattern",
    "removeTransactionRecurringPattern",
    "updateInsightRule",
    "setInsightsEnabled",
    "saveInsightLlmSettings",
    "clearInsights",
    "createSpendingCategory",
    "updateSpendingCategory",
    "mergeSpendingCategories",
    "deleteSpendingCategory",
    "splitSpendingCategory",
  ].map((method) => [method, `finance.${method}`]),
);

function mutationChanged(result) {
  if (result == null || result === false) return false;
  if (Array.isArray(result)) return true;
  if (typeof result !== "object") return true;
  if (typeof result[READ_MODEL_CHANGED] === "boolean") {
    return result[READ_MODEL_CHANGED];
  }
  if (
    result.replayed === true ||
    result.ignored === true ||
    result.skipped === true
  ) {
    return false;
  }
  const mutationSignals = ["changed", "created", "deleted", "updated"];
  if (
    mutationSignals.some(
      (field) => Object.hasOwn(result, field) && result[field] === true,
    )
  ) {
    return true;
  }
  if (
    Object.hasOwn(result, "processed") &&
    Number(result.processed) === 0
  ) {
    return false;
  }
  const presentSignals = mutationSignals.filter((field) =>
    Object.hasOwn(result, field),
  );
  if (
    presentSignals.length > 0 &&
    presentSignals.every((field) => result[field] === false)
  ) {
    return false;
  }
  return true;
}

function bound(target, property) {
  const value = Reflect.get(target, property, target);
  return typeof value === "function" ? value.bind(target) : value;
}

export class ReadModelRevisionSource {
  #pool;
  #workspaceId;
  #unsafe = false;

  constructor({ pool, workspaceId = DEFAULT_WORKSPACE_ID } = {}) {
    if (!pool) throw new TypeError("pool is required");
    this.#pool = pool;
    this.#workspaceId = workspaceId;
  }

  async read() {
    if (this.#unsafe) {
      throw new Error("Read-model revision publication is unsafe");
    }
    return ensureWorkspaceReadModelRevision(
      this.#pool,
      this.#workspaceId,
    );
  }

  async bump(db = this.#pool) {
    try {
      const revision = await bumpWorkspaceReadModelRevision(
        db,
        this.#workspaceId,
      );
      this.#unsafe = false;
      return revision;
    } catch (error) {
      this.#unsafe = true;
      throw error;
    }
  }

  async publishClock(clockToken, db = this.#pool) {
    try {
      const revision = await publishWorkspaceReadModelClock(
        db,
        this.#workspaceId,
        clockToken,
      );
      this.#unsafe = false;
      return revision;
    } catch (error) {
      this.#unsafe = true;
      throw error;
    }
  }

  markUnsafe() {
    this.#unsafe = true;
  }

  markSafe() {
    this.#unsafe = false;
  }
}

export class ReadModelPublisher {
  #revisionSource;
  #jobQueue;
  #workspaceId;
  #logger;
  #enabled;
  #transactionRunner;

  constructor({
    revisionSource,
    jobQueue = null,
    workspaceId = DEFAULT_WORKSPACE_ID,
    logger = log,
    enabled = true,
    transactionRunner = null,
  } = {}) {
    if (!revisionSource) throw new TypeError("revisionSource is required");
    this.#revisionSource = revisionSource;
    this.#jobQueue = jobQueue;
    this.#workspaceId = workspaceId;
    this.#logger = logger;
    this.#enabled = enabled;
    this.#transactionRunner = transactionRunner;
  }

  async publish(reason) {
    if (typeof this.#transactionRunner !== "function") {
      const revision = await this.#revisionSource.bump();
      await this.queueWarm(reason, revision, { strict: true });
      return revision;
    }
    let revision = null;
    await this.#transactionRunner(async (client) => {
      revision = await this.#revisionSource.bump(client);
      await this.queueWarm(reason, revision, {
        client,
        strict: true,
      });
    });
    return revision;
  }

  async publishClockBoundary(reason, clockToken) {
    const publish = (client = undefined) =>
      typeof this.#revisionSource.publishClock === "function"
        ? this.#revisionSource.publishClock(clockToken, client)
        : this.#revisionSource.bump(client);
    if (typeof this.#transactionRunner !== "function") {
      const revision = await publish();
      await this.queueWarm(reason, revision, { strict: true });
      return revision;
    }
    let revision = null;
    await this.#transactionRunner(async (client) => {
      revision = await publish(client);
      await this.queueWarm(reason, revision, {
        client,
        strict: true,
      });
    });
    return revision;
  }

  async bumpInTransaction(
    client,
    sourceId,
    reason = "plaid.sync-settled",
  ) {
    try {
      const revision = await publishStableWorkspaceReadModelRevision(
        client,
        this.#workspaceId,
        sourceId,
      );
      await this.queueWarm(reason, revision, {
        client,
        strict: true,
      });
      this.#revisionSource.markSafe?.();
      return revision;
    } catch (error) {
      this.#revisionSource.markUnsafe?.();
      throw error;
    }
  }

  async markSourceUnstableInTransaction(client, sourceId) {
    try {
      return await markWorkspaceReadModelSourceUnstable(
        client,
        this.#workspaceId,
        sourceId,
      );
    } catch (error) {
      this.#revisionSource.markUnsafe?.();
      throw error;
    }
  }

  async mutate(reason, operation, { assumeChanged = false } = {}) {
    if (typeof operation !== "function") {
      throw new TypeError("mutation operation is required");
    }
    if (typeof this.#transactionRunner !== "function") {
      const result = await operation();
      if (assumeChanged || mutationChanged(result)) await this.publish(reason);
      return result;
    }

    let changed = false;
    let revision = null;
    const result = await this.#transactionRunner(async (client) => {
      const value = await operation();
      changed = assumeChanged || mutationChanged(value);
      if (changed) {
        revision = await bumpWorkspaceReadModelRevision(
          client,
          this.#workspaceId,
        );
        await this.queueWarm(reason, revision, {
          client,
          strict: true,
        });
      }
      return value;
    });
    if (changed) {
      this.#revisionSource.markSafe?.();
    }
    return result;
  }

  async queueWarm(
    reason,
    revision = null,
    { runAt, client = null, strict = false } = {},
  ) {
    if (!this.#enabled) {
      return null;
    }
    if (!this.#jobQueue) {
      if (strict) {
        throw new Error("Read-model warm queue is unavailable");
      }
      return null;
    }
    try {
      const expectedRevision =
        revision ?? (await this.#revisionSource.read());
      return await this.#jobQueue.enqueue(
        "finance.warm_read_models",
        {
          workspaceId: this.#workspaceId,
          revision: expectedRevision,
          reason,
        },
        {
          dedupeKey: this.#workspaceId,
          maxAttempts: READ_MODEL_WARM_MAX_ATTEMPTS,
          ...(client ? { client } : {}),
          ...(runAt ? { runAt } : {}),
        },
      );
    } catch (error) {
      this.#logger("error", "Read-model warm enqueue failed", {
        warm_reason: reason,
      });
      if (strict) throw error;
      return null;
    }
  }
}

export function createCachedFinanceService({
  service,
  readModels,
  publisher,
} = {}) {
  if (!service || !readModels || !publisher) {
    throw new TypeError("service, readModels, and publisher are required");
  }
  return new Proxy(service, {
    get(target, property) {
      if (property === "getPageData") {
        return (view, request, options) =>
          readModels.getFinancePageData(view, request, options);
      }
      if (property === "getFinanceOverview") {
        return (input, request, options) =>
          readModels.getFinanceOverview(input, request, options);
      }
      if (property === "listTransactions") {
        return (input, request, options) =>
          readModels.listRecentTransactions(input, request, options);
      }
      if (property === "listAccounts") {
        return (input, request, options) =>
          readModels.listAccountCatalog(input, request, options);
      }
      if (property === "getFinanceInsights") {
        return (input, request, options) =>
          readModels.getActiveInsights(input, request, options);
      }
      if (property === "getNetWorthHistory") {
        return (input, request, options) =>
          readModels.getBoundedHistory(input, request, options);
      }
      if (property === "listSpendingCategories") {
        return (input, request, options) =>
          readModels.listSpendingCategories(input, request, options);
      }
      if (FINANCE_MUTATIONS.has(property)) {
        return async (...args) => {
          if (typeof publisher.mutate === "function") {
            return publisher.mutate(
              FINANCE_MUTATIONS.get(property),
              () => bound(target, property)(...args),
            );
          }
          const result = await bound(target, property)(...args);
          if (mutationChanged(result)) {
            await publisher.publish(FINANCE_MUTATIONS.get(property));
          }
          return result;
        };
      }
      return bound(target, property);
    },
  });
}

export function createCachedPlanningService({
  service,
  readModels,
  publisher,
} = {}) {
  if (!service || !readModels || !publisher) {
    throw new TypeError("service, readModels, and publisher are required");
  }
  return new Proxy(service, {
    get(target, property) {
      if (property === "getPlanningOverview") {
        return (input, request, options) =>
          readModels.getPlanningOverview(input, request, options);
      }
      if (property === "getSafeToSpend") {
        return (input, request, options) =>
          readModels.getSafeToSpend(input, request, options);
      }
      if (property === "getBudgetStatus") {
        return (input, request, options) =>
          readModels.getBudgetStatus(input, request, options);
      }
      if (property === "executeIdempotentWrite") {
        return async (...args) => {
          const result = await bound(target, property)(...args);
          // PgPlanningRepository publishes the revision in the same
          // transaction. Queueing here also covers harmless replays.
          await publisher.queueWarm("planning.write");
          return result;
        };
      }
      if (property === "processDueGoalSchedules") {
        return async (...args) => {
          const result = await bound(target, property)(...args);
          if (mutationChanged(result)) {
            await publisher.queueWarm("planning.goal-schedules");
          }
          return result;
        };
      }
      return bound(target, property);
    },
  });
}

export function createPublishedPlaidSyncService({ service, publisher } = {}) {
  if (!service || !publisher) {
    throw new TypeError("service and publisher are required");
  }
  return new Proxy(service, {
    get(target, property) {
      if (property === "syncItem") {
        return async (...args) => {
          try {
            const result = await bound(target, property)(...args);
            await publisher.queueWarm("plaid.sync-finished");
            return result;
          } catch (error) {
            await publisher.queueWarm("plaid.sync-partial-failure");
            throw error;
          }
        };
      }
      if (
        [
          "exchangeAndLink",
          "removeItem",
          "queueSync",
          "handleWebhook",
        ].includes(property)
      ) {
        return async (...args) => {
          if (typeof publisher.mutate === "function") {
            return publisher.mutate(
              `plaid.${String(property)}`,
              () => bound(target, property)(...args),
            );
          }
          const result = await bound(target, property)(...args);
          if (mutationChanged(result)) {
            await publisher.publish(`plaid.${String(property)}`);
          }
          return result;
        };
      }
      return bound(target, property);
    },
  });
}

export function createPublishedAppleCardImportService({
  service,
  publisher,
} = {}) {
  if (!service || !publisher) {
    throw new TypeError("service and publisher are required");
  }
  return new Proxy(service, {
    get(target, property) {
      if (["import", "updateAccount", "remove"].includes(property)) {
        return async (...args) => {
          if (typeof publisher.mutate === "function") {
            return publisher.mutate(
              `apple-card.${String(property)}`,
              () => bound(target, property)(...args),
            );
          }
          const result = await bound(target, property)(...args);
          if (mutationChanged(result)) {
            await publisher.publish(`apple-card.${String(property)}`);
          }
          return result;
        };
      }
      return bound(target, property);
    },
  });
}

export function createReadModelRevisionSource(options) {
  return new ReadModelRevisionSource(options);
}

export function createReadModelPublisher(options) {
  return new ReadModelPublisher(options);
}
