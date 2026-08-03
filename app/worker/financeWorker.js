import { randomUUID } from "node:crypto";

function readModelCacheUnavailable() {
  const error = new Error("Read-model Redis warm is unavailable");
  error.name = "ReadModelCacheUnavailableError";
  return error;
}

export class FinanceWorker {
  #queue;
  #handlers;
  #workerId;
  #pollIntervalMs;
  #timer = null;
  #recoveryTimer = null;
  #recoveryOperation = null;
  #running = false;
  #activeOperation = null;

  constructor({
    queue,
    repository = null,
    plaidSyncService,
    recurringService,
    insightService,
    planningService = null,
    readModelService = null,
    readModelPublisher = null,
    workerId = `money-${randomUUID()}`,
    pollIntervalMs = 1_000,
  }) {
    this.#queue = queue;
    this.#workerId = workerId;
    this.#pollIntervalMs = pollIntervalMs;
    this.#handlers = new Map([
      [
        "plaid.sync_item",
        (payload) => plaidSyncService.syncItem(payload.itemId),
      ],
      [
        "finance.detect_recurring",
        async (payload) => {
          const detect = () =>
            recurringService.detectAndStore({
              workspaceId: payload.workspaceId,
            });
          const publishesEachStage =
            typeof readModelPublisher?.mutate === "function";
          if (publishesEachStage) {
            await readModelPublisher.mutate(
              "recurring.settled",
              detect,
              { assumeChanged: true },
            );
          } else {
            await detect();
            await readModelPublisher?.publish?.("recurring.settled");
          }
          await this.#queue.enqueue(
            "finance.generate_insights",
            { workspaceId: payload.workspaceId },
            { dedupeKey: payload.workspaceId },
          );
        },
      ],
      [
        "finance.generate_insights",
        async (payload) => {
          if (
            typeof this.#queue.hasPendingPlaidSyncs === "function" &&
            (await this.#queue.hasPendingPlaidSyncs(payload.workspaceId))
          ) {
            await this.#queue.enqueue(
              "finance.generate_insights",
              { workspaceId: payload.workspaceId },
              {
                dedupeKey: payload.workspaceId,
                runAt: new Date(Date.now() + 15_000),
              },
            );
            return;
          }
          const generate = () =>
            insightService.generateAll({
              workspaceId: payload.workspaceId,
            });
          if (typeof readModelPublisher?.mutate === "function") {
            return readModelPublisher.mutate(
              "insights.settled",
              generate,
            );
          }
          const result = await generate();
          await readModelPublisher?.publish?.("insights.settled");
          return result;
        },
      ],
      [
        "finance.nightly_refresh",
        async (payload) => {
          if (!repository) {
            throw new Error(
              "Finance repository is required for nightly refresh",
            );
          }
          const items = await repository.listPlaidItems(
            payload.workspaceId,
          );
          for (const item of items.filter(
            (candidate) => candidate.status === "active",
          )) {
            await plaidSyncService.syncItem(item.id, {
              enqueueDerived: false,
            });
          }
          const takeSnapshots = async () => {
            await repository.takeDailySnapshots(
              payload.workspaceId,
              new Date().toISOString().slice(0, 10),
            );
            return { updated: true };
          };
          const publishesEachStage =
            typeof readModelPublisher?.mutate === "function";
          if (publishesEachStage) {
            await readModelPublisher.mutate(
              "nightly.snapshots",
              takeSnapshots,
              { assumeChanged: true },
            );
            await readModelPublisher.mutate(
              "nightly.recurring",
              () => recurringService.detectAndStore({
                workspaceId: payload.workspaceId,
              }),
              { assumeChanged: true },
            );
            await readModelPublisher.mutate(
              "nightly.insights",
              () => insightService.generateAll({
                workspaceId: payload.workspaceId,
              }),
            );
          } else {
            await takeSnapshots();
            await recurringService.detectAndStore({
              workspaceId: payload.workspaceId,
            });
            await insightService.generateAll({
              workspaceId: payload.workspaceId,
            });
          }
          await planningService?.processDueGoalSchedules?.();
          if (publishesEachStage) {
            await readModelPublisher?.queueWarm?.("nightly.settled");
          } else {
            await readModelPublisher?.publish?.("nightly.settled");
          }
        },
      ],
      [
        "finance.warm_read_models",
        async (payload) => {
          if (!readModelService) return;
          const cacheStatus = readModelService.status?.();
          if (cacheStatus === "disabled") return;
          if (cacheStatus === "degraded") {
            const recovered =
              await readModelService.recoverCache?.();
            if (!recovered) throw readModelCacheUnavailable();
          }
          if (
            typeof this.#queue.hasPendingReadModelDependencies ===
              "function" &&
            (await this.#queue.hasPendingReadModelDependencies(
              payload.workspaceId,
            ))
          ) {
            await readModelPublisher?.queueWarm?.(
              payload.reason ?? "dependency-wait",
              payload.revision ?? null,
              {
                runAt: new Date(Date.now() + 15_000),
                strict: true,
              },
            );
            return;
          }
          const result = await readModelService.warmCanonicalModels({
            reason: payload.reason ?? "scheduled",
          });
          if (result.changedDuringWarm) {
            await readModelPublisher?.queueWarm?.(
              "revision-changed",
              result.revision,
              { strict: true },
            );
          }
        },
      ],
    ]);
  }

  async runOnce() {
    const job = await this.#queue.claim(this.#workerId, {
      jobTypes: [...this.#handlers.keys()],
    });
    if (!job) return false;
    const heartbeatTimer =
      typeof this.#queue.heartbeat === "function"
        ? setInterval(() => {
            this.#queue
              .heartbeat(job.id, this.#workerId)
              .catch(() => {});
          }, 60_000)
        : null;
    heartbeatTimer?.unref?.();
    try {
      await this.#handlers.get(job.type)(job.payload);
      await this.#queue.complete(job.id);
    } catch (error) {
      await this.#queue.fail(job.id, error);
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
    return true;
  }

  async start() {
    if (this.#running) return;
    this.#running = true;
    await this.#queue.recoverStale();
    this.#recoveryTimer = setInterval(() => {
      if (this.#recoveryOperation) return;
      this.#recoveryOperation = this.#queue
        .recoverStale()
        .catch(() => {})
        .finally(() => {
          this.#recoveryOperation = null;
        });
    }, 60_000);
    this.#recoveryTimer.unref?.();
    const tick = async () => {
      if (!this.#running) return;
      try {
        this.#activeOperation = this.runOnce();
        const worked = await this.#activeOperation;
        if (this.#running) {
          this.#timer = setTimeout(tick, worked ? 0 : this.#pollIntervalMs);
        }
      } catch {
        if (this.#running) {
          this.#timer = setTimeout(tick, this.#pollIntervalMs);
        }
      } finally {
        this.#activeOperation = null;
      }
      this.#timer?.unref?.();
    };
    void tick();
  }

  async stop() {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#recoveryTimer) clearInterval(this.#recoveryTimer);
    this.#recoveryTimer = null;
    if (this.#activeOperation) {
      await this.#activeOperation.catch(() => {});
    }
    if (this.#recoveryOperation) {
      await this.#recoveryOperation;
    }
  }
}

export async function enqueueNightlyFinanceJobs(
  queue,
  {
    workspaceId = "shared",
    runAt = new Date(),
    dedupeSuffix = runAt.toISOString().slice(0, 10),
  } = {},
) {
  return queue.enqueue(
    "finance.nightly_refresh",
    { workspaceId },
    {
      dedupeKey: `nightly:${workspaceId}:${dedupeSuffix}`,
      runAt,
    },
  );
}

export function createFinanceWorker(options) {
  return new FinanceWorker(options);
}
