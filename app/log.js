const forbiddenKeys =
  /token|secret|authorization|cookie|assertion|amount|balance|merchant|description|evidence|payload|prompt|messages|message_content|model_output|raw_response|request_body|response_body/i;
const oidcArtifactKeys =
  /^(?:code_verifier|code_challenge|nonce|state|oauth_state|oidc_state|session_state)$/i;
const sensitiveAssignmentKeys = [
  "access_token",
  "id_token",
  "refresh_token",
  "public_token",
  "client_secret",
  "client_assertion",
  "session_secret",
  "mcp_bearer_token",
  "authorization_code",
  "code_verifier",
  "code_challenge",
  "nonce",
  "state",
].join("|");
const sensitiveAssignment = new RegExp(
  `\\b(${sensitiveAssignmentKeys})\\b\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s,;&}]+)`,
  "gi",
);
const sensitiveJsonProperty = new RegExp(
  `(["']?)(?:${sensitiveAssignmentKeys})\\1\\s*:\\s*(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,}]+)`,
  "gi",
);

function redactString(value) {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\bAuthorization\s*[:=]\s*Basic\s+\S+/gi,
      "Authorization: Basic [redacted]",
    )
    .replace(/\baccess-(?:sandbox|development|production)-[\w-]+/gi, "[redacted]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
      "[redacted]",
    )
    .replace(
      /\b(postgres(?:ql)?):\/\/[^@\s/]+@/gi,
      "$1://[redacted]@",
    )
    .replace(/([?&]code=)[^&#\s]+/gi, "$1[redacted]")
    .replace(sensitiveAssignment, "$1=[redacted]")
    .replace(sensitiveJsonProperty, (property) => {
      const separator = property.indexOf(":");
      return `${property.slice(0, separator + 1)} "[redacted]"`;
    });
}

function sanitize(value, depth = 0) {
  if (depth > 3) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  if (typeof value === "string") return redactString(value);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      forbiddenKeys.test(key) || oidcArtifactKeys.test(key)
        ? "[redacted]"
        : sanitize(entry, depth + 1),
    ]),
  );
}

export function log(level, message, metadata = {}) {
  const line = {
    timestamp: new Date().toISOString(),
    level,
    message: redactString(String(message)),
    ...sanitize(metadata),
  };
  const output = JSON.stringify(line);
  if (level === "error") console.error(output);
  else console.log(output);
}
