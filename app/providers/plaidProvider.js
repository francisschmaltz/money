import {
  createHash,
  createPublicKey,
  createVerify,
  timingSafeEqual,
} from "node:crypto";
import { assertFinanceProvider } from "./financeProvider.js";

const HOSTS = {
  sandbox: "https://sandbox.plaid.com",
  development: "https://development.plaid.com",
  production: "https://production.plaid.com",
};

const REAUTH_CODES = new Set([
  "ITEM_LOGIN_REQUIRED",
  "PENDING_EXPIRATION",
  "USER_PERMISSION_REVOKED",
]);

export class PlaidApiError extends Error {
  constructor(message, { status, errorType, errorCode, requestId } = {}) {
    super(message);
    this.name = "PlaidApiError";
    this.status = status;
    this.errorType = errorType;
    this.code = errorCode;
    this.requestId = requestId;
    this.requiresReauth = REAUTH_CODES.has(errorCode);
    this.retryable =
      status >= 500 ||
      ["INTERNAL_SERVER_ERROR", "RATE_LIMIT_EXCEEDED"].includes(errorCode);
  }
}

export class PlaidProvider {
  #clientId;
  #secret;
  #host;
  #fetch;
  #now;
  #clientName;
  #webhookUrl;
  #keyCache = new Map();

  constructor({
    clientId = process.env.PLAID_CLIENT_ID,
    secret = process.env.PLAID_SECRET,
    environment = process.env.PLAID_ENV ?? "sandbox",
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    clientName = "Money",
    webhookUrl = null,
  } = {}) {
    if (!clientId || !secret) {
      throw new Error("PLAID_CLIENT_ID and PLAID_SECRET are required");
    }
    if (!HOSTS[environment]) {
      throw new Error(`Unsupported Plaid environment: ${environment}`);
    }
    if (typeof fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required");
    }
    this.#clientId = clientId;
    this.#secret = secret;
    this.#host = HOSTS[environment];
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#clientName = clientName;
    this.#webhookUrl = webhookUrl;
  }

