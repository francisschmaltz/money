import { createClient } from "redis";
import { READ_MODEL_CACHE_COMMAND_TIMEOUT_MS } from "./readModelCache.js";

export const READ_MODEL_REDIS_CONNECT_TIMEOUT_MS = 1_500;
export const READ_MODEL_REDIS_MAX_RECONNECT_DELAY_MS = 10_000;
export const READ_MODEL_REDIS_COMMAND_QUEUE_LIMIT = 32;
export const READ_MODEL_REDIS_SOCKET_TIMEOUT_MS = 10_000;
export const READ_MODEL_REDIS_PING_INTERVAL_MS = 5_000;

const CACHE_MODES = new Set(["off", "warm", "serve"]);

function normalizeMode(value) {
  const mode = String(value ?? "off").trim().toLowerCase();
  if (!CACHE_MODES.has(mode)) {
    throw new TypeError("Read-model cache mode must be off, warm, or serve.");
  }
  return mode;
}

function reconnectDelay(retries) {
  const attempt = Math.max(0, Number.isFinite(retries) ? retries : 0);
  return Math.min(
    READ_MODEL_REDIS_MAX_RECONNECT_DELAY_MS,
    250 * 2 ** Math.min(attempt, 6),
  );
}

function safeLog(logger, level, message, metadata) {
  try {
    if (typeof logger === "function") {
      logger(level, message, metadata);
      return;
    }
    logger?.[level]?.(message, metadata);
  } catch {
    // Cache diagnostics must never make application startup or reads fail.
  }
}

function disabledConnection(mode) {
  return {
    client: null,
    connection: Promise.resolve(false),
    mode,
    status: () => "disabled",
    async close() {},
  };
}

function degradedConnection({ mode, logger, message }) {
  safeLog(logger, "warn", message, { cache: "degraded" });
  return {
    client: null,
    connection: Promise.resolve(false),
    mode,
    status: () => "degraded",
    async close() {},
  };
}

export function createReadModelRedisClient({
  mode = "off",
  url = "",
  logger = null,
  createClientImpl = createClient,
} = {}) {
  const normalizedMode = normalizeMode(mode);
  if (normalizedMode === "off") return disabledConnection(normalizedMode);
  if (typeof url !== "string" || !url.trim()) {
    return degradedConnection({
      mode: normalizedMode,
      logger,
      message: "Read-model Redis is unavailable because it is not configured",
    });
  }

  let client;
  try {
    client = createClientImpl({
      url,
      name: "money-read-model-cache",
      commandsQueueMaxLength: READ_MODEL_REDIS_COMMAND_QUEUE_LIMIT,
      disableOfflineQueue: true,
      commandOptions: {
        timeout: READ_MODEL_CACHE_COMMAND_TIMEOUT_MS,
      },
      pingInterval: READ_MODEL_REDIS_PING_INTERVAL_MS,
      socket: {
        connectTimeout: READ_MODEL_REDIS_CONNECT_TIMEOUT_MS,
        socketTimeout: READ_MODEL_REDIS_SOCKET_TIMEOUT_MS,
        keepAlive: true,
        keepAliveInitialDelay: 5_000,
        reconnectStrategy: reconnectDelay,
      },
    });
  } catch {
    return degradedConnection({
      mode: normalizedMode,
      logger,
      message: "Read-model Redis client initialization failed",
    });
  }

  let state = "connecting";
  let closed = false;

  const markDegraded = () => {
    if (closed || state === "degraded") return;
    state = "degraded";
    safeLog(logger, "warn", "Read-model Redis is unavailable", {
      cache: "degraded",
    });
  };
  const markReady = () => {
    if (closed) return;
    const readyState = normalizedMode === "warm" ? "warming" : "ready";
    if (state === readyState) return;
    state = readyState;
    safeLog(logger, "info", "Read-model Redis is ready", {
      cache: readyState,
    });
  };

  client.on?.("error", markDegraded);
  client.on?.("reconnecting", markDegraded);
  client.on?.("ready", markReady);
  client.on?.("end", markDegraded);

  const connection = Promise.resolve()
    .then(async () => {
      if (closed) return false;
      await client.connect();
      if (closed) return false;
      markReady();
      return true;
    })
    .catch(() => {
      markDegraded();
      return false;
    });

  return {
    client,
    connection,
    mode: normalizedMode,
    status() {
      if (closed) return "degraded";
      if (client.isReady === true) {
        return normalizedMode === "warm" ? "warming" : "ready";
      }
      return state === "warming" || state === "ready" ? state : "degraded";
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        if (client.isOpen === true && typeof client.close === "function") {
          await client.close();
        }
      } catch {
        try {
          client.destroy?.();
        } catch {
          // Redis is optional; shutdown should not be held hostage by it.
        }
      }
    },
  };
}
