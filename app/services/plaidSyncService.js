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
  "ADDITIONAL_CONSENT_REQUIRED",
]);

export class PlaidSyncService {
  #provider;
  #repository;
  #secretRepository;
  #jobQueue;
  #now;
  #workspaceId;

  constructor({
    provider,
    repository,
    secretRepository,
    jobQueue = null,
    now = () => new Date(),
    workspaceId = "shared",
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
      status: "active",
      errorCode: null,
    });
    const job = await this.#jobQueue.enqueue(
      "plaid.sync_item",
      { itemId },
      { dedupeKey: itemId },
    );
    return { queued: true, item_id: itemId, job_id: job.id };
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
      await this.#jobQueue.enqueue(
        "plaid.sync_item",
        { itemId: item.id },
        { dedupeKey: item.id },
      );
    }
    return { ...item, itemId: item.id };
  }

  async syncItem(itemId, { enqueueDerived = true } = {}) {
    const item = await this.#repository.getPlaidItem(itemId);
    if (!item || item.status === "removed") {
      throw new Error("Plaid Item not found");
    }
    const accessToken = await this.#requiredAccessToken(itemId);
    const runId = await this.#repository.startSyncRun({
      workspaceId: item.workspace_id,
      itemId,
      syncType: "plaid_full",
    });
    await this.#repository.updatePlaidItemState(itemId, {
      status: "syncing",
      errorCode: null,
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

    try {
      const accountResponse = await this.#provider.getAccounts(accessToken);
      const normalizedAccounts = (accountResponse.accounts ?? []).map(
        (account) =>
          normalizePlaidAccount(account, item.institution_name),
      );
      await this.#repository.upsertAccounts(itemId, normalizedAccounts, {
        syncedAt: this.#now(),
      });
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
        syncedAt: this.#now(),
      });
      stats.transactions_added = added.length;
      stats.transactions_modified = modified.length;
      stats.transactions_removed = transactionSync.removed.length;

      if (
        normalizedAccounts.some(
          (account) => account.type === "investment",
        )
      ) {
        const investmentResult = await this.#optionalProduct(
          "investments",
          () =>
            this.#provider.getInvestments(accessToken, {
              startDate: shiftDate(this.#now(), -730),
              endDate: dateOnly(this.#now()),
            }),
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

      if (
        normalizedAccounts.some((account) =>
          ["credit", "loan"].includes(account.type),
        )
      ) {
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

      if (this.#jobQueue && enqueueDerived) {
        await this.#jobQueue.enqueue(
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
    await this.#secretRepository.delete(itemId);
    await this.#repository.removePlaidItem(itemId, { retainHistory });
    if (this.#jobQueue) {
      await this.#jobQueue.enqueue(
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
    if (!item) return { accepted: true, ignored: true };

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
      return { accepted: true, queued: false };
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
        await this.#jobQueue.enqueue(
          "plaid.sync_item",
          { itemId: item.id },
          { dedupeKey: item.id },
        );
      }
      return { accepted: true, queued: Boolean(this.#jobQueue) };
    }

    const shouldSync =
      webhook.webhook_type === "TRANSACTIONS" ||
      webhook.webhook_type === "HOLDINGS" ||
      webhook.webhook_type === "INVESTMENTS_TRANSACTIONS" ||
      webhook.webhook_type === "LIABILITIES";
    if (shouldSync && this.#jobQueue) {
      await this.#jobQueue.enqueue(
        "plaid.sync_item",
        { itemId: item.id },
        { dedupeKey: item.id },
      );
    }
    return { accepted: true, queued: shouldSync && Boolean(this.#jobQueue) };
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
