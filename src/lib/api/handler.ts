import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys, apiUsageLog } from "@/db/schema/api-keys";
import { logger, newRequestId } from "@/lib/logger";
import { runWithRequestContext } from "@/lib/observability/request-context";
import {
  authenticateApiRequest,
  checkRateLimit,
  requireScopeOnKey,
  type AuthedKey,
} from "./auth";
import { errorResponse } from "./errors";
import type { Scope } from "./scopes";

interface HandlerArgs<P> {
  key: AuthedKey;
  params: P;
}

type Handler<P> = (
  req: Request,
  args: HandlerArgs<P>,
) => Promise<Response>;

interface WithApiOptions {
  /** Required scope, or null for endpoints any valid key can hit (`/me`). */
  scope: Scope | null;
  /** Action label for the api_usage_log row, e.g. `leads.list`. */
  action: string;
}

/**
 * Phase 13 — bundles the entire request lifecycle for an /api/v1
 * route: auth → scope → rate limit → handler → log. Every outcome
 * (including failures) writes a row to `api_usage_log`.
 *
 * Request and response bodies are NEVER copied to the log — only
 * shape summaries (size, top-level field names, count) so the log
 * does not carry PII.
 */
export function withApi<P = unknown>(
  options: WithApiOptions,
  handler: Handler<P>,
) {
  return async (
    req: Request,
    routeArgs?: { params: Promise<P> | P },
  ): Promise<Response> => {
    // Phase 25 §4.3 — establish the request context as early as
    // possible so the auth phase, rate-limit phase, and handler all
    // share one correlation id. Honor an upstream `x-request-id`
    // header when provided (so request ids match across a reverse
    // proxy / load balancer chain); otherwise mint a fresh one.
    const requestId =
      req.headers.get("x-request-id")?.slice(0, 64) ?? newRequestId();
    return runWithRequestContext({ requestId }, () =>
      runApiHandler(req, routeArgs, options, handler, requestId),
    );
  };
}

async function runApiHandler<P>(
  req: Request,
  routeArgs: { params: Promise<P> | P } | undefined,
  options: WithApiOptions,
  handler: Handler<P>,
  requestId: string,
): Promise<Response> {
    const start = Date.now();
    const url = new URL(req.url);
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      null;
    const ua = req.headers.get("user-agent") ?? null;
    const query = Object.fromEntries(url.searchParams.entries());

    // 1. Authenticate.
    const auth = await authenticateApiRequest(req);
    if (!auth.ok) {
      const res = errorResponse(auth.status, auth.code, auth.message);
      await logUsage({
        keyId: null,
        keyName: "unknown",
        keyPrefix: "unknown",
        method: req.method,
        path: url.pathname,
        action: options.action,
        statusCode: auth.status,
        ms: Date.now() - start,
        ip,
        ua,
        query,
        errorCode: auth.code,
        errorMessage: auth.message,
      });
      return res;
    }
    const key = auth.key;

    // 2. Scope check.
    if (options.scope && !requireScopeOnKey(key, options.scope)) {
      const message = `Required scope: ${options.scope}`;
      const res = errorResponse(403, "FORBIDDEN", message);
      await logUsage({
        keyId: key.id,
        keyName: key.name,
        keyPrefix: key.prefix,
        method: req.method,
        path: url.pathname,
        action: options.action,
        statusCode: 403,
        ms: Date.now() - start,
        ip,
        ua,
        query,
        errorCode: "FORBIDDEN",
        errorMessage: message,
      });
      return res;
    }

    // 3. Rate limit.
    const rl = await checkRateLimit(key.id, key.rateLimitPerMinute);
    if (!rl.ok) {
      const headers = {
        "X-RateLimit-Limit": String(key.rateLimitPerMinute),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(
          Math.floor(Date.now() / 1000) + rl.resetIn,
        ),
        "Retry-After": String(rl.resetIn),
      };
      const res = errorResponse(429, "RATE_LIMITED", "Too many requests", {
        headers,
      });
      await logUsage({
        keyId: key.id,
        keyName: key.name,
        keyPrefix: key.prefix,
        method: req.method,
        path: url.pathname,
        action: options.action,
        statusCode: 429,
        ms: Date.now() - start,
        ip,
        ua,
        query,
        errorCode: "RATE_LIMITED",
        errorMessage: "Too many requests",
      });
      return res;
    }

    // 4. Resolve route params (Next 16 passes params as a Promise).
    let params: P;
    try {
      params = (routeArgs?.params
        ? await routeArgs.params
        : ({} as P)) as P;
    } catch {
      params = {} as P;
    }

    // 5. Run the handler.
    let response: Response;
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    try {
      response = await handler(req, { key, params });
    } catch (err) {
      errorCode = "INTERNAL_ERROR";
      errorMessage = err instanceof Error ? err.message : String(err);
      logger.error("api.handler_threw", {
        path: url.pathname,
        action: options.action,
        keyId: key.id,
        errorMessage,
      });
      response = errorResponse(500, "INTERNAL_ERROR", "Internal server error");
    }

    // 6. Decorate with rate-limit headers.
    response.headers.set(
      "X-RateLimit-Limit",
      String(key.rateLimitPerMinute),
    );
    response.headers.set(
      "X-RateLimit-Remaining",
      String(Math.max(0, rl.remaining - 1)),
    );
    response.headers.set(
      "X-RateLimit-Reset",
      String(Math.floor(Date.now() / 1000) + 60),
    );

    // 7. Log usage.
    await logUsage({
      keyId: key.id,
      keyName: key.name,
      keyPrefix: key.prefix,
      method: req.method,
      path: url.pathname,
      action: options.action,
      statusCode: response.status,
      ms: Date.now() - start,
      ip,
      ua,
      query,
      errorCode: errorCode ?? (response.status >= 400 ? "HANDLER_ERROR" : null),
      errorMessage,
    });

    // 8. Bump last_used markers without blocking the response.
    void db
      .update(apiKeys)
      .set({ lastUsedAt: new Date(), lastUsedIp: ip })
      .where(eq(apiKeys.id, key.id))
      .catch(() => {
        /* best-effort */
      });

    return response;
}

interface LogArgs {
  keyId: string | null;
  keyName: string;
  keyPrefix: string;
  method: string;
  path: string;
  action: string | null;
  statusCode: number;
  ms: number;
  ip: string | null;
  ua: string | null;
  query: Record<string, string>;
  errorCode: string | null;
  errorMessage: string | null;
}

async function logUsage(args: LogArgs): Promise<void> {
  try {
    await db.insert(apiUsageLog).values({
      apiKeyId: args.keyId,
      apiKeyNameSnapshot: args.keyName,
      apiKeyPrefixSnapshot: args.keyPrefix,
      method: args.method,
      path: args.path,
      action: args.action,
      statusCode: args.statusCode,
      responseTimeMs: args.ms,
      ipAddress: args.ip,
      userAgent: args.ua,
      requestQuery: Object.keys(args.query).length > 0 ? args.query : null,
      requestBodySummary: null,
      responseSummary: null,
      errorCode: args.errorCode,
      errorMessage: args.errorMessage,
    });
  } catch (err) {
    logger.error("api.usage_log_failed", {
      path: args.path,
      action: args.action ?? null,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}
