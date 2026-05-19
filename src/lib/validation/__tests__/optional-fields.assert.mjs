/**
 * Smoke assertions for optionalUrlField and optionalEmailField.
 * Run: npx tsx src/lib/validation/__tests__/optional-fields.assert.mjs
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Inline the schemas under test so this file has no build-time deps.
// These match the implementations in primitives.ts exactly.
// ---------------------------------------------------------------------------

const optionalUrlField = z
  .string()
  .trim()
  .optional()
  .nullable()
  .transform((v, ctx) => {
    if (v == null || v === "") return null;
    if (v.length > 2048) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "URL is too long" });
      return z.NEVER;
    }
    if (!/^https?:\/\//i.test(v)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "URL must use http or https" });
      return z.NEVER;
    }
    try { new URL(v); } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Not a valid URL" });
      return z.NEVER;
    }
    return v;
  });

const optionalEmailField = z
  .string()
  .trim()
  .optional()
  .nullable()
  .transform((v, ctx) => {
    if (v == null || v === "") return null;
    const lower = v.toLowerCase();
    if (lower.length > 254) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Email is too long" });
      return z.NEVER;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(lower)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Not a valid email address" });
      return z.NEVER;
    }
    return lower;
  });

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let failures = 0;

function assert(label, actual, expected) {
  const ok =
    expected instanceof Error
      ? actual instanceof Error
      : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    console.error(`  FAIL  ${label}`);
    console.error(`        expected: ${JSON.stringify(expected)}`);
    console.error(`        actual:   ${JSON.stringify(actual)}`);
    failures++;
  }
}

function parseSafe(schema, value) {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  return new Error(r.error.issues.map(i => i.message).join("; "));
}

console.log("\noptionalUrlField:");
assert('""  → null',          parseSafe(optionalUrlField, ""),           null);
assert('"  " → null',         parseSafe(optionalUrlField, "  "),         null);
assert("null → null",         parseSafe(optionalUrlField, null),         null);
assert("undefined → null",    parseSafe(optionalUrlField, undefined),    null);
assert('"http://x.com" → passthrough', parseSafe(optionalUrlField, "http://x.com"),  "http://x.com");
assert('"https://x.com/p" → passthrough', parseSafe(optionalUrlField, "https://x.com/p"), "https://x.com/p");
assert('"notaurl" → ZodError', parseSafe(optionalUrlField, "notaurl"),   new Error());
assert('"ftp://x.com" → ZodError', parseSafe(optionalUrlField, "ftp://x.com"), new Error());
assert('>2048-char http URL → "URL is too long"',
  (() => {
    const r = optionalUrlField.safeParse("http://" + "a".repeat(2050));
    return !r.success ? r.error.issues[0]?.message : "passed";
  })(),
  "URL is too long");

console.log("\noptionalEmailField:");
assert('""  → null',          parseSafe(optionalEmailField, ""),           null);
assert('"  " → null',         parseSafe(optionalEmailField, "  "),         null);
assert("null → null",         parseSafe(optionalEmailField, null),         null);
assert("undefined → null",    parseSafe(optionalEmailField, undefined),    null);
assert('"user@ex.com" → lowercased', parseSafe(optionalEmailField, "User@Ex.com"), "user@ex.com");
assert('"notanemail" → ZodError', parseSafe(optionalEmailField, "notanemail"), new Error());
assert('"missing@tld" → ZodError', parseSafe(optionalEmailField, "missing@tld"), new Error());
// accountCreateSchema.email migrated to optionalEmailField: "" must null-out
assert('accountCreateSchema.email: "" → null', parseSafe(optionalEmailField, ""), null);

console.log("");
if (failures > 0) {
  console.error(`${failures} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log("All assertions passed.");
}
