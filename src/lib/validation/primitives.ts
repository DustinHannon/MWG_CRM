import { z } from "zod";
import { parsePhoneNumber } from "libphonenumber-js";

/**
 * Reusable Zod field primitives. Apply these at every server-action /
 * route-handler boundary so consistent validation rules cover the whole
 * surface area. Database CHECK constraints are the seatbelt; these are the
 * shoulder belt.
 *
 * Each primitive is composable. Need an optional version? `nameField.optional()`.
 * Need nullable? `nameField.nullable()`.
 */

/** Letters (any unicode), spaces, hyphens, apostrophes, periods. 1–100 chars. */
export const nameField = z
  .string()
  .trim()
  .min(1, "Required")
  .max(100, "Must be 100 characters or fewer")
  .regex(
    /^[\p{L}\p{M}'.\-\s]+$/u,
    "Letters, spaces, hyphens, apostrophes and periods only",
  );

/** Email — RFC-ish format + max length the Postgres UNIQUE index can hold. */
export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email("Not a valid email address")
  .max(254, "Email is too long");

/**
 * Phone — accepts reasonable input, normalizes to E.164 if possible. Returns
 * the original string if parsing fails (so we don't reject legit international
 * numbers we don't have rules for) but caps length at 50.
 */
export const phoneField = z
  .string()
  .trim()
  .max(50, "Phone is too long")
  .transform((v) => {
    if (!v) return v;
    try {
      const parsed = parsePhoneNumber(v, "US");
      return parsed?.isValid() ? parsed.format("E.164") : v;
    } catch {
      return v;
    }
  });

/** URL — only http/https. Reject `javascript:`, `data:`, `file:`, etc. */
export const urlField = z
  .string()
  .trim()
  .url("Not a valid URL")
  .max(2048, "URL is too long")
  .refine((u) => /^https?:\/\//i.test(u), {
    message: "URL must use http or https",
  });

/** Currency — non-negative, ≤ $1B, two decimal places. */
export const currencyField = z
  .number()
  .nonnegative("Must be zero or positive")
  .lte(1_000_000_000, "Value is too large")
  .multipleOf(0.01, "At most two decimal places");

/** Date — reject absurd years. Use `z.coerce.date()` for ISO string inputs. */
export const dateField = z.coerce
  .date()
  .refine((d) => d.getFullYear() >= 1900 && d.getFullYear() <= 2100, {
    message: "Date is out of acceptable range",
  });

/** Note / activity body — text up to 50k chars. HTML sanitation happens elsewhere. */
export const noteBody = z
  .string()
  .min(1, "Required")
  .max(50_000, "Note is too long");

/** Tag name — letters, numbers, spaces, hyphens. */
export const tagName = z
  .string()
  .trim()
  .min(1, "Required")
  .max(50, "Must be 50 characters or fewer")
  .regex(/^[\p{L}\p{N}\s\-]+$/u, "Letters, numbers, spaces and hyphens only");

/** UUID — for inputs that must be a UUID (record ids in form payloads). */
export const uuidField = z.string().uuid("Not a valid id");

/**
 * Free-text short field (titles, headlines). 1–200 chars. Doesn't restrict
 * character set — for that, use a more specific primitive.
 */
export const shortText = z.string().trim().min(1).max(200);

/** Free-text medium field. Up to 1000 chars. */
export const mediumText = z.string().trim().max(1_000);

/** Optimistic-concurrency version stamp accompanying every update. */
export const versionField = z.coerce.number().int().nonnegative();

/**
 * Sanitize a filename for storage. Strips path separators, NULs, control
 * chars, and leading dots. Caps length at 255.
 */
export function sanitizeFilename(name: string): string {
  return name
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "_")
    .replace(/^\.+/, "_")
    .trim()
    .slice(0, 255) || "file";
}

/** Allowed MIME types for attachments. Match against magic bytes too. */
export const ALLOWED_ATTACHMENT_MIMES = new Set<string>([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.ms-excel",
]);

/** Max file sizes (bytes). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024; // 25 MB
export const MAX_IMPORT_ROWS = 10_000;
export const IMPORT_FAILED_ROWS_CAP = 1_000;

/** Refuse any of these extensions at the boundary. */
export const FORBIDDEN_EXTENSIONS = new Set<string>([
  "exe",
  "bat",
  "cmd",
  "ps1",
  "sh",
  "scr",
  "msi",
  "dll",
  "com",
  "vbs",
  "js",
  "jar",
  "app",
  "lnk",
]);
