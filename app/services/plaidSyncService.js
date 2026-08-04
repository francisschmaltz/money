import { randomUUID } from "node:crypto";
import {
  normalizePlaidAccount,
  normalizePlaidHolding,
  normalizePlaidInvestmentTransaction,
  normalizePlaidLiabilities,
  normalizePlaidSecurity,
  normalizePlaidTransaction,
} from "../providers/plaidNormalizer.js";
import { PlaidApiError } from "../providers/plaidProvider.js";

const OPTIONAL_PRODUCT_ERRORS = new Set([
  "PRODUCT_NOT_READY",
  "NO_INVESTMENT_ACCOUNTS",
  "NO_LIABILITY_ACCOUNTS",
  "PRODUCTS_NOT_SUPPORTED",
  "ADDITIONAL_CONSENT_REQUIRED",
]);
const READ_MODEL_CHANGED = Symbol.for("money.readModelChanged");

function webhookResult(value, changed) {
  Object.defineProperty(value, READ_MODEL_CHANGED, {
    value: Boolean(changed),
  });
  return value;
}

export class PlaidSyncService {
  #provider;
  #repository;
  #secretRepository;
  #jobQueue;
  #now;
  #workspaceId;
  #markReadModelSourceUnstable;
  #publishReadModelBoundary;

  constructor({
    provider,
    repository,
    secretRepository,
    jobQueue = null,
    now = () => new Date(),
    workspaceId = "shared",
    markReadModelSourceUnstable = null,
    publishReadModelBoundary = null,
  }) {
    if (!provider || !repository || !secretRepository) {
      throw new TypeError(
        "provider, repository, and secretRepository are required",
      );
    }
    this.#provider = provider;
    this.#repository = repository;
    this.#secretRepository = secretRepository;
    this.#jobQueue = jobQueue;
    this.#now = now;
    this.#workspaceId = workspaceId;
    if (
      markReadModelSourceUnstable != null &&
      typeof markReadModelSourceUnstable !== "function"
    ) {
      throw new TypeError(
        "markReadModelSourceUnstable must be a function",
      );
    }
    this.#markReadModelSourceUnstable =
      markReadModelSourceUnstable;
    if (
      publishReadModelBoundary != null &&
      typeof publishReadModelBoundary !== "function"
    ) {
      throw new TypeError("publishReadModelBoundary must be a function");
    }
    this.#publishReadModelBoundary = publishReadModelBoundary;
  }

  createLinkToken({ userId, redirectUri = null }) {
    return this.#provider.createLinkToken({ userId, redirectUri });
  }

