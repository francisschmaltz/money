import { randomUUID } from "node:crypto";

export class FinanceWorker {
  #queue;
  #handlers;
  #workerId;
  #pollIntervalMs;
  #timer = null;
  #running = false;
  #activeOperation = null;

  constructor({
    queue,
    repository = null,
    plaidSyncService,
    recurringService,
    insightService,
    planningService = null,
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
          await recurringService.detectAndStore({
            workspaceId: payload.workspaceId,
          });
          await this.#queue.enqueue(
            "finance.generate_insights",
            { workspaceId: payload.workspaceId },
            { dedupeKey: payload.workspaceId },
          );
        },
      ],
      [
        "finance.generate_insights",
        (payload) =>
          insightService.generateAll({
            workspaceId: payload.workspaceId,
          }),
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
          await repository.takeDailySnapshots(
            payload.workspaceId,
            new Date().toISOString().slice(0, 10),
          );
          await recurringService.detectAndStore({
            workspaceId: payload.workspaceId,
          });
          await insightService.generateAll({
            workspaceId: payload.workspaceId,
          });
          await planningService?.processDueGoalSchedules?.();
        },
      ],
    ]);
  }

  async runOnce() {
    const job = await this.#queue.claim(this.#workerId, {
      jobTypes: [...this.#handlers.keys()],
    });
    if (!job) return false;
    try {
      await this.#handlers.get(job.type)(job.payload);
      await this.#queue.complete(job.id);
    } catch (error) {
      await this.#queue.fail(job.id, error);
    }
    return true;
  }

  async start() {
    if (this.#running) return;
    this.#running = true;
    await this.#queue.recoverStale();
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
    if (this.#activeOperation) {
      await this.#activeOperation.catch(() => {});
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
