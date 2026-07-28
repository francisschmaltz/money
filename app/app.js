import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createAuth, createSessionMiddleware, requireAdmin, requireUser } from "./auth.js";
import { readiness } from "./config.js";
import { checkDatabase } from "./db/pool.js";
import { log } from "./log.js";
import { createFinanceMcpServer } from "./mcp/index.js";
import { createApiRouter, createPlaidWebhookRouter } from "./routes/api.js";
import { createWebRouter } from "./routes/web.js";
import {
  allowedHost,
  ensureCsrfToken,
  requireCsrf,
  scopedBearerAuth,
} from "./security.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const applicationRoot = fileURLToPath(new URL("./", import.meta.url));

function requestId() {
  return randomUUID();
}

function mcpMethodNotAllowed(_request, response) {
  response
    .status(405)
    .set("Allow", "POST")
    .json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed for this stateless MCP endpoint.",
      },
      id: null,
    });
}

export function stableAssetCacheOptions(config) {
  return {
    immutable: false,
    maxAge: config.production ? "1h" : 0,
  };
}

function viewer(user) {
  if (!user) return null;
  const name = user.name || user.displayName || user.email || "Finance user";
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return {
    id: user.id,
    name,
    email: user.email,
    initials: initials || "MF",
    is_admin: Boolean(user.isAdmin),
  };
}

function safeErrorMetadata(error, request) {
  return {
    requestId: request.id,
    path: request.path,
    method: request.method,
    error: {
      name: error?.name || "Error",
      code: error?.code,
      status: error?.status,
      message:
        error?.expose === true
          ? error.message
          : "Internal request failure",
    },
  };
}

