"use client";

import { useMemo } from "react";
import { X } from "lucide-react";
import {
  ALLOWED_LEAD_FILTER_FIELDS,
  type AllowedLeadFilterField,
  FILTER_DSL_LIMITS,
  type FilterFieldDescriptor,
  type FilterOp,
  type FilterRule,
  isOpCompatibleWithField,
  OPS_FOR_TYPE,
} from "@/lib/security/filter-dsl";

/**
 * Phase 21 — Single-rule editor for the filter DSL builder.
 *
 * The field and op dropdowns source from `ALLOWED_LEAD_FILTER_FIELDS`
 * and `OPS_FOR_TYPE` — there is no free-text input. The value input
 * shape is driven by the descriptor type and the selected op.
 */
interface Props {
  rule: FilterRule;
  onChange: (rule: FilterRule) => void;
  onRemove: () => void;
}

const OP_LABELS: Record<FilterOp, string> = {
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

export function FilterRuleRow({ rule, onChange, onRemove }: Props) {
  const fieldKey = rule.field as AllowedLeadFilterField;
  const descriptor: FilterFieldDescriptor | undefined =
    ALLOWED_LEAD_FILTER_FIELDS[fieldKey];

  const fieldOptions = useMemo(
    () =>
      Object.entries(ALLOWED_LEAD_FILTER_FIELDS).map(([key, d]) => ({
        key,
        label: d.label,
      })),
    [],
  );

  const opOptions = useMemo<readonly FilterOp[]>(
    () => (descriptor ? OPS_FOR_TYPE[descriptor.type] : []),
    [descriptor],
  );

  function handleFieldChange(nextField: string) {
    const nextDesc = ALLOWED_LEAD_FILTER_FIELDS[nextField];
    if (!nextDesc) return;
    // Reset op to a compatible one if current op no longer applies.
    const stillCompatible = isOpCompatibleWithField(
      nextField as AllowedLeadFilterField,
      rule.op as FilterOp,
    );
    const nextOp = stillCompatible
      ? rule.op
      : (OPS_FOR_TYPE[nextDesc.type][0] ?? "eq");
    onChange({ field: nextField, op: nextOp, value: undefined });
  }

  function handleOpChange(nextOp: FilterOp) {
    // Reset value when toggling between value/no-value or scalar/array.
    const wasArray = rule.op === "in" || rule.op === "notIn";
    const willBeArray = nextOp === "in" || nextOp === "notIn";
    const wasNullish = rule.op === "isNull" || rule.op === "isNotNull";
    const willBeNullish = nextOp === "isNull" || nextOp === "isNotNull";
    const shouldReset =
      wasArray !== willBeArray || wasNullish !== willBeNullish;
    onChange({
      field: rule.field,
      op: nextOp,
      value: shouldReset ? undefined : rule.value,
    });
  }

  function handleValueChange(value: FilterRule["value"]) {
    onChange({ field: rule.field, op: rule.op, value });
  }

  const noValueOp = rule.op === "isNull" || rule.op === "isNotNull";
  const arrayOp = rule.op === "in" || rule.op === "notIn";

  return (
    <div className="flex flex-wrap items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
      {/* Field selector */}
      <select
        value={rule.field}
        onChange={(e) => handleFieldChange(e.target.value)}
        className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      >
        {fieldOptions.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
          </option>
        ))}
      </select>

      {/* Op selector */}
      <select
        value={rule.op}
        onChange={(e) => handleOpChange(e.target.value as FilterOp)}
        className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      >
        {opOptions.map((op) => (
          <option key={op} value={op}>
            {OP_LABELS[op]}
          </option>
        ))}
      </select>

      {/* Value input — shape varies by type + op */}
      {!noValueOp && descriptor ? (
        <ValueInput
          descriptor={descriptor}
          isArray={arrayOp}
          value={rule.value}
          onChange={handleValueChange}
        />
      ) : null}

      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove rule"
        className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

interface ValueInputProps {
  descriptor: FilterFieldDescriptor;
  isArray: boolean;
  value: FilterRule["value"];
  onChange: (value: FilterRule["value"]) => void;
}

function ValueInput({
  descriptor,
  isArray,
  value,
  onChange,
}: ValueInputProps) {
  if (isArray) {
    return <TagInput value={value} onChange={onChange} />;
  }

  switch (descriptor.type) {
    case "string": {
      const v = typeof value === "string" ? value : "";
      return (
        <input
          type="text"
          value={v}
          maxLength={FILTER_DSL_LIMITS.maxValueLength}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Value"
          className="h-9 min-w-[180px] flex-1 rounded-md border border-border bg-background px-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      );
    }
    case "number": {
      const v = typeof value === "number" ? String(value) : "";
      return (
        <input
          type="number"
          value={v}
          onChange={(e) => {
            const n = e.target.value === "" ? undefined : Number(e.target.value);
            if (n === undefined || Number.isNaN(n)) {
              onChange(undefined);
            } else {
              onChange(n);
            }
          }}
          placeholder="Number"
          className="h-9 w-[140px] rounded-md border border-border bg-background px-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      );
    }
    case "date": {
      const v = typeof value === "string" ? value.slice(0, 10) : "";
      return (
        <input
          type="date"
          value={v}
          onChange={(e) => {
            const raw = e.target.value;
            if (!raw) {
              onChange(undefined);
              return;
            }
            // Convert YYYY-MM-DD to ISO at start of day local.
            const d = new Date(raw);
            if (Number.isNaN(d.getTime())) {
              onChange(undefined);
              return;
            }
            onChange(d.toISOString());
          }}
          className="h-9 w-[160px] rounded-md border border-border bg-background px-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      );
    }
    case "boolean": {
      const v = typeof value === "boolean" ? value : false;
      return (
        <select
          value={v ? "true" : "false"}
          onChange={(e) => onChange(e.target.value === "true")}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    }
    case "enum": {
      const v = typeof value === "string" ? value : "";
      const options = descriptor.enumValues ?? [];
      return (
        <select
          value={v}
          onChange={(e) =>
            onChange(e.target.value === "" ? undefined : e.target.value)
          }
          className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          <option value="">Select…</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      );
    }
    default:
      return null;
  }
}

interface TagInputProps {
  value: FilterRule["value"];
  onChange: (value: FilterRule["value"]) => void;
}

/**
 * Comma-separated tag/chip input for `in` / `notIn` ops. Stores the array
 * back on the rule on every commit (Enter, comma, or blur).
 */
function TagInput({ value, onChange }: TagInputProps) {
  const arr = Array.isArray(value)
    ? value.map((v) => String(v))
    : [];

  function commit(next: string[]) {
    if (next.length === 0) {
      onChange(undefined);
      return;
    }
    onChange(
      next.slice(0, FILTER_DSL_LIMITS.maxArrayLength) as
        FilterRule["value"],
    );
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const target = e.currentTarget;
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const next = target.value.trim();
      if (!next) return;
      commit([...arr, next]);
      target.value = "";
    } else if (e.key === "Backspace" && target.value === "" && arr.length > 0) {
      commit(arr.slice(0, -1));
    }
  }

  function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    const next = e.currentTarget.value.trim();
    if (!next) return;
    commit([...arr, next]);
    e.currentTarget.value = "";
  }

  function removeAt(i: number) {
    commit(arr.filter((_, idx) => idx !== i));
  }

  return (
    <div className="flex min-h-9 min-w-[220px] flex-1 flex-wrap items-center gap-1 rounded-md border border-border bg-background px-2 py-1">
      {arr.map((tag, i) => (
        <span
          key={`${tag}-${i}`}
          className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-foreground"
        >
          {tag}
          <button
            type="button"
            onClick={() => removeAt(i)}
            aria-label={`Remove ${tag}`}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </span>
      ))}
      <input
        type="text"
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder={arr.length === 0 ? "Type and press Enter" : ""}
        className="min-w-[80px] flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
      />
    </div>
  );
}
