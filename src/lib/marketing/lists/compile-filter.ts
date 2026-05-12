import "server-only";

import { type AnyColumn, type SQL, and, eq, gt, gte, ilike, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { ValidationError } from "@/lib/errors";
import {
  ALLOWED_LEAD_FILTER_FIELDS,
  type AllowedLeadFilterField,
  type FilterDsl,
  type FilterOp,
  type FilterRule,
  filterDslSchema,
  isOpCompatibleWithField,
} from "@/lib/security/filter-dsl";
import { likeContains, likeEndsWith, likeStartsWith } from "@/lib/security/like-escape";
import { leads } from "@/db/schema/leads";

/**
 * Compile a filter DSL into a Drizzle WHERE
 * fragment scoped to `leads`. Always combined with `is_deleted = false`
 * by the caller.
 *
 * Security:
 * • The DSL is re-validated through the Zod schema first. Any field
 * name not in `ALLOWED_LEAD_FILTER_FIELDS` is rejected before
 * reaching SQL.
 * • Per-field op compatibility is enforced again at compile time as a
 * defense in depth — even if the schema's superRefine is bypassed.
 * • String values destined for ILIKE are routed through `escapeLike`
 * (via `likeContains` / `likeStartsWith` / `likeEndsWith`) to neutralise
 * `%` and `_` wildcards.
 * • Array operands are bounded by the schema's max array length.
 */
export function compileFilterDsl(dslInput: unknown): SQL {
  const parsed = filterDslSchema.safeParse(dslInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      first ? `${first.path.join(".") || "filter"}: ${first.message}` : "Invalid filter.",
      { issues: parsed.error.issues },
    );
  }
  const dsl = parsed.data;
  const ruleFragments: SQL[] = [];
  for (const rule of dsl.rules) {
    ruleFragments.push(compileRule(rule as FilterRule));
  }
  if (ruleFragments.length === 0) {
    throw new ValidationError("At least one filter rule required.");
  }
  const combined = dsl.combinator === "AND" ? and(...ruleFragments) : or(...ruleFragments);
  if (!combined) {
    throw new ValidationError("Failed to combine filter rules.");
  }
  return combined;
}

function compileRule(rule: FilterRule): SQL {
  const field = rule.field as AllowedLeadFilterField;
  const op = rule.op as FilterOp;
  const desc = ALLOWED_LEAD_FILTER_FIELDS[field];
  if (!desc) {
    throw new ValidationError(`Unknown filter field: ${field}.`);
  }
  if (!isOpCompatibleWithField(field, op)) {
    throw new ValidationError(`Op '${op}' is not allowed on field '${field}'.`);
  }
  const column = (leads as unknown as Record<string, unknown>)[desc.columnKey];
  if (!column) {
    throw new ValidationError(`Field '${field}' has no column mapping.`);
  }
  const col = column as AnyColumn;

  switch (op) {
    case "eq":
      return eq(col, coerceScalar(rule.value, desc.type));
    case "neq":
      return ne(col, coerceScalar(rule.value, desc.type));
    case "gt":
      return gt(col, coerceScalar(rule.value, desc.type));
    case "gte":
      return gte(col, coerceScalar(rule.value, desc.type));
    case "lt":
      return lt(col, coerceScalar(rule.value, desc.type));
    case "lte":
      return lte(col, coerceScalar(rule.value, desc.type));
    case "in":
      return inArray(col, coerceArray(rule.value, desc.type));
    case "notIn":
      return notInArray(col, coerceArray(rule.value, desc.type));
    case "isNull":
      return isNull(col);
    case "isNotNull":
      return isNotNull(col);
    case "contains":
      return ilike(col, likeContains(asString(rule.value)));
    case "notContains": {
      const fragment = sql`${col} NOT ILIKE ${likeContains(asString(rule.value))}`;
      return fragment;
    }
    case "startsWith":
      return ilike(col, likeStartsWith(asString(rule.value)));
    case "endsWith":
      return ilike(col, likeEndsWith(asString(rule.value)));
    default: {
      const exhaustive: never = op;
      throw new ValidationError(`Unhandled op: ${exhaustive as string}.`);
    }
  }
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new ValidationError("This op requires a string value.");
  }
  return value;
}

function coerceScalar(
  value: unknown,
  type: "string" | "number" | "date" | "boolean" | "enum",
): string | number | boolean | Date | null {
  if (value === null) return null;
  if (type === "string" || type === "enum") {
    if (typeof value !== "string") {
      throw new ValidationError("Expected a string value.");
    }
    return value;
  }
  if (type === "number") {
    if (typeof value !== "number") {
      throw new ValidationError("Expected a numeric value.");
    }
    return value;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") {
      throw new ValidationError("Expected a boolean value.");
    }
    return value;
  }
  if (type === "date") {
    if (typeof value !== "string") {
      throw new ValidationError("Expected an ISO date string.");
    }
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new ValidationError("Invalid date.");
    }
    return d;
  }
  throw new ValidationError(`Unsupported field type: ${type}.`);
}

function coerceArray(
  value: unknown,
  type: "string" | "number" | "date" | "boolean" | "enum",
): (string | number | boolean | Date)[] {
  if (!Array.isArray(value)) {
    throw new ValidationError("Expected an array value.");
  }
  return value.map((v) => {
    const coerced = coerceScalar(v, type);
    if (coerced === null) {
      throw new ValidationError("Array values cannot be null.");
    }
    return coerced;
  });
}

export type { FilterDsl, FilterRule, FilterOp };
