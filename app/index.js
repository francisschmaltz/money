import { createServer } from "node:http";

import { createApp } from "./app.js";
import { createOidcConfiguration } from "./auth.js";
import { loadConfig } from "./config.js";
import { migrate } from "./db/index.js";
import { log } from "./log.js";
import { createRuntime } from "./runtime.js";
import { startFinanceWorker } from "./worker/index.js";

let server;
let runtime;
let workerRuntime;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "Money is shutting down", { signal });

  const hardStop = setTimeout(() => process.exit(1), 25_000);
  hardStop.unref();

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await workerRuntime?.close();
  await runtime?.close();
  clearTimeout(hardStop);
}

try {
  const config = loadConfig();
  runtime = createRuntime(config);
  if (!config.demoMode) {
    const appliedMigrations = await migrate(runtime.pool);
    log("info", "Database migrations complete", {
      appliedCount: appliedMigrations.length,
    });
  }
  const oidcConfiguration = await createOidcConfiguration(config);
  const app = createApp({ config, ...runtime, oidcConfiguration });
  server = createServer(app);
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  if (!config.demoMode) {
    workerRuntime = await startFinanceWorker(config, {
      applicationRuntime: runtime,
      onReady: () => log("info", "Finance worker ready"),
    });
  }

  server.listen(config.port, config.host, () => {
    log("info", "Money is listening", {
      host: config.host,
      port: config.port,
      mode: config.demoMode ? "demo" : "database",
    });
  });

  process.on("SIGTERM", () => {
    shutdown("SIGTERM")
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT")
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
} catch (error) {
  log("error", "Money failed to start", {
    error: {
      name: error?.name,
      message: error?.message,
    },
  });
  await workerRuntime?.close();
  await runtime?.close();
  process.exitCode = 1;
}
