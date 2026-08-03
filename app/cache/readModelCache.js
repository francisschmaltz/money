export const READ_MODEL_CACHE_SCHEMA = "money.read-model.v1";
export const READ_MODEL_CACHE_TTL_SECONDS = 12 * 60 * 60;
export const READ_MODEL_CACHE_MAX_ENTRY_BYTES = 512 * 1024;
export const READ_MODEL_CACHE_COMMAND_TIMEOUT_MS = 150;

const CACHE_MODES = new Set(["off", "warm", "serve"]);
const CACHE_MISS = Object.freeze({ hit: false });

async function withCommandTimeout(operation, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Read-model Redis command timed out");
      error.name = "ReadModelRedisTimeoutError";
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizedMode(value) {
  const mode = String(value ?? "off").trim().toLowerCase();
  if (!CACHE_MODES.has(mode)) {
    throw new TypeError("Read-model cache mode must be off, warm, or serve.");
  }
  return mode;
}

function normalizedCacheKey(value) {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (
    key.length > 512 ||
    !/^money:[a-z0-9._-]{1,128}:v1:workspace:[a-z0-9._-]{1,128}:[a-z0-9:._-]{1,256}$/i.test(
      key,
    )
  ) {
    return null;
  }
  return key;
}

function normalizedRevision(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  const revision = value.trim();
  return revision && revision.length <= 128 ? revision : null;
}

function serializedValue(value) {
  if (typeof value === "string") {
    return {
      bytes: Buffer.byteLength(value, "utf8"),
      text: value,
    };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const buffer = Buffer.from(value);
    return {
      bytes: buffer.byteLength,
      text: buffer.toString("utf8"),
    };
  }
  return null;
}

function validEnvelope(value, revision) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.schema === READ_MODEL_CACHE_SCHEMA &&
      value.revision === revision &&
      typeof value.generated_at === "string" &&
      Number.isFinite(Date.parse(value.generated_at)) &&
      Object.hasOwn(value, "payload"),
  );
}

export class RedisReadModelCache {
  #client;
  #mode;
  #now;
  #degraded = false;
  #failureGeneration = 0;
  #inFlight = new Map();
  #commandTimeoutMs;

  constructor({
    client = null,
    mode = "off",
    now = () => new Date(),
    commandTimeoutMs = READ_MODEL_CACHE_COMMAND_TIMEOUT_MS,
  } = {}) {
    this.#client = client;
    this.#mode = normalizedMode(mode);
    if (typeof now !== "function") {
      throw new TypeError("Read-model cache clock must be a function.");
    }
    this.#now = now;
    if (!Number.isFinite(commandTimeoutMs) || commandTimeoutMs <= 0) {
      throw new TypeError("Redis command timeout must be positive.");
    }
    this.#commandTimeoutMs = commandTimeoutMs;
  }

