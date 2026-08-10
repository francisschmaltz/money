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

function syncStageErrorCode(stage) {
  const normalized = String(stage ?? "unknown")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `SYNC_${normalized || "UNKNOWN"}_ERROR`;
}

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
  #logger;
  #markReadModelSourceUnstable;
  #publishReadModelBoundary;

  constructor({
    provider,
    repository,
    secretRepository,
    jobQueue = null,
    now = () => new Date(),
    workspaceId = "shared",
    logger = null,
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
    if (logger != null && typeof logger !== "function") {
      throw new TypeError("logger must be a function");
    }
    this.#logger = logger;
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
    const activeProviderAccountIds = new Set();
    const accountsByProviderId = new Map();
    const persistProviderAccounts = async (providerAccounts = []) => {
      const accounts = providerAccounts.map((account) =>
        normalizePlaidAccount(account, item.institution_name),
      );
      if (accounts.length) {
        await this.#repository.upsertAccounts(itemId, accounts);
      }
      for (const account of accounts) {
        activeProviderAccountIds.add(account.provider_account_id);
        accountsByProviderId.set(account.provider_account_id, account);
      }
      stats.accounts = accountsByProviderId.size;
      return accounts;
    };
    const persistHoldings = async (holdingsResult) => {
      await persistProviderAccounts(holdingsResult.accounts ?? []);
      const holdings = (holdingsResult.holdings ?? []).map((holding) =>
        normalizePlaidHolding(
          holding,
          accountsByProviderId.get(holding.account_id)?.currency_code,
        ),
      );
      const holdingCurrencyBySecurityId = new Map(
        holdings.map((holding) => [
          holding.provider_security_id,
          holding.currency_code,
        ]),
      );
      const fundedInvestmentAccount = [...accountsByProviderId.values()].some(
        (account) =>
          account.type === "investment" &&
          Number.isSafeInteger(account.current_balance_minor) &&
          account.current_balance_minor > 0,
      );
      if (!holdings.length && fundedInvestmentAccount) {
        stats.optional_product_warnings.push({
          product: "investment_holdings",
          code: "EMPTY_HOLDINGS_WITH_POSITIVE_BALANCE",
        });
      } else {
        await this.#repository.replaceInvestments(itemId, {
          securities: (holdingsResult.securities ?? []).map((security) =>
            normalizePlaidSecurity(
              security,
              holdingCurrencyBySecurityId.get(security.security_id),
            ),
          ),
          holdings,
          asOf: this.#now(),
        });
      }
      stats.holdings = holdings.length;
    };
    let finalBoundaryCommitted = false;
    let stage = "accounts_fetch";

    try {
      const accountResponse = await this.#provider.getAccounts(accessToken);
      stage = "accounts_persist";
      const normalizedAccounts = await persistProviderAccounts(
        accountResponse.accounts ?? [],
      );

      stage = "transactions_fetch";
      const transactionSync = await this.#provider.syncTransactions(
        accessToken,
        item.transactions_cursor,
      );
      stage = "transactions_normalize";
      const added = transactionSync.added.map(normalizePlaidTransaction);
      const modified = transactionSync.modified.map(normalizePlaidTransaction);
      stage = "transactions_persist";
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
          stage = "investment_holdings_fetch";
          const holdingsResult = await this.#optionalProduct(
            "investment_holdings",
            () => this.#provider.getInvestmentHoldings(accessToken),
            stats,
          );
          if (holdingsResult) {
            stage = "investment_holdings_persist";
            await persistHoldings(holdingsResult);
          }

          stage = "investment_transactions_fetch";
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
            stage = "investment_transactions_persist";
            await persistProviderAccounts(
              transactionsResult.accounts ?? [],
            );
            const transactions = (
              transactionsResult.investmentTransactions ?? []
            ).map((transaction) =>
              normalizePlaidInvestmentTransaction(
                transaction,
                accountsByProviderId.get(transaction.account_id)
                  ?.currency_code,
              ),
            );
            await this.#repository.replaceInvestments(itemId, {
              securities: (transactionsResult.securities ?? []).map(
                (security) => normalizePlaidSecurity(security),
              ),
              transactions,
              asOf: this.#now(),
            });
            stats.investment_transactions = transactions.length;
          }
        } else {
          stage = "investments_fetch";
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
            stage = "investments_persist";
            await persistHoldings(investmentResult);
            const transactions =
              investmentResult.investmentTransactions.map((transaction) =>
                normalizePlaidInvestmentTransaction(
                  transaction,
                  accountsByProviderId.get(transaction.account_id)
                    ?.currency_code,
                ),
              );
            await this.#repository.replaceInvestments(itemId, {
              securities: (investmentResult.securities ?? []).map(
                (security) => normalizePlaidSecurity(security),
              ),
              transactions,
              asOf: this.#now(),
            });
            stats.investment_transactions = transactions.length;
          }
        }
      }

      stage = "accounts_finalize";
      await this.#repository.deactivateMissingAccounts(
        itemId,
        [...activeProviderAccountIds],
      );

      if (normalizedAccounts.some(supportsPlaidLiabilities)) {
        stage = "liabilities_fetch";
        const liabilityResult = await this.#optionalProduct(
          "liabilities",
          () => this.#provider.getLiabilities(accessToken),
          stats,
        );
        if (liabilityResult) {
          stage = "liabilities_persist";
          const liabilities = normalizePlaidLiabilities(liabilityResult);
          await this.#repository.replaceLiabilities(itemId, liabilities, {
            asOf: this.#now(),
          });
          stats.liabilities = liabilities.length;
        }
      }

      stage = "sync_finalize";
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
        stage = "derived_enqueue";
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
          : [
                "INVESTMENT_HOLDINGS_PERSISTENCE_MISMATCH",
                "INVESTMENT_TRANSACTIONS_PERSISTENCE_MISMATCH",
              ].includes(error?.code)
            ? error.code
            : syncStageErrorCode(stage);
      stats.failure_stage = stage;
      try {
        this.#logger?.("error", "Plaid sync failed", {
          connectionId: itemId,
          runId,
          stage,
          syncErrorCode: code,
          sourceErrorName: error?.name ?? "Error",
          sourceErrorCode:
            typeof error?.code === "string" ? error.code : null,
          retryable: Boolean(error?.retryable),
          stats,
        });
      } catch {
        // Logging must never hide the original sync failure.
      }
      if (!finalBoundaryCommitted) {
        await this.#transaction(async (client) => {
          await this.#repository.updatePlaidItemState(itemId, {
            status:
              error instanceof PlaidApiError && error.requiresReauth
                ? "reauth_required"
                : "error",
            errorCode: code,
            coverageWarnings: stats.optional_product_warnings,
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
