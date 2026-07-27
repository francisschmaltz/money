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
import { createPlanningService } from "./services/planningService.js";
import { createPlaidSyncService } from "./services/plaidSyncService.js";
import { createAppleCardImportService } from "./services/appleCardImportService.js";

export function createRuntime(config) {
  if (config.demoMode) {
    return {
      pool: null,
      financeService: createDemoFinanceService(),
      planningService: createDemoPlanningService(),
      plaidSyncService: null,
      appleCardImportService: null,
      jobQueue: null,
      async close() {},
    };
  }

  const pool = createPgPool({
    connectionString: config.database.url,
    ssl: config.database.ssl,
    applicationName: "money-web",
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
    secretRepository,
    jobQueue,
    financeService,
    planningService,
    plaidSyncService,
    appleCardImportService,
    async close() {
      await pool.end();
    },
  };
}
