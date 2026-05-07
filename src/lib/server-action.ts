import "server-only";
import { ZodError } from "zod";
import {
  ConflictError,
  KnownError,
  ValidationError,
} from "@/lib/errors";
import { logger, newRequestId } from "@/lib/logger";

/**
 * Result discriminated union returned to the client by every server action.
 * Server components can `if (!res.ok)` and surface `res.error` directly.
 *
 * Use `ActionResult` (no T) for actions that return nothing useful on
 * success — the success branch is `{ ok: true }` and `data` is absent.
 *
 * Use `ActionResult<T>` for actions that return data on success — the
 * success branch is `{ ok: true; data: T }`.
 */
export type ActionFailure = {
  ok: false;
  error: string;
  code: string;
  requestId: string;
};

export type ActionResult<T = void> = [T] extends [void]
  ? { ok: true } | ActionFailure
  : { ok: true; data: T } | ActionFailure;

export interface ActionContext {
  action: string;
  userId?: string;
  entityType?: string;
  entityId?: string;
  /** Optional pre-existing request id for log correlation. */
  requestId?: string;
}

/**
 * Heuristic — Next.js redirect() and notFound() throw "control-flow" errors
 * that MUST be re-thrown so the framework can act on them. They carry a
 * `digest` string starting with `NEXT_REDIRECT` or `NEXT_NOT_FOUND`.
 */
function isNextControlFlowError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const digest = (err as { digest?: unknown }).digest;
  if (typeof digest !== "string") return false;
  return digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_NOT_FOUND");
}

/**
 * Translate raw Postgres / driver errors into `KnownError` subclasses so the
 * UI surfaces a clean public message instead of a 500 stack trace.
 *
 * - SQLSTATE 23514 (CHECK violation) → `ValidationError`
 * - SQLSTATE 23505 (unique violation) → `ConflictError`
 *
 * Any other error is returned unchanged for the generic INTERNAL path.
 */
function translatePgError(err: unknown): unknown {
  if (!err || typeof err !== "object") return err;
  const code = (err as { code?: unknown }).code;
  if (code === "23514") {
    return new ValidationError("One or more fields failed validation.", {
      pgCode: "23514",
      cause: (err as Error).message,
    });
  }
  if (code === "23505") {
    return new ConflictError("That value is already in use.", {
      pgCode: "23505",
      cause: (err as Error).message,
    });
  }
  return err;
}

/**
 * Wrap a server action body. Catches anything thrown, redacts internal
 * detail, and returns a stable shape the UI can render. Logs success and
 * failure with timing metadata for observability.
 *
 * Throw `KnownError` subclasses for expected failures (validation, access,
 * conflict, rate limit, not found). Anything else is logged at ERROR with a
 * generic public message.
 *
 * Next.js `redirect()` / `notFound()` errors are re-thrown unchanged so the
 * framework can handle them.
 */
export async function withErrorBoundary<T>(
  ctx: ActionContext,
  fn: () => Promise<T>,
): Promise<ActionResult<T>> {
  const requestId = ctx.requestId ?? newRequestId();
  const start = performance.now();

  try {
    const data = await fn();
    logger.info("action.success", {
      requestId,
      action: ctx.action,
      userId: ctx.userId,
      entityType: ctx.entityType,
      entityId: ctx.entityId,
      durationMs: Math.round(performance.now() - start),
    });
    // Conditional shape — actions whose body returns void/undefined
    // surface as `{ ok: true }`; actions with payload surface as
    // `{ ok: true, data }`. We cast through unknown because TS can't
    // narrow the conditional ActionResult<T> at runtime.
    if (data === undefined) {
      return { ok: true } as unknown as ActionResult<T>;
    }
    return { ok: true, data } as unknown as ActionResult<T>;
  } catch (rawErr: unknown) {
    // Let Next.js redirect/notFound flow through unchanged.
    if (isNextControlFlowError(rawErr)) throw rawErr;

    // Translate Zod into ValidationError so it gets a clean public message.
    let err: unknown = translatePgError(rawErr);
    if (err instanceof ZodError) {
      const first = err.issues[0];
      err = new ValidationError(
        first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input.",
        { issues: err.issues },
      );
    }

    const isKnown = err instanceof KnownError;
    const durationMs = Math.round(performance.now() - start);

    logger.error("action.failure", {
      requestId,
      action: ctx.action,
      userId: ctx.userId,
      entityType: ctx.entityType,
      entityId: ctx.entityId,
      durationMs,
      errorCode: isKnown ? (err as KnownError).code : "INTERNAL",
      errorMessage: isKnown
        ? (err as KnownError).message
        : err instanceof Error
          ? err.message
          : String(err),
      ...(process.env.NODE_ENV !== "production" && err instanceof Error
        ? { errorStack: err.stack }
        : {}),
    });

    return {
      ok: false,
      error: isKnown
        ? (err as KnownError).publicMessage
        : "Something went wrong. Please try again.",
      code: isKnown ? (err as KnownError).code : "INTERNAL",
      requestId,
    };
  }
}
