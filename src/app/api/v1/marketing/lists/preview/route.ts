import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getPermissions,
  requireSession,
} from "@/lib/auth-helpers";
import { env } from "@/lib/env";
import {
  ForbiddenError,
  RateLimitError,
  ValidationError,
} from "@/lib/errors";
import { previewFilterDsl } from "@/lib/marketing/lists/refresh";
import { rateLimit } from "@/lib/security/rate-limit";
import { filterDslSchema } from "@/lib/security/filter-dsl";
import { withErrorBoundary } from "@/lib/server-action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  dsl: filterDslSchema,
});

/**
 * Live preview of a draft filter DSL.
 *
 * Rate-limited per user (RATE_LIMIT_FILTER_PREVIEW_PER_USER_PER_MINUTE)
 * because the new-list builder fires this on every keystroke (debounced)
 * and a malicious caller could otherwise hammer the leads index.
 */
export async function POST(req: Request) {
  const result = await withErrorBoundary(
    { action: "marketing.lists.preview" },
    async () => {
      const user = await requireSession();
      const perms = await getPermissions(user.id);
      if (!user.isAdmin && !perms.canManageMarketing) {
        throw new ForbiddenError("Marketing access required.");
      }

      const rl = await rateLimit(
        { kind: "filter_preview", principal: user.id },
        env.RATE_LIMIT_FILTER_PREVIEW_PER_USER_PER_MINUTE,
        60,
      );
      if (!rl.allowed) {
        throw new RateLimitError(
          `Too many preview requests. Retry in ${rl.retryAfter ?? 60}s.`,
        );
      }

      const json = await req.json().catch(() => null);
      const parsed = bodySchema.safeParse(json);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ValidationError(
          first
            ? `${first.path.join(".") || "input"}: ${first.message}`
            : "Invalid body.",
        );
      }

      return previewFilterDsl(parsed.data.dsl, 10);
    },
  );

  if (!result.ok) {
    return NextResponse.json(result, { status: statusFor(result.code) });
  }
  return NextResponse.json(result);
}

function statusFor(code: string): number {
  switch (code) {
    case "VALIDATION":
      return 400;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "RATE_LIMIT":
      return 429;
    case "REAUTH_REQUIRED":
      return 401;
    default:
      return 500;
  }
}
