import "server-only";
import { createHash } from "node:crypto";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys, apiUsageLog } from "@/db/schema/api-keys";
import { hasScope, type Scope } from "./scopes";

export interface AuthedKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  rateLimitPerMinute: number;
  createdById: string;
}

/**
 * Verifies the Bearer token on the request. Returns either a parsed
 * AuthedKey or a structured failure suitable for `errorResponse`.
 *
 * The token format is `mwg_live_<rest>`. We do a constant-time-ish
 * lookup by hashing first, then querying by hash equality — DB unique
 * index means at most one row matches.
 */
export async function authenticateApiRequest(req: Request): Promise<
  | { ok: true; key: AuthedKey }
  | {
      ok: false;
      status: number;
      code:
        | "UNAUTHORIZED"
        | "KEY_REVOKED"
        | "KEY_EXPIRED";
      message: string;
    }
> {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return {
      ok: false,
      status: 401,
      code: "UNAUTHORIZED",
      message: "Missing Bearer token in Authorization header",
    };
  }
  const token = auth.slice("Bearer ".length).trim();
  if (!token.startsWith("mwg_live_") || token.length < 20) {
    return {
      ok: false,
      status: 401,
      code: "UNAUTHORIZED",
      message: "Invalid token format",
    };
  }

  const hash = createHash("sha256").update(token).digest("hex");
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hash))
    .limit(1);

  if (!row) {
    return {
      ok: false,
      status: 401,
      code: "UNAUTHORIZED",
      message: "Invalid token",
    };
  }
  if (row.revokedAt) {
    return {
      ok: false,
      status: 401,
      code: "KEY_REVOKED",
      message: "Token has been revoked",
    };
  }
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    return {
      ok: false,
      status: 401,
      code: "KEY_EXPIRED",
      message: "Token has expired",
    };
  }

  return {
    ok: true,
    key: {
      id: row.id,
      name: row.name,
      prefix: row.keyPrefix,
      scopes: row.scopes,
      rateLimitPerMinute: row.rateLimitPerMinute,
      createdById: row.createdById,
    },
  };
}

export function requireScopeOnKey(key: AuthedKey, scope: Scope): boolean {
  return hasScope(key.scopes, scope);
}

/**
 * Postgres-backed sliding window: count usage rows for this key in
 * the last 60s. The `api_usage_log_key_idx` index makes this an O(log
 * n) seek + small range scan even at high volumes. Future: swap for
 * Upstash Redis token bucket if measured latency becomes an issue.
 */
export async function checkRateLimit(
  keyId: string,
  limitPerMinute: number,
): Promise<{ ok: true; remaining: number } | { ok: false; resetIn: number }> {
  const [row] = await db
    .select({ value: count() })
    .from(apiUsageLog)
    .where(
      and(
        eq(apiUsageLog.apiKeyId, keyId),
        gte(apiUsageLog.createdAt, sql`now() - interval '1 minute'`),
      ),
    );

  const used = Number(row?.value ?? 0);
  if (used >= limitPerMinute) {
    return { ok: false, resetIn: 60 };
  }
  return { ok: true, remaining: limitPerMinute - used };
}
