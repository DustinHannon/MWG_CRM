/**
 * Escape the five HTML special characters so a string can be safely
 * interpolated into HTML markup. Used wherever we build email/HTML
 * bodies that may include user-supplied or system-supplied content
 * (display names, error messages, subjects) and want to avoid a
 * stored-XSS class issue.
 *
 * Phase 25 §4.5 — promoted from per-file locals (admin/email-test,
 * admin/email-failures/[id]/retry) and email-footer's prior strip-
 * angle-brackets shortcut into a single canonical helper.
 *
 * Consumer count (as of d753780): 3 — `src/lib/email/send.ts`
 * appendFooter, `src/app/admin/email-failures/[id]/retry/route.ts`,
 * `src/app/api/admin/email-test/route.ts`. This sits exactly at the
 * Phase 24 §B.6 ≥3-consumer threshold; if a future cleanup drops one
 * of those call sites the helper should be inlined back to the
 * surviving two. The `&amp;`-first ordering is load-bearing — replacing
 * `<` or `>` first would re-escape the `&amp;` we just inserted.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
