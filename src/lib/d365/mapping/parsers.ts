import "server-only";
import { KnownError } from "@/lib/errors";

/**
 * Phase 23 — Shared mapping primitives.
 *
 * Mappers are run once per record during the `mapping` phase of an
 * import run. They:
 *   1. project D365 OData fields → mwg-crm column shapes,
 *   2. preserve recency (`createdon` / `modifiedon` ride through),
 *   3. emit non-fatal `ValidationWarning`s instead of throwing for
 *      enum mismatches and Zod failures.
 *
 * Hard mapping failures (missing required source data, like a NULL
 * `createdon`) raise `MappingError` so the orchestrator can flip the
 * record to `status='failed'` without halting the whole batch.
 */

/* -------------------------------------------------------------------------- *
 *                              Errors                                        *
 * -------------------------------------------------------------------------- */

/**
 * Hard mapping failure — the source record is missing data required
 * to land it in mwg-crm. Caller flips the record to `status='failed'`
 * but does NOT halt the run.
 */
export class MappingError extends KnownError {
  readonly field: string;
  constructor(field: string, publicMessage: string) {
    super("VALIDATION", publicMessage, `mapping_error:${field}`, { field });
    this.name = "MappingError";
    this.field = field;
  }
}

/* -------------------------------------------------------------------------- *
 *                              Warnings                                      *
 * -------------------------------------------------------------------------- */

/**
 * Non-fatal mapper output. Surfaced inline in the review UI; never
 * blocks commit. Codes are stable (used in admin filters and audit
 * `after` payloads).
 */
export interface ValidationWarning {
  field: string;
  code:
    | "unmapped_picklist"
    | "missing_required"
    | "schema_violation"
    | "out_of_range"
    | "unparseable_date"
    | "custom_field_dropped"
    | "unparseable_value";
  message: string;
}

/**
 * Common return shape for every mapper. `attached` carries child
 * activities ($expand'd notes / tasks / phonecalls / appointments /
 * emails) for parent-entity mappers; sibling mappers (note, task,
 * etc.) leave `attached` empty.
 */
export interface MapResult<TMapped> {
  mapped: TMapped;
  attached: AttachedActivity[];
  customFields: Record<string, unknown>;
  warnings: ValidationWarning[];
}

/**
 * Attached activity payload — pre-mapped by the relevant child
 * mapper. The orchestrator inserts them after the parent record
 * commits and back-fills the parent FK at insert time.
 */
export interface AttachedActivity {
  /** Activity kind in mwg-crm (`note` | `call` | `meeting` | `email` | `task`). */
  kind: "note" | "call" | "meeting" | "email" | "task" | "phonecall";
  /** D365 source primary key (for dedup + external_ids linkage). */
  sourceId: string;
  /** Source entity-type string (`annotation` | `task` | ...). */
  sourceEntityType: string;
  /** Mapped insert payload — shape depends on the child kind. */
  payload: Record<string, unknown>;
  warnings: ValidationWarning[];
  customFields: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- *
 *                             Date parsing                                   *
 * -------------------------------------------------------------------------- */

/**
 * Parse a D365 OData ISO 8601 timestamp. Throws `MappingError` on
 * NULL / missing / unparseable — recency preservation requires a
 * real source timestamp; we never silently substitute `new Date()`.
 */
export function parseODataDate(s: string | null | undefined): Date {
  if (s == null || s === "") {
    throw new MappingError(
      "createdon",
      "Source record has no D365 timestamp; recency preservation requires createdon/modifiedon.",
    );
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new MappingError(
      "createdon",
      `Unparseable D365 timestamp: ${String(s).slice(0, 80)}`,
    );
  }
  return d;
}

/** Tolerant variant — returns null on missing/invalid instead of throwing. */
export function parseOptionalDate(s: string | null | undefined): Date | null {
  if (s == null || s === "") return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* -------------------------------------------------------------------------- *
 *                             Value coercion                                 *
 * -------------------------------------------------------------------------- */

/**
 * D365 sometimes returns booleans as native true/false, sometimes as
 * 0/1 (legacy attribute metadata). Normalize to a strict boolean.
 */
export function parseBoolean(
  v: boolean | number | string | null | undefined,
): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const lower = v.trim().toLowerCase();
    return lower === "true" || lower === "1" || lower === "yes";
  }
  return false;
}

/** Coerce to non-empty trimmed string or null. */
export function parseString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== "string") return String(v);
  const t = v.trim();
  return t === "" ? null : t;
}

