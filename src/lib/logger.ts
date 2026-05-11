import "server-only";
import { getRequestId } from "@/lib/observability/request-context";

/**
 * Structured JSON logger. Single source of truth for server-side log lines —
 * `console.log` calls in committed code are forbidden because they can leak
 * tokens and bypass Vercel's structured ingestion.
 *
 * Usage:
 *   logger.info("lead.created", { userId, entityId: lead.id });
 *   logger.error("graph.send_failed", { errorCode: "401", errorMessage });
 *
 * Standard meta keys (use these names whenever applicable):
 *   requestId, userId, action, entityType, entityId,
 *   durationMs, errorCode, errorMessage, errorStack
 *
 * Phase 25 §4.3 — when a logger call happens inside a
 * `runWithRequestContext` scope and the caller didn't pass an
 * explicit `requestId` in the meta object, the context's id is
 * pulled in automatically so every line for one request shares the
 * same correlation id.
 */

type Level = "ERROR" | "WARN" | "INFO" | "DEBUG";

const REDACT_KEYS = new Set([
  "password",
  "password_hash",
  "passwordhash",
  "token",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "idtoken",
  "authorization",
  "cookie",
  "set-cookie",
  "client_secret",
  "clientsecret",
  "session",
  "sessiontoken",
  "secret",
  "ssn",
  "creditcard",
  "credit_card",
  "cvv",
  "api_key",
  "apikey",
]);

function redact(obj: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth-limit]";
  if (obj == null || typeof obj !== "object") return obj;
  if (obj instanceof Error) {
    return {
      name: obj.name,
      message: obj.message,
      ...(process.env.NODE_ENV !== "production" ? { stack: obj.stack } : {}),
    };
  }
  if (Array.isArray(obj)) return obj.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = REDACT_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : redact(v, depth + 1);
  }
  return out;
}

function emit(level: Level, msg: string, meta: Record<string, unknown>) {
  // Phase 25 §4.3 — auto-include requestId from AsyncLocalStorage
  // when the caller didn't supply one explicitly. Caller-supplied
  // requestId always wins so explicit values (e.g. retry attempts
  // logging the original request id) stay authoritative.
  const ctxRequestId = getRequestId();
  const enrichedMeta =
    ctxRequestId && meta.requestId === undefined
      ? { requestId: ctxRequestId, ...meta }
      : meta;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(redact(enrichedMeta) as Record<string, unknown>),
  };
  // ERROR/WARN to stderr; INFO/DEBUG to stdout. Vercel ingests both.
  const out = level === "ERROR" || level === "WARN" ? console.error : console.log;
  out(JSON.stringify(entry));
}

export const logger = {
  error: (msg: string, meta: Record<string, unknown> = {}) => emit("ERROR", msg, meta),
  warn: (msg: string, meta: Record<string, unknown> = {}) => emit("WARN", msg, meta),
  info: (msg: string, meta: Record<string, unknown> = {}) => emit("INFO", msg, meta),
  debug: (msg: string, meta: Record<string, unknown> = {}) => {
    if (process.env.NODE_ENV !== "production") emit("DEBUG", msg, meta);
  },
};

/**
 * Generate a short, URL-safe request id for correlating log lines and
 * surfacing in user-visible errors. Not crypto-secure; used purely for
 * traceability.
 */
export function newRequestId(): string {
  return (
    Math.random().toString(36).slice(2, 8) +
    Math.random().toString(36).slice(2, 8)
  );
}