  async #request(path, body = {}) {
    const response = await this.#fetch(`${this.#host}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "plaid-version": "2020-09-14",
      },
      body: JSON.stringify({
        client_id: this.#clientId,
        secret: this.#secret,
        ...body,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new PlaidApiError("Plaid returned an invalid response", {
        status: response.status,
      });
    }

    if (!response.ok || payload.error_code) {
      throw new PlaidApiError(payload.error_message ?? "Plaid request failed", {
        status: response.status,
        errorType: payload.error_type,
        errorCode: payload.error_code,
        requestId: payload.request_id,
      });
    }
    return payload;
  }

  async createLinkToken({
    userId,
    accessToken = null,
    redirectUri = null,
    countryCodes = ["US"],
    language = "en",
  }) {
    const result = await this.#request("/link/token/create", {
      user: { client_user_id: String(userId) },
      client_name: this.#clientName,
      ...(accessToken
        ? { access_token: accessToken }
        : {
            products: ["transactions"],
            additional_consented_products: ["investments", "liabilities"],
            transactions: { days_requested: 365 },
          }),
      country_codes: countryCodes,
      language,
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      ...(this.#webhookUrl ? { webhook: this.#webhookUrl } : {}),
    });
    return {
      linkToken: result.link_token,
      expiration: result.expiration,
      requestId: result.request_id,
    };
  }

  async exchangePublicToken(publicToken) {
    const result = await this.#request("/item/public_token/exchange", {
      public_token: publicToken,
    });
    return {
      accessToken: result.access_token,
      providerItemId: result.item_id,
      requestId: result.request_id,
    };
  }

  async getAccounts(accessToken) {
    return this.#request("/accounts/get", { access_token: accessToken });
  }

  async syncTransactions(accessToken, cursor = null) {
    const originalCursor = cursor;
    for (let restart = 0; restart < 3; restart += 1) {
      const added = [];
      const modified = [];
      const removed = [];
      let accounts = [];
      let nextCursor = originalCursor;
      try {
        do {
          const page = await this.#request("/transactions/sync", {
            access_token: accessToken,
            cursor: nextCursor,
            count: 500,
          });
          added.push(...(page.added ?? []));
          modified.push(...(page.modified ?? []));
          removed.push(...(page.removed ?? []));
          accounts = page.accounts ?? accounts;
          nextCursor = page.next_cursor;
          if (!page.has_more) break;
        } while (true);
        return { added, modified, removed, accounts, nextCursor };
      } catch (error) {
        if (
          error instanceof PlaidApiError &&
          error.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" &&
          restart < 2
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new PlaidApiError("Plaid transaction sync could not stabilize");
  }

  async getInvestmentHoldings(accessToken) {
    return this.#request("/investments/holdings/get", {
      access_token: accessToken,
    });
  }

  async getInvestmentTransactions(
    accessToken,
    { startDate, endDate } = {},
  ) {
    const investmentTransactions = [];
    const securities = [];
    let accounts = [];
    if (startDate && endDate) {
      let offset = 0;
      do {
        const page = await this.#request(
          "/investments/transactions/get",
          {
            access_token: accessToken,
            start_date: startDate,
            end_date: endDate,
            options: { count: 500, offset },
          },
        );
        const pageTransactions = page.investment_transactions ?? [];
        investmentTransactions.push(...pageTransactions);
        securities.push(...(page.securities ?? []));
        accounts = page.accounts ?? accounts;
        offset += pageTransactions.length;
        const total = Number(
          page.total_investment_transactions ?? page.total ?? offset,
        );
        if (!pageTransactions.length || offset >= total) {
          break;
        }
      } while (true);
    }
    return {
      accounts,
      securities: deduplicateBy(
        securities,
        (security) => security.security_id,
      ),
      investmentTransactions,
    };
  }

  async getInvestments(accessToken, { startDate, endDate } = {}) {
    const holdings = await this.getInvestmentHoldings(accessToken);
    const transactions = await this.getInvestmentTransactions(accessToken, {
      startDate,
      endDate,
    });
    return {
      accounts:
        holdings.accounts?.length
          ? holdings.accounts
          : transactions.accounts,
      holdings: holdings.holdings ?? [],
      securities: deduplicateBy(
        [
          ...(holdings.securities ?? []),
          ...transactions.securities,
        ],
        (security) => security.security_id,
      ),
      investmentTransactions: transactions.investmentTransactions,
    };
  }

  async getLiabilities(accessToken) {
    return this.#request("/liabilities/get", {
      access_token: accessToken,
    });
  }

  async removeItem(accessToken) {
    await this.#request("/item/remove", { access_token: accessToken });
  }

  async verifyWebhook(rawBody, verificationHeader) {
    if (!Buffer.isBuffer(rawBody)) {
      throw new TypeError("Plaid webhook verification requires raw bytes");
    }
    if (!verificationHeader) return false;

    const segments = verificationHeader.split(".");
    if (segments.length !== 3) return false;
    let header;
    let claims;
    try {
      header = JSON.parse(
        Buffer.from(segments[0], "base64url").toString("utf8"),
      );
      claims = JSON.parse(
        Buffer.from(segments[1], "base64url").toString("utf8"),
      );
    } catch {
      return false;
    }
    if (header.alg !== "ES256" || typeof header.kid !== "string") return false;

    const issuedAt = Number(claims.iat);
    const ageSeconds = this.#now().getTime() / 1000 - issuedAt;
    if (!Number.isFinite(issuedAt) || ageSeconds < -30 || ageSeconds > 300) {
      return false;
    }

    const bodyDigest = createHash("sha256").update(rawBody).digest();
    let claimedDigest;
    try {
      claimedDigest = Buffer.from(claims.request_body_sha256, "hex");
    } catch {
      return false;
    }
    if (
      claimedDigest.length !== bodyDigest.length ||
      !timingSafeEqual(claimedDigest, bodyDigest)
    ) {
      return false;
    }

    const key = await this.#getVerificationKey(header.kid);
    const verifier = createVerify("SHA256");
    verifier.update(`${segments[0]}.${segments[1]}`);
    verifier.end();
    return verifier.verify(
      { key: createPublicKey({ key, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      Buffer.from(segments[2], "base64url"),
    );
  }

  async #getVerificationKey(kid) {
    const cached = this.#keyCache.get(kid);
    if (cached && cached.expiresAt > this.#now().getTime()) {
      return cached.key;
    }
    const result = await this.#request("/webhook_verification_key/get", {
      key_id: kid,
    });
    this.#keyCache.set(kid, {
      key: result.key,
      expiresAt: this.#now().getTime() + 60 * 60_000,
    });
    return result.key;
  }
}

function deduplicateBy(values, key) {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

export function createPlaidProvider(options) {
  return assertFinanceProvider(new PlaidProvider(options));
}