/** Coerce to a finite number or null; tolerant of D365's string-encoded numerics. */
export function parseNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/* -------------------------------------------------------------------------- *
 *                          Picklist mapper factory                           *
 * -------------------------------------------------------------------------- */

/**
 * Build a picklist mapper for a single D365 OptionSet → mwg-crm enum
 * field. Unmapped values produce a `ValidationWarning`
 * (`code: 'unmapped_picklist'`) and resolve to `defaultValue`. NULL
 * source values resolve to `defaultValue` without a warning (D365
 * frequently leaves OptionSets blank).
 *
 * @param map Numeric D365 option-set value → mwg-crm enum string.
 * @param fieldName Name surfaced in the warning (matches the local
 *                  column name, not the D365 logical name).
 * @param defaultValue The mwg-crm enum string to use for both NULL
 *                     sources and unmapped values.
 */
export function picklistMapper<T extends string>(
  map: Record<number, T>,
  fieldName: string,
  defaultValue: T,
): (value: number | null | undefined) => {
  value: T;
  warning?: ValidationWarning;
} {
  return (value) => {
    if (value == null) return { value: defaultValue };
    const mapped = map[value];
    if (mapped !== undefined) return { value: mapped };
    return {
      value: defaultValue,
      warning: {
        field: fieldName,
        code: "unmapped_picklist",
        message: `D365 ${fieldName} value ${value} is not mapped — using default '${defaultValue}'.`,
      },
    };
  };
}

/* -------------------------------------------------------------------------- *
 *                       Custom-field passthrough                             *
 * -------------------------------------------------------------------------- */

/**
 * Detects D365 custom-field naming conventions:
 *   - `new_*` (default custom-prefix on every D365 environment)
 *   - `cr<digits>_*` (system-assigned solution prefixes)
 *   - `mwg_*` (MWG-tenant custom solution prefix)
 *
 * Used by every mapper to peel custom fields off the raw payload
 * into the `metadata` JSONB column. Native fields and OData
 * annotations stay out of metadata.
 */
const CUSTOM_FIELD_PREFIXES = /^(new_|cr[0-9a-f]+_|mwg_)/i;

/**
 * Extract custom fields from a D365 payload.
 *
 * Returns an object containing only keys matching the custom-field
 * prefix conventions. Skips OData annotation keys (`@odata.*`,
 * `*@OData.Community.*`), known navigation keys (`_*_value`), and
 * the native key list passed in as `excludeKeys`.
 */
export function extractCustomFields(
  raw: Record<string, unknown>,
  excludeKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("@odata.")) continue;
    if (key.includes("@OData.")) continue;
    if (excludeKeys.has(key)) continue;
    if (CUSTOM_FIELD_PREFIXES.test(key)) {
      result[key] = value;
    }
  }
  return result;
}

/* -------------------------------------------------------------------------- *
 *                       Soft validation helper                               *
 * -------------------------------------------------------------------------- */

/**
 * Run a Zod schema as a soft validator: parse failures convert to
 * `ValidationWarning[]` instead of throwing. Returns the parsed value
 * when successful, or the original payload (typed as `T`) plus
 * warnings when not. The reviewer sees the warnings and may edit the
 * mappedPayload before commit.
 *
 * Zod is a peer of every mapper; this helper centralises the
 * never-throw contract so individual mappers don't reinvent it.
 */
export interface SoftValidationResult<T> {
  value: T;
  warnings: ValidationWarning[];
}

interface ZodLikeError {
  flatten(): { fieldErrors: Record<string, string[] | undefined> };
}

interface ZodLikeResult<T> {
  success: boolean;
  data?: T;
  error?: ZodLikeError;
}

interface ZodLikeSchema<T> {
  safeParse(input: unknown): ZodLikeResult<T>;
}

export function softValidate<T>(
  schema: ZodLikeSchema<T>,
  input: T,
): SoftValidationResult<T> {
  const result = schema.safeParse(input);
  if (result.success && result.data !== undefined) {
    return { value: result.data, warnings: [] };
  }
  const warnings: ValidationWarning[] = [];
  if (result.error) {
    const issues = result.error.flatten();
    for (const [field, messages] of Object.entries(issues.fieldErrors)) {
      if (!messages) continue;
      for (const message of messages) {
        warnings.push({
          field,
          code: "schema_violation",
          message,
        });
      }
    }
  }
  return { value: input, warnings };
}
