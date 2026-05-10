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
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
