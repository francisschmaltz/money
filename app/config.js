import { z } from "zod";

function csv(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function boolean(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function integer(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalUrl(value, name, { stripTrailingSlash = false } = {}) {
  const candidate = String(value || "").trim();
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new TypeError();
    }
    const normalized = parsed.href;
    return stripTrailingSlash
      ? normalized.replace(/\/$/, "")
      : normalized;
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL.`);
  }
}

const nodeEnvironmentSchema = z.enum(["development", "test", "production"]);
const authModeSchema = z.enum(["mock", "oidc"]);
const plaidEnvironmentSchema = z.enum(["sandbox", "development", "production"]);
const demoScenarioSchema = z.enum(["default", "ux-stress"]);

export function loadConfig(environment = process.env, argv = process.argv.slice(2)) {
  const argument = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const nodeEnvironment = nodeEnvironmentSchema.parse(
    environment.NODE_ENV || "development",
  );
  const production = nodeEnvironment === "production";
  const host = argument("--host") || environment.HOST || "0.0.0.0";
  const port = integer(argument("--port") || environment.PORT, 3000);
  const configuredPublicBaseUrl = String(
    environment.PUBLIC_BASE_URL || "",
  ).trim();
  const publicBaseUrl =
    configuredPublicBaseUrl ||
    `${production ? "https" : "http"}://${host}:${port}`;
  const authMode = authModeSchema.parse(
    environment.AUTH_MODE || (production ? "oidc" : "mock"),
  );
  const databaseUrl = String(environment.DATABASE_URL || "").trim();
  const demoMode = boolean(
    environment.DEMO_MODE,
    production ? false : !databaseUrl,
  );
  const demoScenario = demoScenarioSchema.parse(
    environment.DEMO_SCENARIO || "default",
  );

  if (production && authMode === "mock") {
    throw new Error("AUTH_MODE=mock is forbidden in production.");
  }
  if (production && demoMode) {
    throw new Error("DEMO_MODE=true is forbidden in production.");
  }
  if (production && !databaseUrl) {
    throw new Error("DATABASE_URL is required in production.");
  }
  if (production && !configuredPublicBaseUrl) {
    throw new Error("PUBLIC_BASE_URL is required in production.");
  }

  const publicUrl = new URL(publicBaseUrl);
  if (
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash
  ) {
    throw new Error("PUBLIC_BASE_URL must be an origin without a path.");
  }
  if (production && publicUrl.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use HTTPS in production.");
  }

  const adminEmails = new Set(csv(environment.DUO_ADMIN_EMAILS));
  const publicOrigin = publicUrl.origin;
  const expectedDuoRedirectUri = `${publicOrigin}/auth/duo/callback`;
  const plaidRedirectUri = `${publicOrigin}/plaid/oauth`;
  const duoRedirectUri = optionalUrl(
    environment.DUO_REDIRECT_URI ||
      expectedDuoRedirectUri,
    "DUO_REDIRECT_URI",
  );
  if (duoRedirectUri !== expectedDuoRedirectUri) {
    throw new Error(
      "DUO_REDIRECT_URI must exactly match PUBLIC_BASE_URL/auth/duo/callback.",
    );
  }
  const sessionSecret = String(
    environment.SESSION_SECRET ||
      (production ? "" : "development-only-secret"),
  ).trim();

  const config = {
    nodeEnvironment,
    production,
    host,
    port,
    publicBaseUrl: publicOrigin,
    trustProxy: boolean(environment.TRUST_PROXY),
    demoMode,
    demoScenario,
    database: {
      url: databaseUrl,
      ssl: boolean(environment.DATABASE_SSL),
      sslRejectUnauthorized: boolean(
        environment.DATABASE_SSL_REJECT_UNAUTHORIZED,
        true,
      ),
    },
    auth: {
      mode: authMode,
      adminEmails,
      sessionSecret,
      duo: {
        issuer: optionalUrl(
          environment.DUO_OIDC_ISSUER,
          "DUO_OIDC_ISSUER",
          { stripTrailingSlash: true },
        ),
        clientId: String(environment.DUO_CLIENT_ID || "").trim(),
        clientSecret: String(environment.DUO_CLIENT_SECRET || ""),
        authorizationUrl: optionalUrl(
          environment.DUO_AUTHORIZATION_URL,
          "DUO_AUTHORIZATION_URL",
        ),
        tokenUrl: optionalUrl(
          environment.DUO_TOKEN_URL,
          "DUO_TOKEN_URL",
        ),
        redirectUri: duoRedirectUri,
        scope: "openid email profile",
      },
    },
    plaid: {
      environment: plaidEnvironmentSchema.parse(
        environment.PLAID_ENV || "sandbox",
      ),
      clientId: environment.PLAID_CLIENT_ID || "",
      secret: environment.PLAID_SECRET || "",
      webhookUrl:
        environment.PLAID_WEBHOOK_URL ||
        `${new URL(publicBaseUrl).origin}/webhooks/plaid`,
      redirectUri: plaidRedirectUri,
    },
    mcp: {
      bearerToken: environment.MCP_BEARER_TOKEN || "",
      planWriteToken: environment.MCP_PLAN_WRITE_TOKEN || "",
      allowedHosts: csv(environment.MCP_ALLOWED_HOSTS).length
        ? csv(environment.MCP_ALLOWED_HOSTS)
        : [new URL(publicBaseUrl).host.toLowerCase()],
      cardBaseUrl:
        environment.MCP_CARD_BASE_URL || "https://money.example.com",
    },
    lmStudio: {
      baseUrl: environment.LM_STUDIO_BASE_URL || "",
      model: environment.LM_STUDIO_MODEL || "",
      apiKey: environment.LM_STUDIO_API_KEY || "",
    },
    worker: {
      pollIntervalMs: integer(environment.WORKER_POLL_INTERVAL_MS, 5_000),
      nightlyInsightsHourUtc: integer(
        environment.NIGHTLY_INSIGHTS_HOUR_UTC,
        9,
      ),
    },
  };

  return config;
}

export function readiness(config) {
  const failures = [];
  const serviceMode = config.production || !config.demoMode;

  if (serviceMode && !config.database.url) failures.push("DATABASE_URL");
  if (
    config.production &&
    Buffer.byteLength(config.auth.sessionSecret.trim(), "utf8") < 32
  ) {
    failures.push("SESSION_SECRET");
  }
  if (config.auth.mode === "oidc") {
    if (!config.auth.duo.issuer) failures.push("DUO_OIDC_ISSUER");
    if (!config.auth.duo.clientId) failures.push("DUO_CLIENT_ID");
    if (!config.auth.duo.clientSecret) failures.push("DUO_CLIENT_SECRET");
    if (!config.auth.duo.redirectUri) failures.push("DUO_REDIRECT_URI");
  }
  if (serviceMode) {
    if (!config.plaid.clientId) failures.push("PLAID_CLIENT_ID");
    if (!config.plaid.secret) failures.push("PLAID_SECRET");
    if (!config.mcp.bearerToken) failures.push("MCP_BEARER_TOKEN");
    if (!config.mcp.planWriteToken) {
      failures.push("MCP_PLAN_WRITE_TOKEN");
    }
    if (
      config.mcp.bearerToken &&
      config.mcp.planWriteToken &&
      config.mcp.bearerToken === config.mcp.planWriteToken
    ) {
      failures.push("MCP_PLAN_WRITE_TOKEN_DISTINCT");
    }
  }

  return { ready: failures.length === 0, failures };
}
