import "server-only";
import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison. Returns false on length mismatch
 * without leaking the length difference via timing — when lengths differ
 * we still run a same-length compare against a zero buffer so the
 * total work is independent of the input difference. Both inputs are
 * encoded as UTF-8 bytes so a multi-byte character difference cannot
 * smuggle past the equal-length precondition that `timingSafeEqual`
 * requires.
 *
 * Use for: webhook signature compares, API key compares, any secret
 * that flows in from an untrusted source.
 *
 * Phase 14 introduced the same pattern inline in `requireCronAuth`
 * (`src/lib/cron-auth.ts`); this is the canonical exported helper for
 * the rest of the app.
 */
export function safeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
