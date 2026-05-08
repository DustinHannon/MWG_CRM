/**
 * Phase 11 — same-origin redirect validator. Used by Auth.js's
 * `redirect` callback in `src/auth.ts` to defend against open-redirect
 * attacks via `?callbackUrl=…` query strings.
 *
 * Rules (same as `safeCallback` in `auth/signin/actions.ts`):
 *   - relative paths starting with `/` (and not `//`) are allowed
 *   - same-origin absolute URLs are allowed
 *   - everything else collapses to `<baseUrl>/dashboard`
 *
 * Runs in the Edge runtime context too (Auth.js callback invocation),
 * so don't import server-only helpers.
 */
export function safeRedirect(url: string, baseUrl: string): string {
  try {
    if (!url) return `${baseUrl}/dashboard`;
    // Protocol-relative ("//evil.com") would otherwise startsWith("/").
    if (url.startsWith("//")) return `${baseUrl}/dashboard`;
    if (url.startsWith("/")) return `${baseUrl}${url}`;
    const parsed = new URL(url);
    if (parsed.origin === baseUrl) return url;
    return `${baseUrl}/dashboard`;
  } catch {
    return `${baseUrl}/dashboard`;
  }
}