  async createUpdateLinkToken({ itemId, userId, redirectUri = null }) {
    const accessToken = await this.#requiredAccessToken(itemId);
    return this.#provider.createLinkToken({
      userId,
      accessToken,
      redirectUri,
    });
  }

  async queueSync(itemId) {
    const item = await this.#repository.getPlaidItem(itemId);
    if (!item || item.status === "removed") {
      const error = new Error("Plaid Item not found");
      error.statusCode = 404;
      throw error;
    }
    if (!this.#jobQueue) {
      return this.syncItem(itemId);
    }
    await this.#repository.updatePlaidItemState(itemId, {
      status: "syncing",
      errorCode: null,
    });
    const response = { queued: true, item_id: itemId, job_id: null };
    await this.#enqueueJob(
      "plaid.sync_item",
      { itemId },
      { dedupeKey: itemId },
      (job) => {
        response.job_id = job.id;
      },
    );
    return response;
  }

  async exchangeAndLink({
    publicToken,
    institutionId = null,
    institutionName = null,
    workspaceId = this.#workspaceId,
  }) {
    if (!publicToken) throw new TypeError("publicToken is required");
    const exchange = await this.#provider.exchangePublicToken(publicToken);
    const itemId = randomUUID();
    const item = await this.#repository.transaction(async (client) => {
      const created = await this.#repository.createPlaidItem(
        {
          id: itemId,
          workspaceId,
          providerItemId: exchange.providerItemId,
          institutionId,
          institutionName,
        },
        client,
      );
      await this.#secretRepository.put(
        created.id,
        exchange.accessToken,
        client,
      );
      return created;
    });

    if (this.#jobQueue) {
      await this.#repository.updatePlaidItemState(item.id, {
        status: "syncing",
        errorCode: null,
      });
      await this.#enqueueJob(
        "plaid.sync_item",
        { itemId: item.id },
        { dedupeKey: item.id },
      );
    }
    return { ...item, itemId: item.id };
  }

  async syncItem(itemId, { enqueueDerived = true } = {}) {
    const sync = () =>
      this.#syncItem(itemId, { enqueueDerived });
    if (typeof this.#repository.withPlaidSyncLock === "function") {
      return this.#repository.withPlaidSyncLock(itemId, sync);
    }
    return sync();
  }

  async #syncItem(itemId, { enqueueDerived }) {
    const item = await this.#repository.getPlaidItem(itemId);
    if (!item || item.status === "removed") {
      throw new Error("Plaid Item not found");
    }
    const accessToken = await this.#requiredAccessToken(itemId);
    let runId;
    await this.#transaction(async (client) => {
      await this.#markReadModelSourceUnstable?.(
        client,
        item.workspace_id,
        itemId,
      );
      runId = await this.#repository.startSyncRun({
        workspaceId: item.workspace_id,
        itemId,
        syncType: "plaid_full",
      });
      await this.#repository.updatePlaidItemState(itemId, {
        status: "syncing",
        errorCode: null,
      });
    });

    const stats = {
      accounts: 0,
      transactions_added: 0,
      transactions_modified: 0,
      transactions_removed: 0,
      holdings: 0,
      investment_transactions: 0,
      liabilities: 0,
      optional_product_warnings: [],
    };
    let finalBoundaryCommitted = false;

    try {
      const accountResponse = await this.#provider.getAccounts(accessToken);
      const normalizedAccounts = (accountResponse.accounts ?? []).map(
        (account) =>
          normalizePlaidAccount(account, item.institution_name),
      );
      await this.#repository.upsertAccounts(itemId, normalizedAccounts);
      await this.#repository.deactivateMissingAccounts(
        itemId,
        normalizedAccounts.map((account) => account.provider_account_id),
      );
      stats.accounts = normalizedAccounts.length;

      const transactionSync = await this.#provider.syncTransactions(
        accessToken,
        item.transactions_cursor,
      );
      const added = transactionSync.added.map(normalizePlaidTransaction);
      const modified = transactionSync.modified.map(normalizePlaidTransaction);
      await this.#repository.applyTransactionSync({
        itemId,
        added,
        modified,
        removedProviderIds: transactionSync.removed.map(
          (transaction) => transaction.transaction_id,
        ),
        cursor: transactionSync.nextCursor,
      });
      stats.transactions_added = added.length;
      stats.transactions_modified = modified.length;
      stats.transactions_removed = transactionSync.removed.length;

      if (
        normalizedAccounts.some(
          (account) => account.type === "investment",
        )
      ) {
        const investmentOptions = {
          startDate: shiftDate(this.#now(), -730),
          endDate: dateOnly(this.#now()),
        };
        if (
          typeof this.#provider.getInvestmentHoldings === "function" &&
          typeof this.#provider.getInvestmentTransactions === "function"
        ) {
          const holdingsResult = await this.#optionalProduct(
            "investment_holdings",
            () => this.#provider.getInvestmentHoldings(accessToken),
            stats,
          );
          if (holdingsResult) {
            const holdings = (holdingsResult.holdings ?? []).map(
              normalizePlaidHolding,
            );
            await this.#repository.replaceInvestments(itemId, {
              securities: (holdingsResult.securities ?? []).map(
                normalizePlaidSecurity,
              ),
              holdings,
              asOf: this.#now(),
            });
            stats.holdings = holdings.length;
          }

          const transactionsResult = await this.#optionalProduct(
            "investment_transactions",
            () =>
              this.#provider.getInvestmentTransactions(
                accessToken,
                investmentOptions,
              ),
            stats,
          );
          if (transactionsResult) {
            const transactions = (
              transactionsResult.investmentTransactions ?? []
            ).map(normalizePlaidInvestmentTransaction);
            await this.#repository.replaceInvestments(itemId, {
              securities: (transactionsResult.securities ?? []).map(
                normalizePlaidSecurity,
              ),
              transactions,
              asOf: this.#now(),
            });
            stats.investment_transactions = transactions.length;
          }
        } else {
          const investmentResult = await this.#optionalProduct(
            "investments",
            () =>
              this.#provider.getInvestments(
                accessToken,
                investmentOptions,
              ),
            stats,
          );
          if (investmentResult) {
            const securities = investmentResult.securities.map(
              normalizePlaidSecurity,
            );
            const holdings = investmentResult.holdings.map(
              normalizePlaidHolding,
            );
            const transactions =
              investmentResult.investmentTransactions.map(
                normalizePlaidInvestmentTransaction,
              );
            await this.#repository.replaceInvestments(itemId, {
              securities,
              holdings,
              transactions,
              asOf: this.#now(),
            });
            stats.holdings = holdings.length;
            stats.investment_transactions = transactions.length;
          }
        }
      }

      if (normalizedAccounts.some(supportsPlaidLiabilities)) {
        const liabilityResult = await this.#optionalProduct(
          "liabilities",
          () => this.#provider.getLiabilities(accessToken),
          stats,
        );
        if (liabilityResult) {
          const liabilities = normalizePlaidLiabilities(liabilityResult);
          await this.#repository.replaceLiabilities(itemId, liabilities, {
            asOf: this.#now(),
          });
          stats.liabilities = liabilities.length;
        }
      }

      await this.#transaction(async (client) => {
        await this.#repository.updatePlaidItemState(itemId, {
          status: "active",
          errorCode: null,
          lastSyncedAt: this.#now(),
          coverageWarnings: stats.optional_product_warnings,
        });
        await this.#repository.takeDailySnapshots(
          item.workspace_id,
          dateOnly(this.#now()),
        );
        await this.#repository.rebuildSearchDocuments(item.workspace_id);
        await this.#repository.finishSyncRun(runId, {
          status: "succeeded",
          stats,
        });
        await this.#publishReadModelBoundary?.(
          client,
          item.workspace_id,
          itemId,
          "plaid.sync-finished",
        );
      });
      finalBoundaryCommitted = true;

      if (this.#jobQueue && enqueueDerived) {
        await this.#enqueueJob(
          "finance.detect_recurring",
          { workspaceId: item.workspace_id },
          { dedupeKey: item.workspace_id },
        );
      }
      return stats;
    } catch (error) {
      const code =
        error instanceof PlaidApiError
          ? error.code ?? "PLAID_ERROR"
          : "SYNC_ERROR";
      if (!finalBoundaryCommitted) {
        await this.#transaction(async (client) => {
          await this.#repository.updatePlaidItemState(itemId, {
            status:
              error instanceof PlaidApiError && error.requiresReauth
                ? "reauth_required"
                : "error",
            errorCode: code,
          });
          await this.#repository.finishSyncRun(runId, {
            status: "failed",
            stats,
            errorCode: code,
          });
          await this.#publishReadModelBoundary?.(
            client,
            item.workspace_id,
            itemId,
            "plaid.sync-partial-failure",
          );
        });
      }
      throw error;
    }
  }

  async removeItem(itemId, { retainHistory = false } = {}) {
    const item = await this.#repository.getPlaidItem(itemId);
    if (!item) return false;
    const accessToken = await this.#requiredAccessToken(itemId);
    try {
      await this.#provider.removeItem(accessToken);
    } catch (error) {
      if (
        !(error instanceof PlaidApiError) ||
        !["ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN"].includes(error.code)
      ) {
        throw error;
      }
    }
    const removed = await this.#transaction(async (client) => {
      const changed = await this.#repository.removePlaidItem(itemId, {
        retainHistory,
      });
      if (!changed) return false;
      await this.#secretRepository.delete(itemId, client ?? undefined);
      return true;
    });
    if (!removed) return false;
    if (this.#jobQueue) {
      await this.#enqueueJob(
        "finance.detect_recurring",
        { workspaceId: item.workspace_id },
        { dedupeKey: item.workspace_id },
      );
    }
    return true;
  }

  async handleWebhook({ rawBody, verificationHeader }) {
    const valid = await this.#provider.verifyWebhook(
      rawBody,
      verificationHeader,
    );
    if (!valid) {
      const error = new Error("Invalid Plaid webhook signature");
      error.statusCode = 401;
      throw error;
    }

    let webhook;
    try {
      webhook = JSON.parse(rawBody.toString("utf8"));
    } catch {
      const error = new Error("Invalid Plaid webhook payload");
      error.statusCode = 400;
      throw error;
    }
    const item = webhook.item_id
      ? await this.#repository.getPlaidItemByProviderId(webhook.item_id)
      : null;
    if (!item) {
      return webhookResult({ accepted: true, ignored: true }, false);
    }

    const reauthWebhookCodes = new Set([
      "PENDING_EXPIRATION",
      "PENDING_DISCONNECT",
      "USER_PERMISSION_REVOKED",
      "USER_ACCOUNT_REVOKED",
    ]);
    if (
      webhook.webhook_type === "ITEM" &&
      (webhook.webhook_code === "ERROR" ||
        reauthWebhookCodes.has(webhook.webhook_code))
    ) {
      const errorCode =
        webhook.webhook_code === "ERROR"
          ? webhook.error?.error_code ?? "ITEM_ERROR"
          : webhook.webhook_code;
      const reauth = [
        "ITEM_LOGIN_REQUIRED",
        "PENDING_EXPIRATION",
        "PENDING_DISCONNECT",
        "USER_PERMISSION_REVOKED",
        "USER_ACCOUNT_REVOKED",
      ].includes(errorCode);
      await this.#repository.updatePlaidItemState(item.id, {
        status: reauth ? "reauth_required" : "error",
        errorCode,
      });
      return webhookResult({ accepted: true, queued: false }, true);
    }

    if (
      webhook.webhook_type === "ITEM" &&
      webhook.webhook_code === "LOGIN_REPAIRED"
    ) {
      await this.#repository.updatePlaidItemState(item.id, {
        status: "active",
        errorCode: null,
      });
      if (this.#jobQueue) {
        await this.#enqueueJob(
          "plaid.sync_item",
          { itemId: item.id },
          { dedupeKey: item.id },
        );
      }
      return webhookResult(
        { accepted: true, queued: Boolean(this.#jobQueue) },
        true,
      );
    }

    const shouldSync =
      webhook.webhook_type === "TRANSACTIONS" ||
      webhook.webhook_type === "HOLDINGS" ||
      webhook.webhook_type === "INVESTMENTS_TRANSACTIONS" ||
      webhook.webhook_type === "LIABILITIES";
    if (shouldSync && this.#jobQueue) {
      await this.#enqueueJob(
        "plaid.sync_item",
        { itemId: item.id },
        { dedupeKey: item.id },
      );
    }
    return webhookResult(
      { accepted: true, queued: shouldSync && Boolean(this.#jobQueue) },
      false,
    );
  }

  #transaction(operation) {
    if (typeof this.#repository.transaction === "function") {
      return this.#repository.transaction(operation);
    }
    return operation(null);
  }

  async #enqueueJob(jobType, payload, options, onEnqueued = null) {
    if (!this.#jobQueue) return null;
    const client = this.#repository.transactionClient?.() ?? null;
    const job = await this.#jobQueue.enqueue(jobType, payload, {
      ...options,
      ...(client ? { client } : {}),
    });
    onEnqueued?.(job);
    return job;
  }

  async #requiredAccessToken(itemId) {
    const token = await this.#secretRepository.get(itemId);
    if (!token) throw new Error("Plaid Item credential not found");
    return token;
  }

  async #optionalProduct(label, operation, stats) {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof PlaidApiError &&
        OPTIONAL_PRODUCT_ERRORS.has(error.code)
      ) {
        stats.optional_product_warnings.push({
          product: label,
          code: error.code,
        });
        return null;
      }
      throw error;
    }
  }
}

function supportsPlaidLiabilities(account) {
  return (
    (account.type === "credit" &&
      ["credit card", "paypal"].includes(account.subtype)) ||
    (account.type === "loan" &&
      ["student", "mortgage"].includes(account.subtype))
  );
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function shiftDate(date, days) {
  const shifted = new Date(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return dateOnly(shifted);
}

export function createPlaidSyncService(dependencies) {
  return new PlaidSyncService(dependencies);
}
