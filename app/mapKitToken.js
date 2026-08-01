import { createPrivateKey, sign } from "node:crypto";

const DEFAULT_TOKEN_LIFETIME_SECONDS = 3_600;
const DEFAULT_REFRESH_SKEW_SECONDS = 60;

export class MapKitTokenError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "MapKitTokenError";
  }
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new MapKitTokenError(`Missing required Apple credential: ${name}`);
  }
  return value.trim();
}

function normalizedOrigin(value) {
  const origin = requiredString(value, "PUBLIC_BASE_URL");
  let parsed;
  try {
    parsed = new URL(origin);
  } catch (cause) {
    throw new MapKitTokenError("PUBLIC_BASE_URL is not a valid origin", {
      cause,
    });
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    origin !== parsed.origin
  ) {
    throw new MapKitTokenError("PUBLIC_BASE_URL must be an exact HTTP(S) origin");
  }
  return origin;
}

function normalizedPrivateKey(value) {
  return requiredString(value, "APPLE_MAPS_PRIVATE_KEY").replaceAll(
    "\\n",
    "\n",
  );
}

function encodedJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function clockMilliseconds(now) {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(
      "The injected MapKit token clock must return a Date or epoch milliseconds.",
    );
  }
  return milliseconds;
}

function positiveSeconds(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function signToken({ teamId, keyId, privateKey, origin, issuedAt, expiresAt }) {
  const header = encodedJson({
    alg: "ES256",
    kid: keyId,
    typ: "JWT",
  });
  const claims = encodedJson({
    iss: teamId,
    iat: issuedAt,
    exp: expiresAt,
    scope: "mapkit_js",
    origin,
  });
  const signingInput = `${header}.${claims}`;
  let key;
  try {
    key = createPrivateKey(privateKey);
  } catch (cause) {
    throw new MapKitTokenError(
      "APPLE_MAPS_PRIVATE_KEY is not a valid PEM private key",
      { cause },
    );
  }
  if (
    key.asymmetricKeyType !== "ec" ||
    key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new MapKitTokenError(
      "APPLE_MAPS_PRIVATE_KEY must be an EC P-256 private key",
    );
  }
  try {
    const signature = sign("sha256", Buffer.from(signingInput), {
      key,
      dsaEncoding: "ieee-p1363",
    });
    return `${signingInput}.${signature.toString("base64url")}`;
  } catch (cause) {
    throw new MapKitTokenError("Unable to sign the MapKit JS token", {
      cause,
    });
  }
}

export function createMapKitTokenProvider(config = {}, options = {}) {
  const now = options.now ?? Date.now;
  const tokenLifetimeSeconds = positiveSeconds(
    options.tokenLifetimeSeconds ?? DEFAULT_TOKEN_LIFETIME_SECONDS,
    "MapKit token lifetime",
  );
  const refreshSkewSeconds = positiveSeconds(
    options.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS,
    "MapKit token refresh skew",
  );
  if (refreshSkewSeconds >= tokenLifetimeSeconds) {
    throw new TypeError(
      "MapKit token refresh skew must be shorter than its lifetime.",
    );
  }

  let cachedToken;

  function getToken() {
    const nowMs = clockMilliseconds(now);
    if (
      cachedToken &&
      nowMs < cachedToken.expiresAtMs - refreshSkewSeconds * 1_000
    ) {
      return cachedToken.response;
    }

    const teamId = requiredString(config.teamId, "APPLE_TEAM_ID");
    const keyId = requiredString(config.keyId, "APPLE_MAPS_KEY_ID");
    const privateKey = normalizedPrivateKey(config.privateKey);
    const origin = normalizedOrigin(config.origin);
    const issuedAt = Math.floor(nowMs / 1_000);
    const expiresAt = issuedAt + tokenLifetimeSeconds;
    const response = Object.freeze({
      token: signToken({
        teamId,
        keyId,
        privateKey,
        origin,
        issuedAt,
        expiresAt,
      }),
      expiresAt: new Date(expiresAt * 1_000).toISOString(),
    });
    cachedToken = {
      response,
      expiresAtMs: expiresAt * 1_000,
    };
    return response;
  }

  function clear() {
    cachedToken = undefined;
  }

  return { getToken, clear };
}
