import { Router } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { Authenticator } from "passport";
import * as oidc from "openid-client";
import { Strategy as OidcStrategy } from "openid-client/passport";

const OIDC_STRATEGY = "duo-oidc";
const OIDC_SESSION_KEY = "duo.oidc";
const AUTHENTICATED_SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1_000;

function normalizedEmail(value) {
  if (typeof value !== "string" || !value.includes("@")) return null;
  return value.trim().toLowerCase();
}

export function safeLocalReturnTo(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  try {
    const origin = new URL("https://money.invalid");
    const parsed = new URL(value, origin);
    if (parsed.origin !== origin.origin) return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

export function identityForEmail(email, config, profile = {}) {
  const normalized = normalizedEmail(email);
  if (!normalized || !config.auth.allowedEmails.has(normalized)) return null;
  return {
    email: normalized,
    name:
      profile.name ||
      profile.displayName ||
      profile.given_name ||
      profile.firstName ||
      normalized.split("@")[0],
    isAdmin: config.auth.adminEmails.has(normalized),
  };
}

export function identityForOidcClaims(claims, config) {
  if (
    !claims ||
    typeof claims.sub !== "string" ||
    claims.sub.length === 0 ||
    claims.email_verified === false
  ) {
    return null;
  }
  const identity = identityForEmail(claims.email, config, claims);
  return identity ? { ...identity, subject: claims.sub } : null;
}

export function identityForStoredSession(
  stored,
  config,
  now = Date.now(),
) {
  const authenticatedAt = stored?.authenticatedAt;
  const age = now - authenticatedAt;
  if (
    typeof authenticatedAt !== "number" ||
    !Number.isFinite(age) ||
    age < 0 ||
    age >= AUTHENTICATED_SESSION_MAX_AGE_MS ||
    typeof stored.subject !== "string" ||
    stored.subject.length === 0
  ) {
    return null;
  }
  const identity = identityForEmail(stored.email, config, {
    name: stored.name,
  });
  if (!identity) return null;
  return {
    ...identity,
    subject: stored.subject,
    ...(stored.id ? { id: stored.id } : {}),
  };
}

function isMfaOnlyDuoEndpoint(value) {
  if (!value) return false;
  const url = new URL(value);
  return (
    url.pathname.startsWith("/oauth/v1/") ||
    (url.hostname.startsWith("api-") &&
      url.hostname.endsWith(".duosecurity.com"))
  );
}

function validatedEndpoint(value, name, issuer) {
  if (typeof value !== "string" || !value) {
    throw new Error(`Duo OIDC discovery did not provide ${name}.`);
  }
  const endpoint = new URL(value);
  if (endpoint.protocol !== "https:") {
    throw new Error(`Duo OIDC ${name} must use HTTPS.`);
  }
  if (endpoint.origin !== issuer.origin) {
    throw new Error(`Duo OIDC ${name} must use the issuer origin.`);
  }
  if (isMfaOnlyDuoEndpoint(endpoint.href)) {
    throw new Error(
      "Duo oauth/v1 endpoints are MFA-only; configure a Generic OIDC Relying Party issuer.",
    );
  }
  return endpoint.href;
}

export function validateOidcConfiguration(config, configuration) {
  if (!(configuration instanceof oidc.Configuration)) {
    throw new TypeError("A discovered OIDC Configuration is required.");
  }
  const expectedIssuer = new URL(config.auth.duo.issuer);
  const metadata = configuration.serverMetadata();
  if (metadata.issuer !== expectedIssuer.href.replace(/\/$/, "")) {
    throw new Error("Duo OIDC discovery returned an unexpected issuer.");
  }

  const authorizationUrl = validatedEndpoint(
    metadata.authorization_endpoint,
    "authorization endpoint",
    expectedIssuer,
  );
  const tokenUrl = validatedEndpoint(
    metadata.token_endpoint,
    "token endpoint",
    expectedIssuer,
  );
  validatedEndpoint(metadata.jwks_uri, "JWKS endpoint", expectedIssuer);

  if (
    config.auth.duo.authorizationUrl &&
    config.auth.duo.authorizationUrl !== authorizationUrl
  ) {
    throw new Error(
      "DUO_AUTHORIZATION_URL does not match Duo OIDC discovery.",
    );
  }
  if (
    config.auth.duo.tokenUrl &&
    config.auth.duo.tokenUrl !== tokenUrl
  ) {
    throw new Error("DUO_TOKEN_URL does not match Duo OIDC discovery.");
  }
  if (!metadata.response_types_supported?.includes("code")) {
    throw new Error("Duo OIDC must support the authorization code flow.");
  }
  if (!metadata.id_token_signing_alg_values_supported?.includes("RS256")) {
    throw new Error("Duo OIDC must support RS256 ID tokens.");
  }
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw new Error("Duo OIDC must support PKCE S256.");
  }
  if (
    !metadata.token_endpoint_auth_methods_supported?.includes(
      "client_secret_basic",
    )
  ) {
    throw new Error(
      "Duo OIDC must support client_secret_basic token authentication.",
    );
  }
  const missingScopes = config.auth.duo.scope
    .split(/\s+/)
    .filter((scope) => !metadata.scopes_supported?.includes(scope));
  if (missingScopes.length) {
    throw new Error(
      `Duo OIDC is missing required scopes: ${missingScopes.join(", ")}.`,
    );
  }
  return configuration;
}

export async function createOidcConfiguration(
  config,
  { discover = oidc.discovery } = {},
) {
  if (config.auth.mode !== "oidc") return null;
  const duo = config.auth.duo;
  const missing = [
    ["DUO_OIDC_ISSUER", duo.issuer],
    ["DUO_CLIENT_ID", duo.clientId],
    ["DUO_CLIENT_SECRET", duo.clientSecret],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(
      `Missing required OIDC configuration: ${missing.join(", ")}.`,
    );
  }
  if (
    [duo.issuer, duo.authorizationUrl, duo.tokenUrl]
      .filter(Boolean)
      .some(isMfaOnlyDuoEndpoint)
  ) {
    throw new Error(
      "Duo oauth/v1 endpoints are MFA-only; use the Generic OIDC Relying Party issuer.",
    );
  }
  const configuration = await discover(
    new URL(duo.issuer),
    duo.clientId,
    {
      client_secret: duo.clientSecret,
      token_endpoint_auth_method: "client_secret_basic",
      id_token_signed_response_alg: "RS256",
    },
    oidc.ClientSecretBasic(duo.clientSecret),
    { timeout: 10 },
  );
  return validateOidcConfiguration(config, configuration);
}

class DuoOidcStrategy extends OidcStrategy {
  authorizationRequestParams(request, options) {
    const parameters = new URLSearchParams(
      super.authorizationRequestParams(request, options),
    );
    parameters.set("state", oidc.randomState());
    parameters.set("nonce", oidc.randomNonce());
    return parameters;
  }
}

export function createSessionMiddleware({ config, pool }) {
  if (
    config.production &&
    Buffer.byteLength(config.auth.sessionSecret.trim(), "utf8") < 32
  ) {
    throw new Error(
      "SESSION_SECRET must contain at least 32 bytes in production.",
    );
  }
  const options = {
    name: "money.sid",
    secret: config.auth.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: config.production,
      maxAge: AUTHENTICATED_SESSION_MAX_AGE_MS,
    },
  };

  if (pool) {
    const PgStore = connectPgSimple(session);
    options.store = new PgStore({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: false,
      pruneSessionInterval: 15 * 60,
    });
  }

  return session(options);
}

