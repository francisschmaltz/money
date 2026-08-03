import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  READ_MODEL_REDIS_PING_INTERVAL_MS,
  READ_MODEL_REDIS_COMMAND_QUEUE_LIMIT,
  READ_MODEL_REDIS_CONNECT_TIMEOUT_MS,
  READ_MODEL_REDIS_MAX_RECONNECT_DELAY_MS,
  READ_MODEL_REDIS_SOCKET_TIMEOUT_MS,
  createReadModelRedisClient,
} from "../app/cache/redisClient.js";
import { READ_MODEL_CACHE_COMMAND_TIMEOUT_MS } from "../app/cache/readModelCache.js";

class FakeRedisClient extends EventEmitter {
  constructor({ connectResult = true, closeError = null } = {}) {
    super();
    this.connectResult = connectResult;
    this.closeError = closeError;
    this.connectCalls = 0;
    this.closeCalls = 0;
    this.destroyCalls = 0;
    this.isOpen = false;
    this.isReady = false;
  }

  async connect() {
    this.connectCalls += 1;
    this.isOpen = true;
    if (this.connectResult instanceof Error) throw this.connectResult;
    this.isReady = true;
    this.emit("ready");
  }

  async close() {
    this.closeCalls += 1;
    if (this.closeError) throw this.closeError;
    this.isOpen = false;
    this.isReady = false;
  }

  destroy() {
    this.destroyCalls += 1;
    this.isOpen = false;
    this.isReady = false;
  }
}

test("off mode does not construct or connect a Redis client", async () => {
  let creations = 0;
  const redis = createReadModelRedisClient({
    mode: "off",
    url: "redis://should-not-be-used:6379",
    createClientImpl() {
      creations += 1;
    },
  });

  assert.equal(redis.client, null);
  assert.equal(redis.status(), "disabled");
  assert.equal(await redis.connection, false);
  assert.equal(creations, 0);
  await redis.close();
});

test("warm and serve modes connect asynchronously with bounded options", async () => {
  const client = new FakeRedisClient();
  let options;
  const redis = createReadModelRedisClient({
    mode: "serve",
    url: "rediss://user:password@example.invalid:6380/2",
    createClientImpl(value) {
      options = value;
      return client;
    },
  });

  assert.equal(client.connectCalls, 0);
  assert.equal(redis.status(), "degraded");
  assert.equal(await redis.connection, true);
  assert.equal(redis.status(), "ready");
  assert.equal(options.url, "rediss://user:password@example.invalid:6380/2");
  assert.equal(options.disableOfflineQueue, true);
  assert.equal(options.commandsQueueMaxLength, READ_MODEL_REDIS_COMMAND_QUEUE_LIMIT);
  assert.equal(
    options.commandOptions.timeout,
    READ_MODEL_CACHE_COMMAND_TIMEOUT_MS,
  );
  assert.equal(options.pingInterval, READ_MODEL_REDIS_PING_INTERVAL_MS);
  assert.equal(options.socket.connectTimeout, READ_MODEL_REDIS_CONNECT_TIMEOUT_MS);
  assert.equal(
    options.socket.socketTimeout,
    READ_MODEL_REDIS_SOCKET_TIMEOUT_MS,
  );
  assert.equal(options.socket.reconnectStrategy(0), 250);
  assert.equal(
    options.socket.reconnectStrategy(100),
    READ_MODEL_REDIS_MAX_RECONNECT_DELAY_MS,
  );

  await redis.close();
  assert.equal(client.closeCalls, 1);
});

test("connection failures degrade without logging URLs, credentials, or errors", async () => {
  const sensitiveUrl = "redis://secret-user:secret-password@example.invalid:6379";
  const client = new FakeRedisClient({
    connectResult: new Error(`failed to connect to ${sensitiveUrl}`),
  });
  const logs = [];
  const redis = createReadModelRedisClient({
    mode: "serve",
    url: sensitiveUrl,
    logger: (...entries) => logs.push(entries),
    createClientImpl: () => client,
  });

  assert.equal(await redis.connection, false);
  assert.equal(redis.status(), "degraded");
  const serializedLogs = JSON.stringify(logs);
  assert.equal(serializedLogs.includes("secret-user"), false);
  assert.equal(serializedLogs.includes("secret-password"), false);
  assert.equal(serializedLogs.includes("example.invalid"), false);

  await redis.close();
  assert.equal(client.closeCalls, 1);
});

test("close is idempotent and destroys the client if graceful close fails", async () => {
  const client = new FakeRedisClient({
    closeError: new Error("socket broke during shutdown"),
  });
  const redis = createReadModelRedisClient({
    mode: "warm",
    url: "redis://example.invalid:6379",
    createClientImpl: () => client,
  });
  await redis.connection;

  await redis.close();
  await redis.close();
  assert.equal(client.closeCalls, 1);
  assert.equal(client.destroyCalls, 1);
  assert.equal(redis.status(), "degraded");
});

test("closing before the connection microtask prevents a late connection", async () => {
  const client = new FakeRedisClient();
  const redis = createReadModelRedisClient({
    mode: "serve",
    url: "redis://example.invalid:6379",
    createClientImpl: () => client,
  });

  await redis.close();
  assert.equal(await redis.connection, false);
  assert.equal(client.connectCalls, 0);
});

test("missing configuration and synchronous client errors fail open", async () => {
  const logs = [];
  const missing = createReadModelRedisClient({
    mode: "warm",
    logger: (...entries) => logs.push(entries),
  });
  const failed = createReadModelRedisClient({
    mode: "serve",
    url: "redis://example.invalid:6379",
    logger: (...entries) => logs.push(entries),
    createClientImpl() {
      throw new Error("constructor failure with redis URL");
    },
  });

  assert.equal(missing.client, null);
  assert.equal(missing.status(), "degraded");
  assert.equal(await missing.connection, false);
  assert.equal(failed.client, null);
  assert.equal(failed.status(), "degraded");
  assert.equal(await failed.connection, false);
});
