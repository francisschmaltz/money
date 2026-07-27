import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import {
  createPgPool,
  PgFinanceRepository,
  PgJobQueue,
  PgPlaidSecretRepository,
} from "../db/index.js";
import { createPlaidProvider } from "../providers/index.js";
import {
  createInsightService,
  LmStudioNarrativeService,
  RecurringService,
  createPlaidSyncService,
} from "../services/index.js";
import {
  FinanceWorker,
  createFinanceWorker,
  enqueueNightlyFinanceJobs,
} from "./financeWorker.js";

export {
  FinanceWorker,
  createFinanceWorker,
  enqueueNightlyFinanceJobs,
} from "./financeWorker.js";

export async function startFinanceWorker(
  config = loadConfig(),
  { onReady = null } = {},
) {
  if (config.demoMode) {
    throw new Error("The finance worker requires DATABASE_URL");
  }
  const pool = createPgPool({
    connectionString: config.database.url,
    ssl: config.database.ssl,
    applicationName: "money-worker",
  });
  const repository = new PgFinanceRepository(pool);
  const secretRepository = new PgPlaidSecretRepository(pool);
  const queue = new PgJobQueue(pool);
  const provider = createPlaidProvider({
    clientId: config.plaid.clientId,
    secret: config.plaid.secret,
    environment: config.plaid.environment,
    webhookUrl: config.plaid.webhookUrl,
  });
  const plaidSyncService = createPlaidSyncService({
    provider,
    repository,
    secretRepository,
    jobQueue: queue,
  });
  const recurringService = new RecurringService({ repository });
  const narrativeService = new LmStudioNarrativeService({
    endpoint: config.lmStudio.baseUrl,
    model: config.lmStudio.model,
    apiKey: config.lmStudio.apiKey,
  });
  const insightService = createInsightService({
    repository,
    narrativeService,
    baseUrl: config.mcp.cardBaseUrl,
  });
  const worker = createFinanceWorker({
    queue,
    repository,
    plaidSyncService,
    recurringService,
    insightService,
    pollIntervalMs: config.worker.pollIntervalMs,
  });
  await worker.start();

  let nightlyTimer = null;
  const scheduleNightly = async () => {
    const target = nextUtcHour(config.worker.nightlyInsightsHourUtc);
    await enqueueNightlyFinanceJobs(queue, {
      runAt: target,
      dedupeSuffix: target.toISOString().slice(0, 10),
    });
    nightlyTimer = setTimeout(
      () => {
        scheduleNightly().catch(() => {});
      },
      Math.max(1_000, target.getTime() - Date.now() + 60_000),
    );
    nightlyTimer.unref?.();
  };
  await scheduleNightly();
  onReady?.();

  return {
    worker,
    pool,
    async close() {
      if (nightlyTimer) clearTimeout(nightlyTimer);
      await worker.stop();
      await pool.end();
    },
  };
}

function nextUtcHour(hour) {
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(hour, 0, 0, 0);
  if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
  return target;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let runtime;
  const shutdown = async () => {
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
    await runtime?.close();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  startFinanceWorker(undefined, {
    onReady: () => process.stdout.write("Finance worker ready.\n"),
  })
    .then((started) => {
      runtime = started;
    })
    .catch((error) => {
      process.stderr.write(
        `Finance worker failed: ${error.name}${error.code ? `:${error.code}` : ""}\n`,
      );
      process.exitCode = 1;
    });
}
