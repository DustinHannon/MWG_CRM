import "server-only";
import { ZodError } from "zod";
import { KnownError, ValidationError } from "@/lib/errors";
import { logger, newRequestId } from "@/lib/logger";

/**
 * Result discriminated union returned to the client by every server action.
 * Server components can `if (!res.ok)` and surface `res.error` directly.
 */
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string; requestId: string };

export interface ActionContext {
  action: string;
  userId?: string;
  entityType?: string;
  entityId?: string;
  /** Optional pre-existing request id for log correlation. */
  requestId?: string;
}

/**
 * Wrap a server action body. Catches anything thrown, redacts internal
 * detail, and returns a stable shape the UI can render. Logs success and
 * failure with timing metadata for observability.
 *
 * Throw `KnownError` subclasses for expected failures (validation, access,
 * conflict, rate limit, not found). Anything else is logged at ERROR with a
 * generic public message.
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
    return { ok: true, data };
  } catch (rawErr: unknown) {
    // Translate Zod into ValidationError so it gets a clean public message.
    let err: unknown = rawErr;
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
