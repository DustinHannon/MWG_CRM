import { z } from "zod";

/**
 * Filter DSL allowlists and Zod schema for the
 * marketing list segment builder.
 *
 * Security model:
 * • Field names are an allowlist mapped to a column descriptor.
 * Anything not in the list is rejected — there is no "free text"
 * field name in the DSL or the UI.
 * • Operators are an allowlist; the compiler maps each to a Drizzle
 * comparator.
 * • Per-field op compatibility is enforced by `isOpCompatibleWithField`.
 * • Value cardinality (max chars per scalar, max array length) is
 * enforced in the schema.
 *
 * Compile site: src/lib/marketing/lists/compile-filter.ts.
 * UI site: src/components/marketing/filter-dsl-builder.tsx.
 */

export type FilterFieldType = "string" | "number" | "date" | "boolean" | "enum";

export interface FilterFieldDescriptor {
  /** Type drives operator filtering and value coercion. */
  type: FilterFieldType;
  /** Drizzle column reference key (used by the compile site). */
  columnKey: string;
  /** Optional enum values for `type === "enum"`. */
  enumValues?: readonly string[];
  /** Human-readable label for the UI dropdown. */
  label: string;
}

/**
 * The complete allowlist of lead fields exposed to the marketing list
 * filter builder. Adding a field here is the ONLY way to expose it to
 * the DSL — the UI dropdown and the compile site both source from this
 * map. Reviewers should treat additions to this list with the same care
 * as adding a new public API field.
 */
export const ALLOWED_LEAD_FILTER_FIELDS: Record<string, FilterFieldDescriptor> =
  {
    // Identity
    firstName: { type: "string", columnKey: "firstName", label: "First name" },
    lastName: { type: "string", columnKey: "lastName", label: "Last name" },
    email: { type: "string", columnKey: "email", label: "Email" },
    jobTitle: { type: "string", columnKey: "jobTitle", label: "Job title" },
    companyName: {
      type: "string",
      columnKey: "companyName",
      label: "Company name",
    },
    industry: { type: "string", columnKey: "industry", label: "Industry" },
    // Address
    city: { type: "string", columnKey: "city", label: "City" },
    state: { type: "string", columnKey: "state", label: "State / Region" },
    postalCode: {
      type: "string",
      columnKey: "postalCode",
      label: "Postal code",
    },
    country: { type: "string", columnKey: "country", label: "Country" },
    // Pipeline
    status: {
      type: "enum",
      columnKey: "status",
      label: "Lead status",
      enumValues: [
        "new",
        "contacted",
        "qualified",
        "unqualified",
        "converted",
        "lost",
      ],
    },
    rating: {
      type: "enum",
      columnKey: "rating",
      label: "Rating",
      enumValues: ["hot", "warm", "cold"],
    },
    source: {
      type: "enum",
      columnKey: "source",
      label: "Source",
      enumValues: [
        "web",
        "referral",
        "advertisement",
        "trade_show",
        "phone",
        "email",
        "import",
        "other",
      ],
    },
    scoreBand: {
      type: "enum",
      columnKey: "scoreBand",
      label: "Score band",
      enumValues: ["hot", "warm", "cold"],
    },
    score: { type: "number", columnKey: "score", label: "Score" },
    estimatedValue: {
      type: "number",
      columnKey: "estimatedValue",
      label: "Estimated value",
    },
    // Compliance flags
    doNotEmail: {
      type: "boolean",
      columnKey: "doNotEmail",
      label: "Do not email",
    },
    doNotContact: {
      type: "boolean",
      columnKey: "doNotContact",
      label: "Do not contact",
    },
    // Timestamps
    createdAt: { type: "date", columnKey: "createdAt", label: "Created" },
    updatedAt: { type: "date", columnKey: "updatedAt", label: "Updated" },
    lastActivityAt: {
      type: "date",
      columnKey: "lastActivityAt",
      label: "Last activity",
    },
    estimatedCloseDate: {
      type: "date",
      columnKey: "estimatedCloseDate",
      label: "Estimated close date",
    },
  } as const;

