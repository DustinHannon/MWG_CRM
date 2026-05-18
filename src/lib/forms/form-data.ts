/**
 * Single canonical `FormData` → plain object reducer + parse helper for
 * server actions. Previously copy-pasted (with subtle divergences) into
 * every create action; consolidating it removes the drift and gives one
 * place to reason about empty-string / checkbox handling AND form-value
 * preservation across a validation error.
 */

import type { z } from "zod";
import { ValidationError } from "@/lib/errors";

export interface FormDataToObjectOptions {
  /** Keys to drop entirely (e.g. "id", "tagIds" handled out of band). */
  omitKeys?: readonly string[];
  /**
   * Checkbox keys to coerce to a real boolean: an HTML checkbox submits
   * "on" only when checked and is absent when unchecked, so callers that
   * need an explicit `false` (server-side refinement, not just optional)
   * list the key here. "on"/"true" → true, anything else → false.
   */
  booleanKeys?: readonly string[];
  /**
   * Empty-string handling:
   *  - "trim" (default): skip when `value.trim()` is empty (so a field
   *    of only spaces is treated as omitted — what the create forms
   *    want, since Zod `.optional()` then yields undefined → null).
   *  - "exact": skip only when the value is exactly "" (preserves
   *    whitespace-only values for callers that intentionally allow them).
   */
  emptyMode?: "trim" | "exact";
}

export function formDataToObject(
  formData: FormData,
  options: FormDataToObjectOptions = {},
): Record<string, unknown> {
  const { omitKeys, booleanKeys, emptyMode = "trim" } = options;
  const omit = omitKeys ? new Set(omitKeys) : null;
  const bool = booleanKeys ? new Set(booleanKeys) : null;
  const obj: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (omit?.has(key)) continue;
    if (bool?.has(key)) {
      obj[key] = value === "on" || value === "true";
      continue;
    }
    if (typeof value === "string") {
      const isEmpty = emptyMode === "trim" ? value.trim() === "" : value === "";
      if (isEmpty) continue;
    }
    obj[key] = value;
  }
  return obj;
}

/** Every raw string scalar in a FormData, for echoing back to the form. */
function rawStringValues(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * Canonical "parse a submitted form or fail" for server actions.
 *
 * Replaces the safeParse + first-issue-throw block that was duplicated
 * across every create action. On failure throws a `ValidationError`
 * carrying BOTH the Zod issues (→ per-field `fieldErrors`) AND the raw
 * submitted string values (→ `ActionFailure.values`). The forms feed
 * those values back as `defaultValue`, so React 19's automatic
 * uncontrolled-form reset (it resets the form once the action settles —
 * including when it returns an error) restores what the user typed
 * instead of blanking it. Never blank a form on a validation error.
 */
export function parseFormOrThrow<S extends z.ZodTypeAny>(
  schema: S,
  formData: FormData,
  options: FormDataToObjectOptions = {},
): z.output<S> {
  const result = schema.safeParse(formDataToObject(formData, options));
  if (result.success) return result.data;
  const first = result.error.issues[0];
  throw new ValidationError(
    first
      ? `${first.path.join(".") || "input"}: ${first.message}`
      : "Validation failed.",
    { issues: result.error.issues, values: rawStringValues(formData) },
  );
}
