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

/**
 * Person name. Required, 1–100 chars, trimmed. Deliberately NOT
 * character-class restricted: real names contain digits, punctuation,
 * and non-Latin scripts, and a "letters only" regex silently rejects
 * legitimate people (and pasted reference tags) for no integrity gain
 * — name is free text, not a key. Output encoding (React escaping) is
 * the XSS control, not input charset. Only emptiness and length are
 * enforced so the error is always actionable ("Required" / length).
 */
export const nameField = z
  .string()
  .trim()
  .min(1, "Required")
  .max(100, "Must be 100 characters or fewer");

/**
 * Optional money / decimal from a form. Empty → null. A non-empty value
 * that is not a non-negative finite number is REJECTED with a clear
 * message — it is NEVER silently coerced to null, because the create
 * forms post raw text (inputMode="decimal", not type="number") so the
 * user's typed value round-trips and a mistake surfaces as an inline
 * field error instead of a vanished amount. Accepts a leading "$" and
 * thousands separators ("$25,000"). Output: a 2-decimal string that
 * drops straight into numeric(.,2) columns (matches the prior
 * estimatedValue/amount contract), or null.
 */
export const optionalMoneyField = z
  .union([z.string(), z.number()])
  .optional()
  .nullable()
  .transform((v, ctx) => {
    if (v === null || v === undefined || v === "") return null;
    const n =
      typeof v === "number"
        ? v
        : Number(String(v).trim().replace(/[$,]/g, ""));
    if (!Number.isFinite(n)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter a number, e.g. 25000",
      });
      return z.NEVER;
    }
    if (n < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Must be zero or positive",
      });
      return z.NEVER;
    }
    // Ceiling sits just under the numeric(14,2) column max used by
    // estimatedValue/amount so an absurd/typo value gets a clean field
    // message instead of a Postgres overflow; still far above any
    // realistic deal or enterprise annual-revenue figure.
    if (n > 999_999_999_999) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Value is too large",
      });
      return z.NEVER;
    }
    return n.toFixed(2);
  });

/**
 * Optional non-negative integer count from a form (e.g. employees).
 * Same no-silent-drop contract as {@link optionalMoneyField}: empty →
 * null; a non-empty value that is not a whole number ≥ 0 is rejected
 * with a clear message rather than dropped. Output: number | null.
 */
export const optionalCountField = z
  .union([z.string(), z.number()])
  .optional()
  .nullable()
  .transform((v, ctx) => {
    if (v === null || v === undefined || v === "") return null;
    const n =
      typeof v === "number"
        ? v
        : Number(String(v).trim().replace(/,/g, ""));
    if (!Number.isInteger(n) || n < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter a whole number, e.g. 50",
      });
      return z.NEVER;
    }
    // Stay within int4 (the column type) so an oversized value is a
    // clean field error, not a driver overflow.
    if (n > 2_000_000_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Value is too large",
      });
      return z.NEVER;
    }
    return n;
  });

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
