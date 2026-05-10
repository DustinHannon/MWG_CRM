import {
  ALLOWED_LEAD_FILTER_FIELDS,
  type FilterDsl,
  type FilterRule,
} from "@/lib/security/filter-dsl";

/**
 * Phase 21 — Read-only formatted view of a saved list's filter DSL.
 *
 * Server component. Pure rendering — no validation here, the DSL was
 * already validated by `compileFilterDsl` on every refresh.
 */
interface Props {
  dsl: FilterDsl;
}

const OP_LABELS: Record<string, string> = {
  eq: "is",
  neq: "is not",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  contains: "contains",
  notContains: "does not contain",
  startsWith: "starts with",
  endsWith: "ends with",
  in: "in",
  notIn: "not in",
  isNull: "is empty",
  isNotNull: "is not empty",
};

function renderValue(value: FilterRule["value"]): string {
  if (value === undefined || value === null) return "—";
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export function DslSummary({ dsl }: Props) {
  const combinatorLabel = dsl.combinator === "AND" ? "All" : "Any";
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-[0.05em] text-muted-foreground">
        Filter rules ({combinatorLabel})
      </p>
      <ul className="flex flex-col gap-1.5">
        {dsl.rules.map((rule, idx) => {
          const desc = ALLOWED_LEAD_FILTER_FIELDS[rule.field];
          const label = desc?.label ?? rule.field;
          const op = OP_LABELS[rule.op] ?? rule.op;
          const noValue = rule.op === "isNull" || rule.op === "isNotNull";
          return (
            <li
              key={idx}
              className="flex flex-wrap items-center gap-1.5 text-sm text-foreground"
            >
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium">
                {label}
              </span>
              <span className="text-muted-foreground">{op}</span>
              {!noValue ? (
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs">
                  {renderValue(rule.value)}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
