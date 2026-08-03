import {
  createPgPool,
  PgFinanceRepository,
  PgJobQueue,
  PgPlanningRepository,
  PgPlaidSecretRepository,
} from "./db/index.js";
import { createPlaidProvider } from "./providers/index.js";
import { createDemoFinanceService } from "./services/demoFinanceService.js";
import { createDemoPlanningService } from "./services/demoPlanningService.js";
import { createFinanceService } from "./services/financeService.js";
import { LmStudioNarrativeService } from "./services/narrativeService.js";
import { createPlanningService } from "./services/planningService.js";
import { createPlaidSyncService } from "./services/plaidSyncService.js";
import { createAppleCardImportService } from "./services/appleCardImportService.js";
import {
  createAppearancePreferenceService,
  createDemoAppearancePreferenceService,
} from "./services/appearancePreferenceService.js";
import { createReadModelCache } from "./cache/readModelCache.js";
import { createReadModelRedisClient } from "./cache/redisClient.js";
import { createReadModelService } from "./cache/readModelService.js";
import {
  createCachedFinanceService,
  createCachedPlanningService,
  createPublishedAppleCardImportService,
  createPublishedPlaidSyncService,
  createReadModelPublisher,
  createReadModelRevisionSource,
} from "./cache/readModelRuntime.js";
import { log } from "./log.js";

export function createRuntime(config) {
  const narrativeService = new LmStudioNarrativeService({
    endpoint: config.lmStudio.baseUrl,
    model: config.lmStudio.model,
    apiKey: config.lmStudio.apiKey,
  });
  if (config.demoMode) {
    const financeService = createDemoFinanceService({
      scenario: config.demoScenario,
    });
    return {
      pool: null,
      narrativeService,
      appearancePreferenceService:
        createDemoAppearancePreferenceService(),
      financeService,
      planningService: createDemoPlanningService({
        scenario: config.demoScenario,
        financeService,
      }),
      plaidSyncService: null,
      appleCardImportService: null,
      jobQueue: null,
      async close() {},
    };
  }

  const pool = createPgPool({
    connectionString: config.database.url,
    ssl: config.database.ssl,
    sslRejectUnauthorized: config.database.sslRejectUnauthorized,
    applicationName: "money",
  });
  const repository = new PgFinanceRepository(pool);
  const secretRepository = new PgPlaidSecretRepository(pool);
  const jobQueue = new PgJobQueue(pool);
  const cacheMode = config.readModelCache?.mode ?? "off";
  const redis = createReadModelRedisClient({
    mode: cacheMode,
    url: config.readModelCache?.redisUrl ?? "",
    logger: log,
  });
  const readModelCache = createReadModelCache({
    client: redis.client,
    mode: cacheMode,
  });
  const readModelRevisionSource = createReadModelRevisionSource({ pool });
  const readModelPublisher = createReadModelPublisher({
    revisionSource: readModelRevisionSource,
    jobQueue,
    enabled: cacheMode !== "off",
    transactionRunner: (operation) => repository.transaction(operation),
  });
  const planningRepository = new PgPlanningRepository(pool, {
    publishReadModelRevision: ({
      client,
      workspaceId,
      revision,
      reason,
    }) =>
      readModelPublisher.queueWarm(reason, revision, {
        client,
        strict: true,
      }),
  });
  const provider = createPlaidProvider({
    clientId: config.plaid.clientId,
    secret: config.plaid.secret,
    environment: config.plaid.environment,
    webhookUrl: config.plaid.webhookUrl,
  });
  const rawFinanceService = createFinanceService({
    repository,
    jobQueue,
    narrativeService,
    baseUrl: config.mcp.cardBaseUrl,
  });
  const rawPlanningService = createPlanningService({
    repository: planningRepository,
    financeRepository: repository,
    baseUrl: config.mcp.cardBaseUrl,
  });
  const rawAppleCardImportService = createAppleCardImportService({
    repository,
    jobQueue,
  });
  const rawPlaidSyncService = createPlaidSyncService({
    provider,
    repository,
    planningRepository,
    secretRepository,
    jobQueue,
    markReadModelSourceUnstable: (
      client,
      _workspaceId,
      connectionId,
    ) =>
      readModelPublisher.markSourceUnstableInTransaction(
        client,
        connectionId,
      ),
    publishReadModelBoundary: (
      client,
      _workspaceId,
      connectionId,
      reason,
    ) =>
      readModelPublisher.bumpInTransaction(
        client,
        connectionId,
        reason,
      ),
  });
  const readModelService = createReadModelService({
    cache: readModelCache,
    pool,
    financeService: rawFinanceService,
    planningService: rawPlanningService,
    planningRepository,
    nodeEnvironment: config.nodeEnvironment,
    revisionSource: readModelRevisionSource,
  });
  const financeService = createCachedFinanceService({
    service: rawFinanceService,
    readModels: readModelService,
    publisher: readModelPublisher,
  });
  const planningService = createCachedPlanningService({
    service: rawPlanningService,
    readModels: readModelService,
    publisher: readModelPublisher,
  });
  const plaidSyncService = createPublishedPlaidSyncService({
    service: rawPlaidSyncService,
    publisher: readModelPublisher,
  });
  const appleCardImportService = createPublishedAppleCardImportService({
    service: rawAppleCardImportService,
    publisher: readModelPublisher,
  });
  return {
    pool,
    repository,
    planningRepository,
    appearancePreferenceService: createAppearancePreferenceService({
      repository,
    }),
    secretRepository,
    jobQueue,
    narrativeService,
    financeService,
    planningService,
    plaidSyncService,
    appleCardImportService,
    readModelCache,
    readModelRedis: redis,
    readModelService,
    readModelPublisher,
    readModelRevisionSource,
    async close() {
      await redis.close();
      await pool.end();
    },
  };
}
