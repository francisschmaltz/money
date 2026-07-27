import crypto from "node:crypto";

export function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function bearerAuth(expectedToken, realm = "money-mcp") {
  return (request, response, next) => {
    const match = /^Bearer\s+(.+)$/i.exec(request.get("authorization") || "");
    if (
      !expectedToken ||
      !match ||
      !timingSafeStringEqual(match[1], expectedToken)
    ) {
      response
        .status(401)
        .set("WWW-Authenticate", `Bearer realm="${realm}"`)
        .json({ error: "unauthorized", message: "A valid bearer token is required." });
      return;
    }
    next();
  };
}

export function allowedHost(allowedHosts) {
  const allowed = new Set(allowedHosts.map((host) => host.toLowerCase()));
  return (request, response, next) => {
    const hostname = String(request.get("host") || "").toLowerCase();
    const bareHostname = hostname.startsWith("[")
      ? hostname
      : hostname.split(":")[0];
    if (!allowed.has(hostname) && !allowed.has(bareHostname)) {
      response.status(421).json({
        error: "misdirected_request",
        message: "The request host is not allowed.",
      });
      return;
    }
    next();
  };
}

export function ensureCsrfToken(request, response, next) {
  if (!request.session) {
    response.locals.csrfToken = "";
    next();
    return;
  }
  if (!request.session.csrfToken) {
    request.session.csrfToken = crypto.randomBytes(32).toString("base64url");
  }
  response.locals.csrfToken = request.session.csrfToken;
  next();
}

export function requireCsrf(request, response, next) {
  const presented = request.get("x-csrf-token") || request.body?._csrf;
  if (
    !request.session?.csrfToken ||
    !presented ||
    !timingSafeStringEqual(request.session.csrfToken, presented)
  ) {
    response.status(403).json({
      error: "invalid_csrf_token",
      message: "Refresh the page and try again.",
    });
    return;
  }
  next();
}
