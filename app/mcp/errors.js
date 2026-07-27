export const FINANCE_MCP_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: "invalid_request",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  UNAVAILABLE: "unavailable",
  RESULT_TOO_LARGE: "result_too_large",
  INTERNAL_ERROR: "internal_error",
});

const KNOWN_CODES = new Set(Object.values(FINANCE_MCP_ERROR_CODES));

const DEFAULT_MESSAGES = Object.freeze({
  [FINANCE_MCP_ERROR_CODES.INVALID_REQUEST]:
    "The finance tool request is invalid.",
  [FINANCE_MCP_ERROR_CODES.NOT_FOUND]:
    "The requested finance data was not found.",
  [FINANCE_MCP_ERROR_CODES.CONFLICT]:
    "The finance data changed before the request could complete.",
  [FINANCE_MCP_ERROR_CODES.UNAVAILABLE]:
    "Finance data is temporarily unavailable.",
  [FINANCE_MCP_ERROR_CODES.RESULT_TOO_LARGE]:
    "The finance result is too large. Narrow the request and try again.",
  [FINANCE_MCP_ERROR_CODES.INTERNAL_ERROR]:
    "The finance tool could not complete the request.",
});

const RETRYABLE_CODES = new Set([
  FINANCE_MCP_ERROR_CODES.CONFLICT,
  FINANCE_MCP_ERROR_CODES.UNAVAILABLE,
]);

export class FinanceMcpError extends Error {
  constructor(code, message, options = {}) {
    const normalizedCode = KNOWN_CODES.has(code)
      ? code
      : FINANCE_MCP_ERROR_CODES.INTERNAL_ERROR;
    super(message || DEFAULT_MESSAGES[normalizedCode], { cause: options.cause });
    this.name = "FinanceMcpError";
    this.code = normalizedCode;
    this.retryable =
      options.retryable ?? RETRYABLE_CODES.has(normalizedCode);
    this.details = sanitizeErrorDetails(options.details);
  }
}

function cleanDetailString(value, maxLength) {
  if (typeof value !== "string") {
    return undefined;
  }
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean ? clean.slice(0, maxLength) : undefined;
}

function sanitizeErrorDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }

  const field = cleanDetailString(details.field, 80);
  const reason = cleanDetailString(details.reason, 240);
  const retryAfterSeconds = Number.isSafeInteger(details.retry_after_seconds)
    ? Math.max(0, Math.min(details.retry_after_seconds, 86_400))
    : undefined;

  if (!field && !reason && retryAfterSeconds === undefined) {
    return undefined;
  }

  return {
    ...(field ? { field } : {}),
    ...(reason ? { reason } : {}),
    ...(retryAfterSeconds !== undefined
      ? { retry_after_seconds: retryAfterSeconds }
      : {}),
  };
}

export function normalizeFinanceMcpError(error) {
  if (error instanceof FinanceMcpError) {
    return error;
  }

  if (error?.name === "ZodError") {
    const firstIssue = error.issues?.[0];
    return new FinanceMcpError(
      FINANCE_MCP_ERROR_CODES.INVALID_REQUEST,
      undefined,
      {
        details: {
          field: firstIssue?.path?.join("."),
          reason: firstIssue?.message,
        },
        cause: error,
      },
    );
  }

  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return new FinanceMcpError(FINANCE_MCP_ERROR_CODES.UNAVAILABLE);
  }

  if (KNOWN_CODES.has(error?.code)) {
    return new FinanceMcpError(error.code, undefined, {
      cause: error,
    });
  }

  return new FinanceMcpError(FINANCE_MCP_ERROR_CODES.INTERNAL_ERROR, undefined, {
    cause: error,
  });
}

export function financeErrorData(error) {
  const normalized = normalizeFinanceMcpError(error);
  return {
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      ...(normalized.details ? { details: normalized.details } : {}),
    },
  };
}
