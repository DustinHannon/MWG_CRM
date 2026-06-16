import "server-only";
import { KnownError } from "@/lib/errors";

/**
 * Shared mapping primitives.
 *
 * Mappers are run once per record during the `mapping` phase of an
 * import run. They:
 * 1. project D365 OData fields → mwg-crm column shapes,
 * 2. preserve recency (`createdon` / `modifiedon` ride through),
 * 3. emit non-fatal `ValidationWarning`s instead of throwing for
 * enum mismatches and Zod failures.
 *
 * Hard mapping failures (missing required source data, like a NULL
 * `createdon`) raise `MappingError` so the orchestrator can flip the
 * record to `status='failed'` without halting the whole batch.
 */

/* -------------------------------------------------------------------------- *
 * Errors *
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
 * Warnings *
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
    | "unparseable_value"
    /**
     * record auto-skipped by the bad-lead quality
     * heuristic in `quality.ts`. Reasons are in the warning message.
     * map-batch reads `_qualityVerdict === 'garbage'` from the
     * mapped payload and transitions to status='skipped'.
     */
    | "bad_lead_quality"
    /**
     * record has 1-2 quality issues but enough real data
     * to commit. Surfaces in the review UI for manual confirmation.
     */
    | "suspicious_lead_quality"
    /**
     * the D365 owner could not be resolved to a user and fell back
     * to the configured default owner. Aggregated / low-severity:
     * feeds the batch-level owner-JIT-failure halt counter
     * (`detectOwnerJitFailure`) but is excluded from the per-record
     * review escalation and from `detectValidationRegression` — a
     * default-owner fallback is an expected, resolvable condition,
     * common in legacy data with former-employee owners.
     */
    | "owner_default_owner_used";
  message: string;
}

/**
 * Common return shape for every mapper. `attached` carries the child
 * activities (notes / tasks / phonecalls / appointments / emails)
 * stitched to their root by `pull-batch` and grouped under
 * `rawPayload.children`. ROOT mappers (lead / contact / account /
 * opportunity) run each child mapper over those nested arrays and
 * populate `attached`; the standalone CHILD mappers themselves return
 * the single-element `attached` the ROOT mapper collects.
 */
export interface MapResult<TMapped> {
  mapped: TMapped;
  attached: AttachedActivity[];
  customFields: Record<string, unknown>;
  warnings: ValidationWarning[];
}

/**
 * mwg-crm activity-kind discriminator on an attached child. `task`
 * routes the payload into the `tasks` table at commit; every other
 * kind routes into `activities` with the matching `activities.kind`.
 */
export type AttachedActivityKind =
  | "note"
  | "call"
  | "meeting"
  | "email"
  | "task";

/**
 * D365 source entity-type for an attached child — used for
 * `external_ids` linkage (source='d365', sourceEntityType, sourceId)
 * and dedup. Distinct from {@link AttachedActivityKind}: a D365
 * `phonecall` becomes a `call` activity, an `annotation` becomes a
 * `note`, a `task` stays a `task`.
 */
export type AttachedSourceEntityType =
  | "task"
  | "phonecall"
  | "appointment"
  | "email"
  | "annotation";

/**
 * Attached activity payload — pre-mapped by the relevant child
 * mapper. The commit phase inserts each child inside the root's
 * transaction with the parent FK (leadId / accountId / contactId /
 * opportunityId) set to the root's freshly-inserted local UUID; no
 * `external_ids` lookup, so the FK can never miss.
 *
 * `payload` carries two `_`-prefixed virtuals describing the ROOT the
 * child travels with:
 *  - `_parentEntityType` — the ROOT type (`lead`|`contact`|`account`|
 *    `opportunity`), driven by the root the child was stitched under,
 *    NOT by the polymorphic `lookuplogicalname` annotation.
 *  - `_parentSourceId` — the ROOT's D365 GUID.
 * commit-batch strips both virtuals before the Drizzle insert.
 */
export interface AttachedActivity {
  /** Activity kind in mwg-crm (`note` | `call` | `meeting` | `email` | `task`). */
  kind: AttachedActivityKind;
  /** D365 source primary key (for dedup + external_ids linkage). */
  sourceId: string;
  /** Source entity-type string (`annotation` | `task` | ...). */
  sourceEntityType: AttachedSourceEntityType;
  /** Mapped insert payload — shape depends on the child kind. */
  payload: Record<string, unknown>;
  warnings: ValidationWarning[];
  customFields: Record<string, unknown>;
}

/**
 * ROOT entity types. CHILD types (task / phonecall / appointment /
 * email / annotation) are NEVER imported standalone — they always
 * travel with one of these roots.
 */
