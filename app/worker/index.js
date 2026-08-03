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

const SIX_HOUR_WARM_RETRY_DELAYS_MS = Object.freeze([
  15_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
]);

export {
  FinanceWorker,
  createFinanceWorker,
  enqueueNightlyFinanceJobs,
} from "./financeWorker.js";

export async function startReadModelWarmSchedule({
  readModelService,
  readModelPublisher,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (
    !readModelService ||
    !readModelPublisher ||
    readModelService.status?.() === "disabled"
  ) {
    return { close() {} };
  }

  let rolloverToken = await readModelService.rolloverToken();
  if (typeof readModelPublisher.publishClockBoundary === "function") {
    await readModelPublisher.publishClockBoundary(
      "startup",
      rolloverToken,
    );
  } else {
    await readModelPublisher.publish("startup");
  }
  let closed = false;
  const retryTimers = new Set();
  const queueSixHourWarm = async (attempt = 0) => {
    try {
      await readModelPublisher.queueWarm(
        "six-hour",
        null,
        { strict: true },
      );
    } catch {
      if (closed || attempt >= SIX_HOUR_WARM_RETRY_DELAYS_MS.length) {
        return;
      }
      const timer = setTimeoutImpl(() => {
        retryTimers.delete(timer);
        return queueSixHourWarm(attempt + 1);
      }, SIX_HOUR_WARM_RETRY_DELAYS_MS[attempt]);
      retryTimers.add(timer);
      timer.unref?.();
    }
  };
  const sixHourTimer = setIntervalImpl(
    () => queueSixHourWarm(),
    6 * 60 * 60_000,
  );
  sixHourTimer.unref?.();

  const rolloverTimer = setIntervalImpl(
    () =>
      Promise.resolve(readModelService.rolloverToken())
        .then(async (nextToken) => {
          if (nextToken === rolloverToken) return;
          if (
            typeof readModelPublisher.publishClockBoundary ===
            "function"
          ) {
            await readModelPublisher.publishClockBoundary(
              "date-rollover",
              nextToken,
            );
          } else {
            await readModelPublisher.publish("date-rollover");
          }
          rolloverToken = nextToken;
        })
        .catch(() => {}),
    60_000,
  );
  rolloverTimer.unref?.();

  return {
    close() {
      closed = true;
      clearIntervalImpl(sixHourTimer);
      clearIntervalImpl(rolloverTimer);
      for (const timer of retryTimers) clearTimeoutImpl(timer);
      retryTimers.clear();
    },
  };
}

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
    readModelService = null,
    readModelPublisher = null,
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
    readModelService,
    readModelPublisher,
    pollIntervalMs: config.worker.pollIntervalMs,
  });

  let nightlyTimer = null;
  let readModelWarmSchedule = null;
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
  const scheduleReadModelWarmers = async () => {
    readModelWarmSchedule = await startReadModelWarmSchedule({
      readModelService,
      readModelPublisher,
    });
  };
  try {
    await worker.start();
    await scheduleNightly();
    await scheduleReadModelWarmers();
    onReady?.();
  } catch (error) {
    if (nightlyTimer) clearTimeout(nightlyTimer);
    readModelWarmSchedule?.close();
    await worker.stop().catch(() => {});
    throw error;
  }

  return {
    worker,
    async close() {
      if (nightlyTimer) clearTimeout(nightlyTimer);
      readModelWarmSchedule?.close();
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
