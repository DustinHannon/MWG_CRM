import "server-only";
import type {
  D365Annotation,
  D365Appointment,
  D365Email,
  D365PhoneCall,
  D365Task,
} from "../types";
import { mapD365Annotation } from "./annotation";
import { mapD365Appointment } from "./appointment";
import { mapD365Email } from "./email";
import { mapD365Phonecall } from "./phonecall";
import { mapD365Task } from "./task";
import {
  type AttachedActivity,
  type ChildParentContext,
  type ValidationWarning,
} from "./parsers";

/**
 * Attached-children mapping: ROOT → nested raw child arrays →
 * `AttachedActivity[]`.
 *
 * Lives in its own module (imported by the four ROOT mappers) so it can
 * import the CHILD mappers without a circular dependency through the
 * `index.ts` barrel (barrel → root → barrel would cycle).
 */

/**
 * Nested raw child arrays as `pull-batch` groups them under
 * `import_records.rawPayload.children`, stitched to their root by GUID
 * (`_regardingobjectid_value` for activities, `_objectid_value` for
 * annotations). Every key is optional — a root with no children of a
 * given type omits the key. Only ROOT records carry a `children` block.
 */
export interface D365Children {
  task?: D365Task[];
  phonecall?: D365PhoneCall[];
  appointment?: D365Appointment[];
  email?: D365Email[];
  annotation?: D365Annotation[];
}

/**
 * Resolves a child's D365 owner (the `_ownerid_value_email` enrichment
 * `pull-batch` writes onto each child raw) to a local `users.id`, or
 * null when unresolvable. Kept as a caller-supplied function so the
 * mapper stays free of network/db calls — the orchestrator owns
 * resolution. When omitted (or it returns null) the child rides on
 * `fallbackUserId` (the root's resolved owner) so activities are never
 * left ownerless.
 */
export type ChildOwnerResolver = (
  childRaw: Record<string, unknown>,
) => string | null;

/**
 * Field-name prefix that marks a `ValidationWarning` as CHILD-origin.
 * Run-wide halt gates in map-batch (`unmapped_picklist` halt, the
 * validation-regression count, the per-record review escalation) operate
 * on ROOT-scoped warnings ONLY; a bad child (an unmapped picklist on a
 * call, an "Untitled task" default) must never halt the run or force the
 * root to manual review — children.ts's contract is "a bad child must not
 * sink the root graph". map-batch detects this marker via
 * {@link isChildWarning} and excludes such warnings from those gates
 * while still persisting them so the reviewer sees them non-fatally.
 *
 * The marker is a `field` prefix (not a separate `scope` key) so the
 * existing `ValidationWarning` shape — which flows through JSONB,
 * `validationWarnings`, and the halt detectors that key on `code` — is
 * unchanged. It mirrors how map-batch already EXCLUDES the
 * `owner_default_owner_used` warning from the same gates (there by
 * `code`; here by `field` prefix, since a child can carry any code).
 */
export const CHILD_WARNING_FIELD_PREFIX = "__child__:";

/** True when a warning originated from a CHILD mapper (see prefix above). */
export function isChildWarning(field: string): boolean {
  return field.startsWith(CHILD_WARNING_FIELD_PREFIX);
}

/**
 * Tag a child mapper's warning as child-origin by prefixing its `field`
 * with `CHILD_WARNING_FIELD_PREFIX<childType>:`, preserving the original
 * field name after it. Idempotent — a warning already tagged is returned
 * untouched.
 */
function tagChildWarning(
  childType: string,
  warning: ValidationWarning,
): ValidationWarning {
  if (isChildWarning(warning.field)) return warning;
  return {
    ...warning,
    field: `${CHILD_WARNING_FIELD_PREFIX}${childType}:${warning.field}`,
  };
}

/**
 * Run every applicable CHILD mapper over a root's nested child arrays
 * and collect the `AttachedActivity[]`. Shared by all four ROOT mappers
 * (lead / contact / account / opportunity) — the only per-root variance
 * is which child arrays exist, which `D365Children` already encodes.
 *
 * `parentContext` is the ROOT's `{ parentEntityType, parentSourceId }`;
 * it drives each child's `_parentEntityType` / `_parentSourceId`
 * virtuals so commit-batch links children to the root's in-memory UUID
 * — never the polymorphic lookuplogicalname annotation.
 *
 * Child mapping is non-fatal: a single child that throws a
 * `MappingError` (e.g. a NULL `createdon`) must not sink the whole root
 * graph, so each child is mapped in isolation and a failure becomes a
 * `ValidationWarning` rather than propagating. The reviewer sees the
 * warning; the root and its remaining children still commit.
 *
 * Every warning returned here is tagged child-origin (its `field` is
 * prefixed with {@link CHILD_WARNING_FIELD_PREFIX}) so map-batch's
 * run-wide halt gates ignore it — a child picklist gap or default must
 * not halt the run or escalate the root to manual review.
 */
export function mapAttachedChildren(args: {
  children: D365Children | undefined;
  parentContext: ChildParentContext;
  fallbackUserId: string | null;
  resolveChildOwnerId?: ChildOwnerResolver;
}): { attached: AttachedActivity[]; warnings: ValidationWarning[] } {
  const { children, parentContext, fallbackUserId, resolveChildOwnerId } = args;
  const attached: AttachedActivity[] = [];
  const warnings: ValidationWarning[] = [];
  if (!children) return { attached, warnings };

  const userIdFor = (raw: unknown): string | null =>
    resolveChildOwnerId?.(raw as Record<string, unknown>) ?? fallbackUserId;

  const run = (
    sourceEntityType: string,
    sourceId: string,
    fn: () => { attached: AttachedActivity[]; warnings: ValidationWarning[] },
  ): void => {
    try {
      const result = fn();
      attached.push(...result.attached);
      // Tag every child warning child-origin so the run-wide halt gates
      // exclude it (see CHILD_WARNING_FIELD_PREFIX).
      for (const w of result.warnings) {
        warnings.push(tagChildWarning(sourceEntityType, w));
      }
    } catch (err) {
      // Isolate a bad child — surface as a warning, keep the root graph.
      warnings.push({
        field: `${CHILD_WARNING_FIELD_PREFIX}${sourceEntityType}:__child__`,
        code: "missing_required",
        message: `Skipped ${sourceEntityType} ${sourceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  };

  for (const raw of children.task ?? []) {
    const userId = userIdFor(raw);
    run("task", raw.activityid, () =>
      mapD365Task(raw, {
        resolvedAssignedToId: userId,
        resolvedCreatedById: userId,
        parentContext,
      }),
    );
  }
  for (const raw of children.phonecall ?? []) {
    run("phonecall", raw.activityid, () =>
      mapD365Phonecall(raw, {
        resolvedUserId: userIdFor(raw),
        parentContext,
      }),
    );
  }
  for (const raw of children.appointment ?? []) {
    run("appointment", raw.activityid, () =>
      mapD365Appointment(raw, {
        resolvedUserId: userIdFor(raw),
        parentContext,
      }),
    );
  }
  for (const raw of children.email ?? []) {
    run("email", raw.activityid, () =>
      mapD365Email(raw, {
        resolvedUserId: userIdFor(raw),
        parentContext,
      }),
    );
  }
  for (const raw of children.annotation ?? []) {
    run("annotation", raw.annotationid, () =>
      mapD365Annotation(raw, {
        resolvedUserId: userIdFor(raw),
        parentContext,
      }),
    );
  }

  return { attached, warnings };
}