export function createApp({
  config,
  pool = null,
  repository = null,
  financeService,
  planningService = null,
  plaidSyncService,
  appleCardImportService,
  oidcConfiguration = null,
} = {}) {
  if (!config) throw new TypeError("config is required.");

  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);
  app.set("views", path.join(applicationRoot, "views"));
  app.set("view engine", "ejs");

  app.use((request, response, next) => {
    request.id = request.get("x-request-id")?.slice(0, 128) || requestId();
    response.set("X-Request-ID", request.id);
    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          connectSrc: ["'self'", "https://*.plaid.com"],
          fontSrc: ["'self'", "data:"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          frameSrc: ["'self'", "https://*.plaid.com"],
          imgSrc: ["'self'", "data:", "https:"],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'", "https://cdn.plaid.com"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          upgradeInsecureRequests: config.production ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      hsts: config.production
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,
      referrerPolicy: { policy: "same-origin" },
    }),
  );

  app.use((request, response, next) => {
    if (
      request.path.startsWith("/api/") ||
      request.path === "/mcp" ||
      request.path.startsWith("/auth/")
    ) {
      response.set("Cache-Control", "no-store");
    }
    next();
  });

  const capturePlaidBody = (request, _response, buffer) => {
    if (request.originalUrl === "/webhooks/plaid") {
      request.rawBody = Buffer.from(buffer);
    }
  };
  app.use(
    express.json({
      limit: "64kb",
      type: ["application/json", "application/*+json"],
      verify: capturePlaidBody,
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));

  app.use(
    "/css",
    express.static(
      path.join(applicationRoot, "public/css"),
      stableAssetCacheOptions(config),
    ),
  );
  app.use(
    "/js",
    express.static(
      path.join(applicationRoot, "public/js"),
      stableAssetCacheOptions(config),
    ),
  );
  app.use(
    "/vendor/phosphor",
    express.static(
      path.join(projectRoot, "node_modules/@phosphor-icons/web/src"),
      stableAssetCacheOptions(config),
    ),
  );
  app.use(
    "/vendor/chart",
    express.static(
      path.join(projectRoot, "node_modules/chart.js/dist"),
      stableAssetCacheOptions(config),
    ),
  );

  app.get("/health/live", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/health/ready", async (_request, response) => {
    const state = readiness(config);
    let databaseReady = config.demoMode;
    if (!config.demoMode && pool) {
      try {
        databaseReady = await checkDatabase(pool);
      } catch {
        databaseReady = false;
      }
    }
    const ready = state.ready && databaseReady;
    response.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      database: databaseReady ? "ready" : "unavailable",
      ...(state.failures.length ? { missing: state.failures } : {}),
    });
  });

  const mcpHost = allowedHost(config.mcp.allowedHosts);
  const mcpBearer = scopedBearerAuth({
    readToken: config.mcp.bearerToken,
    planWriteToken: config.mcp.planWriteToken,
  });
  const mcpRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });

  app.post(
    "/mcp",
    mcpHost,
    mcpBearer,
    mcpRateLimit,
    async (request, response) => {
      if (!financeService) {
        response.status(503).json({
          jsonrpc: "2.0",
          error: { code: -32003, message: "Finance data is unavailable." },
          id: request.body?.id ?? null,
        });
        return;
      }

      const server = createFinanceMcpServer({
        financeService,
        planningService,
        accessScope: request.mcpScope,
        baseUrl: config.mcp.cardBaseUrl,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(request, response, request.body);
      } catch (error) {
        log("error", "MCP request failed", safeErrorMetadata(error, request));
        if (!response.headersSent) {
          response.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "The finance tool request failed.",
            },
            id: request.body?.id ?? null,
          });
        }
      } finally {
        await Promise.allSettled([transport.close(), server.close()]);
      }
    },
  );
  app.get("/mcp", mcpHost, mcpBearer, mcpMethodNotAllowed);
  app.delete("/mcp", mcpHost, mcpBearer, mcpMethodNotAllowed);

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      skip: (request) => request.path.startsWith("/health/"),
    }),
  );

  app.use(createPlaidWebhookRouter({ plaidSyncService }));

  app.use(createSessionMiddleware({ config, pool }));
  app.use(ensureCsrfToken);
  const auth = createAuth({
    config,
    oidcConfiguration,
    csrfMiddleware: requireCsrf,
    onAuthenticated: repository
      ? (identity) =>
          repository.upsertUser({
            email: identity.email,
            displayName: identity.name,
            isAdmin: identity.isAdmin,
          })
      : null,
  });
  app.use(auth.router);
  app.use((request, response, next) => {
    response.locals.viewer = viewer(request.user);
    next();
  });

  app.use(
    createApiRouter({
      requireAuth: requireUser,
      requireAdmin,
      requireCsrf,
      financeService,
      planningService,
      plaidSyncService,
      plaidRedirectUri: config.plaid.redirectUri,
      appleCardImportService,
    }),
  );
  app.use(
    createWebRouter({
      requireAuth: requireUser,
      requireAdmin,
      financeService,
      planningService,
      demoMode: config.demoMode,
    }),
  );

  app.use((request, response) => {
    if (request.accepts("html")) {
      response.status(404).render("states/error", {
        pageTitle: "Page not found",
        currentPath: request.path,
        activePath: request.path,
        viewer: viewer(request.user),
        requestId: request.id,
        statusCode: 404,
        message: "That page does not exist.",
      });
      return;
    }
    response.status(404).json({
      error: "not_found",
      request_id: request.id,
    });
  });

  app.use((error, request, response, _next) => {
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({
        error: "invalid_json",
        message: "The request body is not valid JSON.",
        request_id: request.id,
      });
      return;
    }
    if (error?.type === "entity.too.large") {
      response.status(413).json({
        error: "request_too_large",
        message: "The request body is too large.",
        request_id: request.id,
      });
      return;
    }

    log("error", "HTTP request failed", safeErrorMetadata(error, request));
    const candidateStatus = error?.status ?? error?.statusCode;
    const status =
      Number.isInteger(candidateStatus) &&
      candidateStatus >= 400 &&
      candidateStatus < 600
        ? candidateStatus
        : 500;
    const publicMessage =
      error?.expose === true
        ? error.message
        : "The request could not be completed.";

    if (request.accepts("html")) {
      response.status(status).render("states/error", {
        pageTitle: status === 403 ? "Access denied" : "Something needs attention",
        currentPath: request.path,
        activePath: request.path,
        viewer: viewer(request.user),
        requestId: request.id,
        statusCode: status,
        message: publicMessage,
      });
      return;
    }
    response.status(status).json({
      error: status < 500 ? "request_failed" : "internal_error",
      message: publicMessage,
      request_id: request.id,
    });
  });

  return app;
}
