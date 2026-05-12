import "server-only";
import { and, eq, or, type SQL } from "drizzle-orm";
import { marketingTemplates } from "@/db/schema/marketing-templates";

/**
 * Phase 29 §4 — Visibility-aware query helpers for marketing
 * templates.
 *
 * The rule (locked in the brief): a user can SEE a template iff
 *
 *   scope = 'global'
 *   OR
 *   (scope = 'personal' AND created_by_id = $userId)
 *
 * Admins see everything in this CRM, but admin-bypass is folded into
 * the caller (e.g. server actions that resolve `requireSession()` and
 * check `user.isAdmin`); these helpers are deliberately scoped to the
 * common case so list pages, the campaign template-picker, and the
 * public REST endpoint share one truth-source.
 *
 * Edit/clone gates live in the action layer in
 * `src/app/(app)/marketing/templates/actions.ts` — they additionally
 * consider `canMarketingTemplatesEdit`.
 *
 * NOTE on `created_by_id`: the existing schema uses snake_case in SQL
 * (`created_by_id`) and camelCase in TS (`createdById`). The brief's
 * `creatorUserId` is purely the design-doc name; the column is and
 * remains `created_by_id` / `marketingTemplates.createdById`.
 */

/**
 * Drizzle `WHERE` fragment that filters `marketing_templates` rows to
 * those visible to `userId`. Compose with other `where` predicates via
 * `and(...)` — see `listTemplatesForUser` below for the canonical
 * pattern.
 *
 * Caller composes the soft-delete (`isDeleted = false`) gate
 * separately — some queries want archived templates and shouldn't
 * have the gate hard-coded here.
 */
export function templateVisibilityWhere(userId: string): SQL {
  // SAFETY: `or()` may return undefined when given no truthy
  // operands; that can't happen here because both inputs are SQL
  // builder calls. The `as SQL` cast keeps the public type tight.
  return or(
    eq(marketingTemplates.scope, "global"),
    and(
      eq(marketingTemplates.scope, "personal"),
      eq(marketingTemplates.createdById, userId),
    ),
  ) as SQL;
}

/**
 * True when `userId` is allowed to edit `template`. Mirrors the gate
 * inside `updateTemplateAction`:
 *
 *   personal → only the creator may edit.
 *   global   → creator OR `canMarketingTemplatesEdit` may edit.
 *
 * Pass `isAdmin = true` to bypass (admin gates are usually applied
 * upstream, but inline call sites can short-circuit through this
 * arg).
 */
export function canEditTemplate(input: {
  template: { scope: "global" | "personal"; createdById: string };
  userId: string;
  canMarketingTemplatesEdit: boolean;
  isAdmin?: boolean;
}): boolean {
  if (input.isAdmin) return true;
  if (input.template.createdById === input.userId) return true;
  if (input.template.scope === "personal") return false;
  return input.canMarketingTemplatesEdit;
}

/**
 * True when `userId` can see `template`. Mirrors
 * `templateVisibilityWhere` for the single-row check (used by
 * `/marketing/templates/[id]` and `/marketing/templates/[id]/edit`
 * before rendering).
 */
export function canViewTemplate(input: {
  template: { scope: "global" | "personal"; createdById: string };
  userId: string;
  isAdmin?: boolean;
}): boolean {
  if (input.isAdmin) return true;
  if (input.template.scope === "global") return true;
  return input.template.createdById === input.userId;
}
