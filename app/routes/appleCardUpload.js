import express from "express";

import { APPLE_CARD_MAX_BYTES } from "../providers/appleCardCsv.js";

// No +json suffix: the app-wide 64 KiB JSON parser must leave this bounded
// route-specific body untouched.
export const APPLE_CARD_UPLOAD_MEDIA_TYPE =
  "application/vnd.money.apple-card-import";

const APPLE_CARD_MAX_BASE64_BYTES =
  Math.ceil(APPLE_CARD_MAX_BYTES / 3) * 4;
const APPLE_CARD_UPLOAD_BODY_LIMIT =
  APPLE_CARD_MAX_BASE64_BYTES + 16 * 1024;
const APPLE_CARD_FIELDS = Object.freeze({
  balance: "balance",
  credit_limit: "creditLimit",
  balance_as_of: "balanceAsOf",
  last_four: "lastFour",
  preview_digest: "previewDigest",
});
const APPLE_CARD_BODY_KEYS = new Set([
  "file_base64",
  ...Object.keys(APPLE_CARD_FIELDS),
]);

export const parseAppleCardUploadBody = express.json({
  limit: APPLE_CARD_UPLOAD_BODY_LIMIT,
  strict: true,
  type: APPLE_CARD_UPLOAD_MEDIA_TYPE,
});

function uploadError(message, statusCode = 400) {
  const error = new Error(message);
  error.name = "AppleCardUploadError";
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}

function decodeFile(value) {
  if (
    typeof value === "string" &&
    value.length > APPLE_CARD_MAX_BASE64_BYTES
  ) {
    throw uploadError("The CSV exceeds the 2 MiB limit.", 413);
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw uploadError("Choose a valid Apple Card CSV to upload.");
  }
  const fileBuffer = Buffer.from(value, "base64");
  if (fileBuffer.toString("base64") !== value) {
    throw uploadError("Choose a valid Apple Card CSV to upload.");
  }
  if (fileBuffer.length > APPLE_CARD_MAX_BYTES) {
    throw uploadError("The CSV exceeds the 2 MiB limit.", 413);
  }
  return fileBuffer;
}

export function readAppleCardUpload(request) {
  if (
    !request.is(APPLE_CARD_UPLOAD_MEDIA_TYPE) ||
    !request.body ||
    Array.isArray(request.body) ||
    typeof request.body !== "object"
  ) {
    throw uploadError("A structured Apple Card CSV upload is required.");
  }
  const unexpected = Object.keys(request.body).filter(
    (key) => !APPLE_CARD_BODY_KEYS.has(key),
  );
  if (unexpected.length > 0) {
    throw uploadError("The Apple Card upload contains unknown fields.");
  }

  const upload = {
    fileBuffer: decodeFile(request.body.file_base64),
  };
  for (const [bodyKey, serviceKey] of Object.entries(APPLE_CARD_FIELDS)) {
    const value = request.body[bodyKey];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > 2_048) {
      throw uploadError("An Apple Card import field is invalid.");
    }
    upload[serviceKey] = value;
  }
  return upload;
}