export type AllowedLeadFilterField = keyof typeof ALLOWED_LEAD_FILTER_FIELDS;

/**
 * Operator allowlist. The compile site maps each to a Drizzle helper.
 * Operator availability is filtered by field type at the UI layer and
 * re-validated at compile time.
 */
export const ALLOWED_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "in",
  "notIn",
  "isNull",
  "isNotNull",
] as const;

export type FilterOp = (typeof ALLOWED_OPS)[number];

/**
 * Per-type operator compatibility. The UI uses this to filter the op
 * dropdown; the compile site uses it to reject incompatible combos.
 */
export const OPS_FOR_TYPE: Record<FilterFieldType, readonly FilterOp[]> = {
  string: [
    "eq",
    "neq",
    "contains",
    "notContains",
    "startsWith",
    "endsWith",
    "in",
    "notIn",
    "isNull",
    "isNotNull",
  ],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "notIn", "isNull", "isNotNull"],
  date: ["eq", "neq", "gt", "gte", "lt", "lte", "isNull", "isNotNull"],
  boolean: ["eq", "neq"],
  enum: ["eq", "neq", "in", "notIn", "isNull", "isNotNull"],
};

export function isOpCompatibleWithField(
  field: AllowedLeadFilterField,
  op: FilterOp,
): boolean {
  const fieldDesc = ALLOWED_LEAD_FILTER_FIELDS[field];
  if (!fieldDesc) return false;
  return OPS_FOR_TYPE[fieldDesc.type].includes(op);
}

/**
 * Bounds — caps DSL complexity so a malicious or careless caller can't
 * shovel an unbounded payload through.
 */
export const FILTER_DSL_LIMITS = {
  maxRules: 50,
  maxValueLength: 500,
  maxArrayLength: 1000,
} as const;

const fieldEnum = z.enum(
  Object.keys(ALLOWED_LEAD_FILTER_FIELDS) as [string, ...string[]],
);

const opEnum = z.enum(ALLOWED_OPS as unknown as [FilterOp, ...FilterOp[]]);

const scalarValueSchema = z.union([
  z.string().max(FILTER_DSL_LIMITS.maxValueLength),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const arrayValueSchema = z
  .array(
    z.union([
      z.string().max(FILTER_DSL_LIMITS.maxValueLength),
      z.number().finite(),
    ]),
  )
  .max(FILTER_DSL_LIMITS.maxArrayLength);

const filterRuleSchema = z
  .object({
    field: fieldEnum,
    op: opEnum,
    /** Value is omitted for `isNull`/`isNotNull`; otherwise scalar or array. */
    value: z.union([scalarValueSchema, arrayValueSchema]).optional(),
  })
  .superRefine((rule, ctx) => {
    const { field, op, value } = rule;
    const f = field as AllowedLeadFilterField;
    if (!isOpCompatibleWithField(f, op as FilterOp)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Op '${op}' is not allowed on field '${field}'.`,
      });
      return;
    }

    const needsValue = op !== "isNull" && op !== "isNotNull";
    if (needsValue && value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Op '${op}' requires a value.`,
      });
      return;
    }

    const expectsArray = op === "in" || op === "notIn";
    if (expectsArray && needsValue && !Array.isArray(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Op '${op}' expects an array value.`,
      });
    }
    if (!expectsArray && needsValue && Array.isArray(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Op '${op}' expects a scalar value.`,
      });
    }
  });

export const filterDslSchema = z.object({
  combinator: z.enum(["AND", "OR"]),
  rules: z
    .array(filterRuleSchema)
    .min(1, "At least one rule required.")
    .max(FILTER_DSL_LIMITS.maxRules),
});

export type FilterRule = z.infer<typeof filterRuleSchema>;
export type FilterDsl = z.infer<typeof filterDslSchema>;