  status() {
    if (this.#mode === "off") return "disabled";
    if (
      !this.#client ||
      this.#degraded ||
      this.#client.isReady === false
    ) {
      return "degraded";
    }
    return this.#mode === "warm" ? "warming" : "ready";
  }

  failureGeneration() {
    return this.#failureGeneration;
  }

  async probe() {
    if (this.#mode === "off") return false;
    if (
      this.#client?.isReady !== true ||
      typeof this.#client?.ping !== "function"
    ) {
      this.#markFailure();
      return false;
    }
    try {
      await withCommandTimeout(
        () => this.#client.ping(),
        this.#commandTimeoutMs,
      );
      this.#degraded = false;
      return true;
    } catch {
      this.#markFailure();
      return false;
    }
  }

  async get(key, { revision } = {}) {
    if (this.#mode !== "serve") return CACHE_MISS;
    const keyName = normalizedCacheKey(key);
    const expectedRevision = normalizedRevision(revision);
    if (
      !keyName ||
      !expectedRevision ||
      this.#client?.isReady === false ||
      typeof this.#client?.get !== "function"
    ) {
      if (
        !this.#client ||
        this.#client?.isReady === false ||
        typeof this.#client?.get !== "function"
      ) {
        this.#markFailure();
      }
      return CACHE_MISS;
    }

    let raw;
    try {
      raw = await withCommandTimeout(
        () => this.#client.get(keyName),
        this.#commandTimeoutMs,
      );
      this.#degraded = false;
    } catch {
      this.#markFailure();
      return CACHE_MISS;
    }
    if (raw == null) return CACHE_MISS;

    const serialized = serializedValue(raw);
    if (
      !serialized ||
      serialized.bytes > READ_MODEL_CACHE_MAX_ENTRY_BYTES
    ) {
      if (!(await this.#discard(keyName))) this.#markFailure();
      return CACHE_MISS;
    }

    let envelope;
    try {
      envelope = JSON.parse(serialized.text);
    } catch {
      if (!(await this.#discard(keyName))) this.#markFailure();
      return CACHE_MISS;
    }
    if (envelope?.revision !== expectedRevision) return CACHE_MISS;
    if (!validEnvelope(envelope, expectedRevision)) {
      if (!(await this.#discard(keyName))) this.#markFailure();
      return CACHE_MISS;
    }
    return { hit: true, payload: envelope.payload };
  }

  async set(key, payload, { revision } = {}) {
    if (this.#mode === "off") return false;
    const keyName = normalizedCacheKey(key);
    const normalized = normalizedRevision(revision);
    if (
      !keyName ||
      !normalized ||
      payload === undefined ||
      this.#client?.isReady === false ||
      typeof this.#client?.set !== "function"
    ) {
      if (
        !this.#client ||
        this.#client?.isReady === false ||
        typeof this.#client?.set !== "function"
      ) {
        this.#markFailure();
      }
      return false;
    }

    let value;
    try {
      value = JSON.stringify({
        schema: READ_MODEL_CACHE_SCHEMA,
        revision: normalized,
        generated_at: new Date(this.#now()).toISOString(),
        payload,
      });
    } catch {
      return false;
    }
    if (
      typeof value !== "string" ||
      Buffer.byteLength(value, "utf8") > READ_MODEL_CACHE_MAX_ENTRY_BYTES
    ) {
      return false;
    }

    try {
      await withCommandTimeout(
        () =>
          this.#client.set(keyName, value, {
            EX: READ_MODEL_CACHE_TTL_SECONDS,
          }),
        this.#commandTimeoutMs,
      );
      this.#degraded = false;
      return true;
    } catch {
      this.#markFailure();
      return false;
    }
  }

  async getOrLoad(
    key,
    {
      getRevision,
      recheckRevision = getRevision,
      load,
      force = false,
      onOutcome = null,
      revisionRetries = 1,
    } = {},
  ) {
    if (typeof load !== "function") {
      throw new TypeError("Read-model cache loader must be a function.");
    }
    if (![0, 1].includes(revisionRetries)) {
      throw new TypeError("Revision retries must be zero or one.");
    }
    const keyName = normalizedCacheKey(key);
    if (!keyName) {
      onOutcome?.("bypass");
      return load();
    }
    if (this.#mode === "off") {
      onOutcome?.("bypass");
      return this.#singleFlight(`uncached:${keyName}`, load);
    }
    if (typeof getRevision !== "function") {
      onOutcome?.("bypass");
      return this.#singleFlight(`uncached:${keyName}`, load);
    }

    const revision = await this.#readRevision(getRevision);
    if (!revision) {
      onOutcome?.("bypass");
      return this.#singleFlight(`uncached:${keyName}`, load);
    }
    return this.#resolve(
      keyName,
      revision,
      recheckRevision,
      load,
      revisionRetries,
      Boolean(force),
      onOutcome,
    );
  }

  async #resolve(
    keyName,
    revision,
    recheckRevision,
    load,
    retriesRemaining,
    force,
    onOutcome,
  ) {
    const cached = force
      ? CACHE_MISS
      : await this.get(keyName, { revision });
    if (cached.hit) {
      onOutcome?.("hit");
      return cached.payload;
    }
    onOutcome?.("miss");

    const outcome = await this.#singleFlight(
      `${keyName}:${revision}:${retriesRemaining}`,
      async () => {
        const payload = await load();
        const observedRevision = await this.#readRevision(
          recheckRevision,
        );
        if (observedRevision === revision) {
          await this.set(keyName, payload, { revision });
          return { payload, retryRevision: null };
        }
        if (observedRevision && retriesRemaining > 0) {
          return { payload, retryRevision: observedRevision };
        }
        return { payload, retryRevision: null };
      },
    );
    if (outcome.retryRevision) {
      return this.#resolve(
        keyName,
        outcome.retryRevision,
        recheckRevision,
        load,
        retriesRemaining - 1,
        force,
        onOutcome,
      );
    }
    return outcome.payload;
  }

  async #readRevision(getRevision) {
    try {
      return normalizedRevision(await getRevision());
    } catch {
      return null;
    }
  }

  async #singleFlight(key, operation) {
    const existing = this.#inFlight.get(key);
    if (existing) return existing;
    const pending = Promise.resolve().then(operation);
    this.#inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.#inFlight.get(key) === pending) {
        this.#inFlight.delete(key);
      }
    }
  }

  async #discard(key) {
    if (typeof this.#client?.del !== "function") return false;
    try {
      await withCommandTimeout(
        () => this.#client.del(key),
        this.#commandTimeoutMs,
      );
      this.#degraded = false;
      return true;
    } catch {
      // Cache cleanup is best effort and must never affect the source read.
      return false;
    }
  }

  #markFailure() {
    this.#degraded = true;
    this.#failureGeneration += 1;
  }
}

export function createReadModelCache(options = {}) {
  return new RedisReadModelCache(options);
}
