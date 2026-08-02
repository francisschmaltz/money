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
  const planningRepository = new PgPlanningRepository(pool);
  const secretRepository = new PgPlaidSecretRepository(pool);
  const jobQueue = new PgJobQueue(pool);
  const provider = createPlaidProvider({
    clientId: config.plaid.clientId,
    secret: config.plaid.secret,
    environment: config.plaid.environment,
    webhookUrl: config.plaid.webhookUrl,
  });
  const financeService = createFinanceService({
    repository,
    jobQueue,
    narrativeService,
    baseUrl: config.mcp.cardBaseUrl,
  });
  const planningService = createPlanningService({
    repository: planningRepository,
    financeRepository: repository,
    baseUrl: config.mcp.cardBaseUrl,
  });
  const plaidSyncService = createPlaidSyncService({
    provider,
    repository,
    planningRepository,
    secretRepository,
    jobQueue,
  });
  const appleCardImportService = createAppleCardImportService({
    repository,
    jobQueue,
  });
  return {
    pool,
    repository,
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
    async close() {
      await pool.end();
    },
  };
}
