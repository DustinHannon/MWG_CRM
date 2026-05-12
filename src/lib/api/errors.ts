import "server-only";

/**
 * canonical error envelope shape used by every /api/v1
 * route. The shape is documented in /apihelp; integrators code against
 * this contract.
 */

export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "RATE_LIMITED"
  | "CONFLICT"
  | "INTERNAL_ERROR"
  | "KEY_REVOKED"
  | "KEY_EXPIRED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "PAYLOAD_TOO_LARGE";

export interface ApiErrorDetail {
  field?: string;
  issue: string;
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: ApiErrorDetail[];
  };
}

export function errorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  options?: { details?: ApiErrorDetail[]; headers?: Record<string, string> },
): Response {
  const body: ApiErrorBody = {
    error: {
      code,
      message,
      ...(options?.details ? { details: options.details } : {}),
    },
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
}
