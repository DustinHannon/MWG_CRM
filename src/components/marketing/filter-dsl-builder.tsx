"use client";

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import {
  ALLOWED_LEAD_FILTER_FIELDS,
  FILTER_DSL_LIMITS,
  type FilterDsl,
  type FilterRule,
  filterDslSchema,
  OPS_FOR_TYPE,
} from "@/lib/security/filter-dsl";
import { FilterRuleRow } from "./filter-rule-row";

/**
 * Phase 21 — Top-level filter DSL builder.
 *
 * Holds local state for combinator + rules, validates via
 * `filterDslSchema.safeParse` on every change, and emits the parsed DSL
 * to the parent on success or surfaces error strings on failure.
 */
interface Props {
  initial?: FilterDsl;
  onChange: (dsl: FilterDsl) => void;
  onValidationError?: (errors: string[]) => void;
}

function defaultRule(): FilterRule {
  // Pick the first allowed field as a sensible default starting rule.
  const firstField = Object.keys(ALLOWED_LEAD_FILTER_FIELDS)[0] ?? "firstName";
  const fieldDesc = ALLOWED_LEAD_FILTER_FIELDS[firstField];
  const firstOp = fieldDesc ? OPS_FOR_TYPE[fieldDesc.type][0] ?? "eq" : "eq";
  return {
    field: firstField,
    op: firstOp,
    value: undefined,
  };
}

export function FilterDslBuilder({
  initial,
  onChange,
  onValidationError,
}: Props) {
  const [combinator, setCombinator] = useState<"AND" | "OR">(
    initial?.combinator ?? "AND",
  );
  const [rules, setRules] = useState<FilterRule[]>(
    initial?.rules && initial.rules.length > 0
      ? initial.rules
      : [defaultRule()],
  );

  // Mutable ref so the effect can call the latest callbacks without
  // including them in the dependency array (avoids re-validation loops
  // when the parent passes a freshly bound function each render).
  const onChangeRef = useRef(onChange);
  const onValidationErrorRef = useRef(onValidationError);
  useEffect(() => {
    onChangeRef.current = onChange;
    onValidationErrorRef.current = onValidationError;
  }, [onChange, onValidationError]);

  useEffect(() => {
    const candidate = { combinator, rules };
    const parsed = filterDslSchema.safeParse(candidate);
    if (parsed.success) {
      onChangeRef.current(parsed.data);
      onValidationErrorRef.current?.([]);
    } else if (onValidationErrorRef.current) {
      const messages = parsed.error.issues.map((i) => {
        // Translate Zod paths like `rules.0.value` into "Rule 1: …"
        // so the surface area of the message matches what the user
        // sees on screen instead of the schema shape.
        const ruleIdx =
          i.path[0] === "rules" && typeof i.path[1] === "number"
            ? (i.path[1] as number)
            : null;
        const prefix = ruleIdx !== null ? `Rule ${ruleIdx + 1}: ` : "";
        return `${prefix}${i.message}`;
      });
      onValidationErrorRef.current(messages);
    }
  }, [combinator, rules]);

  function updateRule(index: number, next: FilterRule) {
    setRules((prev) => prev.map((r, i) => (i === index ? next : r)));
  }

  function removeRule(index: number) {
    setRules((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((_, i) => i !== index);
    });
  }

  function addRule() {
    setRules((prev) => {
      if (prev.length >= FILTER_DSL_LIMITS.maxRules) return prev;
      return [...prev, defaultRule()];
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Combinator pill toggle */}
      <div className="inline-flex w-fit gap-1 rounded-md border border-border bg-muted/40 p-1">
        <button
          type="button"
          onClick={() => setCombinator("AND")}
          aria-pressed={combinator === "AND"}
          className={
            combinator === "AND"
              ? "rounded bg-foreground px-3 py-1 text-xs font-medium text-background"
              : "rounded px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
          }
        >
          Match all (AND)
        </button>
        <button
          type="button"
          onClick={() => setCombinator("OR")}
          aria-pressed={combinator === "OR"}
          className={
            combinator === "OR"
              ? "rounded bg-foreground px-3 py-1 text-xs font-medium text-background"
              : "rounded px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
          }
        >
          Match any (OR)
        </button>
      </div>

      {/* Rule rows */}
      <div className="flex flex-col gap-2">
        {rules.map((rule, idx) => (
          <FilterRuleRow
            key={idx}
            rule={rule}
            onChange={(next) => updateRule(idx, next)}
            onRemove={() => removeRule(idx)}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={addRule}
        disabled={rules.length >= FILTER_DSL_LIMITS.maxRules}
        className="inline-flex w-fit items-center gap-1 rounded-md border border-dashed border-border bg-transparent px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Add rule
      </button>
      {rules.length >= FILTER_DSL_LIMITS.maxRules ? (
        <p className="text-xs text-muted-foreground">
          Reached the {FILTER_DSL_LIMITS.maxRules}-rule limit.
        </p>
      ) : null}
    </div>
  );
}