export function createAuth({
  config,
  oidcConfiguration = null,
  csrfMiddleware = (_request, _response, next) => next(),
  onAuthenticated = null,
}) {
  const passport = new Authenticator();
  const router = Router();

  passport.serializeUser((user, done) => {
    done(null, {
      ...(user.id ? { id: user.id } : {}),
      email: user.email,
      name: user.name,
      subject: user.subject,
      authenticatedAt: Date.now(),
    });
  });
  passport.deserializeUser((stored, done) => {
    done(null, identityForStoredSession(stored, config));
  });

  if (config.auth.mode === "oidc") {
    if (!oidcConfiguration) {
      throw new TypeError("oidcConfiguration is required in OIDC mode.");
    }
    passport.use(
      OIDC_STRATEGY,
      new DuoOidcStrategy(
        {
          config: oidcConfiguration,
          name: OIDC_STRATEGY,
          sessionKey: OIDC_SESSION_KEY,
          callbackURL: config.auth.duo.redirectUri,
          scope: config.auth.duo.scope,
        },
        async (tokens, done) => {
          const identity = identityForOidcClaims(tokens.claims(), config);
          if (!identity) {
            done(null, false, {
              message: "This Duo identity is not allowlisted.",
            });
            return;
          }
          try {
            const persisted = onAuthenticated
              ? await onAuthenticated(identity)
              : null;
            done(null, {
              ...identity,
              ...(persisted?.id ? { id: persisted.id } : {}),
            });
          } catch (error) {
            done(error);
          }
        },
      ),
    );
  }

  router.use(passport.initialize());
  router.use(passport.session());

  if (config.auth.mode === "mock") {
    router.use((request, _response, next) => {
      if (!request.user) {
        const preferred =
          [...config.auth.adminEmails][0] ||
          [...config.auth.allowedEmails][0] ||
          "demo@example.com";
        request.user = {
          id: "demo-user",
          email: preferred,
          name: "Demo User",
          isAdmin: true,
        };
      }
      next();
    });
  }

  router.get("/auth/login", (request, response, next) => {
    const returnTo = safeLocalReturnTo(request.query.return_to);
    request.session.returnTo = returnTo;
    if (config.auth.mode === "mock") {
      response.redirect(returnTo);
      return;
    }
    passport.authenticate(OIDC_STRATEGY)(request, response, next);
  });

  if (config.auth.mode === "oidc") {
    router.get(
      "/auth/duo/callback",
      passport.authenticate(OIDC_STRATEGY, {
        failureRedirect: "/login?error=not-allowed",
        session: false,
      }),
      (request, response) => {
        const returnTo = request.session.returnTo || "/";
        const authenticatedUser = request.user;
        delete request.session.returnTo;
        request.login(authenticatedUser, (loginError) => {
          response.redirect(
            loginError ? "/login?error=session" : returnTo,
          );
        });
      },
    );
  }

  router.post(
    "/auth/logout",
    csrfMiddleware,
    (request, response, next) => {
      request.logout((error) => {
        if (error) {
          next(error);
          return;
        }
        request.session.destroy(() => response.redirect("/login"));
      });
    },
  );

  return { router, passport };
}

export function requireUser(request, response, next) {
  if (request.user) {
    next();
    return;
  }
  if (request.accepts("html")) {
    response.redirect(
      `/auth/login?return_to=${encodeURIComponent(request.originalUrl)}`,
    );
    return;
  }
  response.status(401).json({ error: "unauthorized" });
}

export function requireAdmin(request, response, next) {
  if (request.user?.isAdmin) {
    next();
    return;
  }
  response.status(403).json({
    error: "forbidden",
    message: "Administrator access is required.",
  });
}
