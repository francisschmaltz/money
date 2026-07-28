import {
  createInsightService,
  LmStudioNarrativeService,
  RecurringService,
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
  config,
  { onReady = null, applicationRuntime = null } = {},
) {
  if (!config || config.demoMode) {
    throw new Error("The finance worker requires DATABASE_URL");
  }
  const {
    repository,
    jobQueue: queue,
    plaidSyncService,
    planningService,
    narrativeService: runtimeNarrativeService,
  } = applicationRuntime ?? {};
  const missing = [
    ["repository", repository],
    ["jobQueue", queue],
    ["plaidSyncService", plaidSyncService],
    ["planningService", planningService],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(
      `Application runtime is missing worker dependencies: ${missing.join(", ")}`,
    );
  }

  const recurringService = new RecurringService({ repository });
  const narrativeService =
    runtimeNarrativeService ??
    new LmStudioNarrativeService({
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
    planningService,
    pollIntervalMs: config.worker.pollIntervalMs,
  });

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
  try {
    await worker.start();
    await scheduleNightly();
    onReady?.();
  } catch (error) {
    if (nightlyTimer) clearTimeout(nightlyTimer);
    await worker.stop().catch(() => {});
    throw error;
  }

  return {
    worker,
    async close() {
      if (nightlyTimer) clearTimeout(nightlyTimer);
      await worker.stop();
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
