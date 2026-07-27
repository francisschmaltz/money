import {
  exactDecimalToMinor,
  parseAppleCardCsv,
} from "../providers/appleCardCsv.js";

function requiredDate(value, fieldName) {
  const normalized = String(value ?? "").trim();
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(normalized) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized
  ) {
    throw new TypeError(`${fieldName} must be an ISO date`);
  }
  return normalized;
}

function optionalMoney(value, fieldName, { nonnegative = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  let minor;
  try {
    minor = exactDecimalToMinor(value);
  } catch {
    throw new TypeError(`${fieldName} must be an exact dollar amount`);
  }
  if (nonnegative && minor < 0) {
    throw new TypeError(`${fieldName} cannot be negative`);
  }
  return minor;
}

function optionalLastFour(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (!/^\d{4}$/.test(normalized)) {
    throw new TypeError("lastFour must contain exactly four digits");
  }
  return normalized;
}

function actorId(actor) {
  return actor?.id ?? null;
}

export class AppleCardImportService {
  #repository;
  #jobQueue;
  #workspaceId;
  #now;

  constructor({
    repository,
    jobQueue = null,
    workspaceId = "shared",
    now = () => new Date(),
  }) {
    if (!repository) throw new TypeError("repository is required");
    this.#repository = repository;
    this.#jobQueue = jobQueue;
    this.#workspaceId = workspaceId;
    this.#now = now;
  }

  async preview({ fileBuffer }) {
    const parsed = parseAppleCardCsv(fileBuffer);
    const existing = new Set(
      await this.#repository.findExistingTransactionProviderIds(
        this.#workspaceId,
        parsed.transactions.map((row) => row.provider_transaction_id),
      ),
    );
    const existingCount = parsed.transactions.reduce(
      (count, row) =>
        count + Number(existing.has(row.provider_transaction_id)),
      0,
    );
    return {
      preview_digest: parsed.digest,
      posted_start_on: parsed.posted_start_on,
      posted_end_on: parsed.posted_end_on,
      charge_total_minor: parsed.charge_total_minor,
      credit_total_minor: parsed.credit_total_minor,
      total_row_count: parsed.total_row_count,
      accepted_row_count: parsed.accepted_row_count,
      new_row_count: parsed.accepted_row_count - existingCount,
      existing_row_count: existingCount,
      rejected_row_count: parsed.rejected_row_count,
      warning_count: parsed.warning_count,
      rejected: parsed.rejected,
      warnings: parsed.warnings,
    };
  }

  async import(
    {
      fileBuffer,
      previewDigest,
      balance,
      creditLimit,
      balanceAsOf,
      lastFour,
    },
    actor = null,
  ) {
    const parsed = parseAppleCardCsv(fileBuffer);
    if (
      !/^[a-f0-9]{64}$/.test(String(previewDigest ?? "")) ||
      parsed.digest !== previewDigest
    ) {
      const error = new Error(
        "The CSV no longer matches the preview. Preview it again.",
      );
      error.statusCode = 409;
      error.expose = true;
      throw error;
    }
    if (parsed.rejected_row_count > 0 || parsed.accepted_row_count === 0) {
      throw new TypeError(
        "The CSV must contain at least one valid row and no rejected rows",
      );
    }

    const existingConnection =
      await this.#repository.getAppleCardConnection(this.#workspaceId);
    const balanceMinor = optionalMoney(balance, "balance");
    const creditLimitMinor = optionalMoney(
      creditLimit,
      "creditLimit",
      { nonnegative: true },
    );
    const normalizedBalanceAsOf =
      balanceAsOf == null || String(balanceAsOf).trim() === ""
        ? null
        : requiredDate(balanceAsOf, "balanceAsOf");
    const normalizedLastFour = optionalLastFour(lastFour);
    const cardValues = [
      balanceMinor,
      creditLimitMinor,
      normalizedBalanceAsOf,
    ];
    if (
      cardValues.some((value) => value != null) &&
      cardValues.some((value) => value == null)
    ) {
      throw new TypeError(
        "balance, creditLimit, and balanceAsOf must be supplied together",
      );
    }
    if (
      !existingConnection &&
      (balanceMinor == null ||
        creditLimitMinor == null ||
        normalizedBalanceAsOf == null)
    ) {
      throw new TypeError(
        "balance, creditLimit, and balanceAsOf are required for the first import",
      );
    }

    const result = await this.#repository.importAppleCardTransactions({
      workspaceId: this.#workspaceId,
      parsed,
      balanceMinor,
      creditLimitMinor,
      balanceAsOf: normalizedBalanceAsOf,
      lastFour: normalizedLastFour,
      actorId: actorId(actor),
      importedAt: this.#now(),
    });
    await this.#enqueueDerived();
    return result;
  }

  async updateAccount(
    { balance, creditLimit, balanceAsOf, lastFour },
    actor = null,
  ) {
    const balanceMinor = optionalMoney(balance, "balance");
    const creditLimitMinor = optionalMoney(creditLimit, "creditLimit", {
      nonnegative: true,
    });
    if (balanceMinor == null || creditLimitMinor == null) {
      throw new TypeError("balance and creditLimit are required");
    }
    const result = await this.#repository.updateAppleCardAccount({
      workspaceId: this.#workspaceId,
      balanceMinor,
      creditLimitMinor,
      balanceAsOf: requiredDate(balanceAsOf, "balanceAsOf"),
      lastFour: optionalLastFour(lastFour),
      actorId: actorId(actor),
      updatedAt: this.#now(),
    });
    if (!result) {
      const error = new Error("Apple Card connection not found");
      error.statusCode = 404;
      error.expose = true;
      throw error;
    }
    await this.#enqueueDerived();
    return result;
  }

  async remove({ retainHistory = false } = {}) {
    const connection =
      await this.#repository.getAppleCardConnection(this.#workspaceId);
    if (!connection) return false;
    await this.#repository.removeFinanceConnection(connection.id, {
      retainHistory,
    });
    await this.#enqueueDerived();
    return true;
  }

  async #enqueueDerived() {
    if (!this.#jobQueue) return;
    await this.#jobQueue.enqueue(
      "finance.detect_recurring",
      { workspaceId: this.#workspaceId },
      { dedupeKey: this.#workspaceId },
    );
  }
}

export function createAppleCardImportService(options) {
  return new AppleCardImportService(options);
}