export type D365RootEntityType = "lead" | "contact" | "account" | "opportunity";

/**
 * Explicit parent context every CHILD mapper receives so the ROOT —
 * not the polymorphic `_regardingobjectid_value@…lookuplogicalname`
 * annotation — drives the parent-entity type. `pull-batch` stitched
 * the child under a known root type, so this is authoritative.
 */
export interface ChildParentContext {
  /** The ROOT entity type the child was stitched under. */
  parentEntityType: D365RootEntityType;
  /** The ROOT's D365 GUID (carried through as `_parentSourceId`). */
  parentSourceId: string;
}

/* -------------------------------------------------------------------------- *
 * Date parsing *
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
 * Value coercion *
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

/**
 * Coerce to a safe http/https URL string, or null.
 *
 * D365 source records (and the URL render sinks on the lead detail /
 * print pages, which emit a raw `<a href>`) require that imported
 * `website` / `linkedinUrl` values can never carry a `javascript:`,
 * `data:`, or other non-http(s) scheme. This mirrors the canonical
 * `urlField` / `optionalUrlField` protocol guard in
 * `@/lib/validation/primitives` (the `^https?://` refine + `new URL`
 * parse), but as a non-throwing coercion so a malformed source URL
 * becomes null rather than failing the whole mapping.
 */
export function parseHttpUrl(v: unknown): string | null {
  const s = parseString(v);
  if (s == null) return null;
  if (s.length > 2048) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    new URL(s);
  } catch {
    return null;
  }
  return s;
}

/** Coerce to a finite number or null; tolerant of D365's string-encoded numerics. */
export function parseNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/* -------------------------------------------------------------------------- *
 * Picklist mapper factory *
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
 * column name, not the D365 logical name).
 * @param defaultValue The mwg-crm enum string to use for both NULL
 * sources and unmapped values.
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
 * Custom-field passthrough *
 * -------------------------------------------------------------------------- */

/**
 * Detects D365 custom-field naming conventions:
 * `new_*` (default custom-prefix on every D365 environment)
 * `cr<digits>_*` (system-assigned solution prefixes)
 * `mwg_*` (MWG-tenant custom solution prefix)
 *
 * Used by every mapper to peel custom fields off the raw payload
 * into the `metadata` JSONB column. Native fields and OData
 * annotations stay out of metadata.
 */
const CUSTOM_FIELD_PREFIXES = /^(new_|cr[0-9a-f]+_|mwg_)/i;

/**
 * Per-value cap on a passthrough custom-field string before it is
 * replaced by a truncation descriptor. A pathological D365 custom memo /
 * base64 attribute could otherwise bloat the `metadata` JSONB column
 * (and the staging `mapped_payload`) without bound. 16 KiB comfortably
 * holds any legitimate scalar custom field; oversized values keep a
 * length + preview so the truncation is never silent.
 */
const MAX_CUSTOM_FIELD_CHARS = 16_384;

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
      result[key] =
        typeof value === "string" && value.length > MAX_CUSTOM_FIELD_CHARS
          ? {
              __truncated: true,
              originalLength: value.length,
              preview: value.slice(0, 200),
            }
          : value;
    }
  }
  return result;
}

/* -------------------------------------------------------------------------- *
 * Child import metadata *
 * -------------------------------------------------------------------------- */

/**
 * Drop null / undefined entries from a record; returns undefined when
 * nothing survives so callers can omit the key entirely. Keeps `false`,
 * `0`, and other falsy-but-meaningful values.
 */
function compactRecord(
  obj: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!obj) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Build the `metadata` JSONB blob for a CHILD activity / task.
 *
 * `activities` and `tasks` model a fixed column set, so D365 fields with
 * no dedicated column (a phonecall's `phonenumber`, a task's
 * `percentcomplete`, an annotation's attachment descriptor, every
 * `statecode` / `statuscode` / `prioritycode`) plus the custom
 * (`new_*` / `cr*_` / `mwg_*`) fields {@link extractCustomFields} peels
 * off would otherwise be silently dropped on import. This preserves them
 * under `{ d365?: {<native>}, custom?: {<custom>} }`.
 *
 * Empty sub-objects are omitted; returns `null` when there is nothing to
 * store so the column stays NULL rather than holding `{}`.
 */
export function buildChildMetadata(parts: {
  source?: Record<string, unknown>;
  custom?: Record<string, unknown>;
}): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  const source = compactRecord(parts.source);
  if (source) out.d365 = source;
  const custom = compactRecord(parts.custom);
  if (custom) out.custom = custom;
  return Object.keys(out).length > 0 ? out : null;
}

/* -------------------------------------------------------------------------- *
 * Soft validation helper *
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
