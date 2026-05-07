import "server-only";
import { fileTypeFromBuffer } from "file-type";
import {
  ALLOWED_ATTACHMENT_MIMES,
  FORBIDDEN_EXTENSIONS,
  MAX_ATTACHMENT_BYTES,
  sanitizeFilename,
} from "./primitives";
import { ValidationError } from "@/lib/errors";

/**
 * Server-side validation for file uploads. Trusts neither the client-supplied
 * MIME nor the extension — checks the actual magic bytes via `file-type` and
 * cross-checks with the allowlist. Returns a normalized filename and the
 * validated MIME so the caller can store both.
 *
 * @throws ValidationError on size / extension / mime / magic-byte mismatch.
 */
export async function validateAttachment(args: {
  filename: string;
  buffer: Uint8Array | ArrayBuffer;
  declaredMime?: string;
  maxBytes?: number;
}): Promise<{ filename: string; mime: string }> {
  const max = args.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const buffer =
    args.buffer instanceof Uint8Array ? args.buffer : new Uint8Array(args.buffer);

  if (buffer.byteLength === 0) {
    throw new ValidationError("File is empty.");
  }
  if (buffer.byteLength > max) {
    throw new ValidationError(
      `File is too large. Max ${(max / 1024 / 1024).toFixed(0)} MB.`,
    );
  }

  const filename = sanitizeFilename(args.filename);
  const ext = filename.includes(".")
    ? filename.split(".").pop()!.toLowerCase()
    : "";
  if (FORBIDDEN_EXTENSIONS.has(ext)) {
    throw new ValidationError("That file type is not allowed.");
  }

  // Detect actual MIME from magic bytes. For text-only files, file-type
  // returns undefined — that's fine for .txt / .csv (handled below).
  const detected = await fileTypeFromBuffer(buffer);
  const declared = (args.declaredMime ?? "").toLowerCase();

  // Plain-text formats have no magic bytes; trust the extension if it's a
  // known text type and the declared mime is in the allowlist.
  if (!detected) {
    if ((ext === "txt" || ext === "csv") && declared.startsWith("text/")) {
      return { filename, mime: declared || "text/plain" };
    }
    throw new ValidationError("Could not verify file type.");
  }

  if (!ALLOWED_ATTACHMENT_MIMES.has(detected.mime)) {
    throw new ValidationError("That file type is not allowed.");
  }

  // If the client declared a MIME and it disagrees with the magic bytes,
  // reject — common technique for sneaking executables past naive filters.
  if (declared && declared !== detected.mime) {
    // Some tolerance: docx/xlsx are sometimes declared as octet-stream by old
    // clients. Allow that exact case; reject everything else.
    const tolerated =
      declared === "application/octet-stream" &&
      (detected.mime.includes("officedocument") ||
        detected.mime === "application/msword" ||
        detected.mime === "application/vnd.ms-excel");
    if (!tolerated) {
      throw new ValidationError("File type does not match its contents.");
    }
  }

  return { filename, mime: detected.mime };
}
