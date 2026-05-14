import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { logger, newRequestId } from "@/lib/logger";
import { runWithRequestContext } from "@/lib/observability/request-context";
import { rateLimit } from "@/lib/security/rate-limit";
import {
  type SessionUser,
  requireAdmin,
  requireSession,
} from "@/lib/auth-helpers";
import { KnownError } from "@/lib/errors";

type AuthMode = "session" | "admin";

interface Options {
  /** Stable log label + audit tag, e.g. "leads.list", "admin.users.list". */
  action: string;
  /** Auth gate. `session` calls requireSession; `admin` calls requireAdmin. */
  auth: AuthMode;
}

type Handler = (
  req: NextRequest,
  ctx: { user: SessionUser; requestId: string },
) => Promise<Response>;

/**
 * Per-user sliding-window cap for internal cursor list endpoints.
 * 120/min is generous for normal infinite-scroll usage (50-row pages
 * with debounced scroll fetches stay well under) but blocks scripted
 * scraping. Honors the global Postgres-backed limiter in
 * `src/lib/security/rate-limit.ts`.
 */
const RATE_LIMIT_PER_USER_PER_MIN = 120;

/**
 * Wraps an internal session-authenticated cursor-paginated GET handler.
 *
 * Adds:
 * - Correlation id (x-request-id pass-through or fresh) propagated via
 *   AsyncLocalStorage for downstream logger / audit instrumentation.
 * - Auth gate up front (session or admin).
 * - Per-user sliding-window rate limit (120 req/min).
 * - Structured INFO log on success, WARN on KnownError, ERROR on
 *   unhandled. Stable `{action}.ok` / `.known_error` / `.rate_limited`
 *   / `.unhandled` message pattern.
 * - Consistent JSON error envelope `{ error, code?, requestId? }`.
 *
 * NEXT_REDIRECT thrown by `requireSession` / `requireAdmin` on session
 * expiry propagates so Next.js can return 307 to /auth/signin or
 * /dashboard as designed — JSON consumers handle 307 (or non-JSON
 * body) by surfacing a re-auth error, same as before this wrapper.
 *
 * Counterpart to `withApi` in `./handler.ts` (API-key auth, full
 * api_usage_log row). This is the lighter session-auth sibling.
 */
export function withInternalListApi(
  options: Options,
  handler: Handler,
): (req: NextRequest) => Promise<Response> {
  return async (req: NextRequest): Promise<Response> => {
    const requestId =
      req.headers.get("x-request-id")?.slice(0, 64) ?? newRequestId();

    return runWithRequestContext({ requestId }, async () => {
      const start = Date.now();
      try {
        const user =
          options.auth === "admin"
            ? await requireAdmin()
            : await requireSession();

        const rl = await rateLimit(
          { kind: "internal_list", principal: user.id },
          RATE_LIMIT_PER_USER_PER_MIN,
          60,
        );
        if (!rl.allowed) {
          logger.warn(`${options.action}.rate_limited`, {
            userId: user.id,
            action: options.action,
            retryAfter: rl.retryAfter,
          });
          return NextResponse.json(
            {
              error: "Too many requests. Please wait and retry.",
              code: "RATE_LIMIT",
            },
            {
              status: 429,
              headers: { "Retry-After": String(rl.retryAfter ?? 60) },
            },
          );
        }

        const res = await handler(req, { user, requestId });
        logger.info(`${options.action}.ok`, {
          userId: user.id,
          action: options.action,
          status: res.status,
          durationMs: Date.now() - start,
        });
        return res;
      } catch (err) {
        // NEXT_REDIRECT from requireSession/requireAdmin (session
        // expiry, deactivation, non-admin hitting admin route)
        // propagates so Next.js can emit the framework-level 307.
        if (isNextRedirect(err)) throw err;

        if (err instanceof KnownError) {
          const status = statusFor(err.code);
          logger.warn(`${options.action}.known_error`, {
            action: options.action,
            errorCode: err.code,
            errorMessage: err.message,
            status,
            durationMs: Date.now() - start,
          });
          return NextResponse.json(
            { error: err.publicMessage, code: err.code },
            { status },
          );
        }

        logger.error(`${options.action}.unhandled`, {
          action: options.action,
          errorMessage: err instanceof Error ? err.message : String(err),
          errorStack: err instanceof Error ? err.stack : undefined,
          durationMs: Date.now() - start,
        });
        return NextResponse.json(
          {
            error: "Internal server error",
            code: "INTERNAL",
            requestId,
          },
          { status: 500 },
        );
      }
    });
  };
}

function isNextRedirect(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const digest = (err as { digest?: unknown }).digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

function statusFor(code: KnownError["code"]): number {
  switch (code) {
    case "VALIDATION":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "FORBIDDEN":
      return 403;
    case "CONFLICT":
      return 409;
    case "RATE_LIMIT":
      return 429;
    case "REAUTH_REQUIRED":
      return 401;
    case "INTERNAL":
      return 500;
    default:
      return 500;
  }
}
