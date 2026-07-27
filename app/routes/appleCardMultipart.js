import Busboy from "busboy";
import { APPLE_CARD_MAX_BYTES } from "../providers/appleCardCsv.js";

function multipartError(message, statusCode = 400) {
  const error = new Error(message);
  error.name = "AppleCardMultipartError";
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}

export function readAppleCardMultipart(request) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({
        headers: request.headers,
        limits: {
          fileSize: APPLE_CARD_MAX_BYTES,
          fieldSize: 2_048,
          files: 1,
          fields: 8,
          parts: 9,
        },
      });
    } catch {
      reject(multipartError("A multipart form upload is required."));
      return;
    }

    const fields = {};
    const chunks = [];
    let receivedFile = false;
    let failed = null;

    parser.on("field", (name, value, info) => {
      if (info.valueTruncated) {
        failed ??= multipartError("An import field is too large.");
        return;
      }
      if (
        [
          "balance",
          "credit_limit",
          "balance_as_of",
          "last_four",
          "preview_digest",
        ].includes(name)
      ) {
        fields[name] = value;
      }
    });

    parser.on("file", (name, stream, info) => {
      if (name !== "file" || receivedFile) {
        failed ??= multipartError("Upload exactly one Apple Card CSV.");
        stream.resume();
        return;
      }
      receivedFile = true;
      if (!String(info.filename ?? "").toLocaleLowerCase().endsWith(".csv")) {
        failed ??= multipartError("The uploaded file must end in .csv.");
      }
      stream.on("limit", () => {
        failed ??= multipartError("The CSV exceeds the 2 MiB limit.", 413);
      });
      stream.on("data", (chunk) => {
        if (!failed) chunks.push(chunk);
      });
      stream.on("error", reject);
    });

    parser.on("filesLimit", () => {
      failed ??= multipartError("Upload exactly one Apple Card CSV.");
    });
    parser.on("fieldsLimit", () => {
      failed ??= multipartError("The import contains too many fields.");
    });
    parser.on("partsLimit", () => {
      failed ??= multipartError("The import contains too many parts.");
    });
    parser.on("error", () => {
      reject(multipartError("The multipart upload is malformed."));
    });
    parser.on("close", () => {
      if (failed) {
        reject(failed);
        return;
      }
      if (!receivedFile) {
        reject(multipartError("Choose an Apple Card CSV to upload."));
        return;
      }
      resolve({ fileBuffer: Buffer.concat(chunks), fields });
    });

    request.pipe(parser);
  });
}
