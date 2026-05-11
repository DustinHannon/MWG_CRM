import "server-only";
import { ConfidentialClientApplication } from "@azure/msal-node";
import { writeSystemAudit } from "@/lib/audit";
import { env, MWG_TENANT_ID } from "@/lib/env";
import { fetchWithTimeout, GraphTimeoutError } from "@/lib/graph-fetch";
import { logger } from "@/lib/logger";
import { EmailNotConfiguredError } from "./types";

/**
 * Phase 15 — application-permissions Graph token via client-credentials flow.
 *
 * Reads ENTRA_CLIENT_ID/SECRET first, falls back to AUTH_MICROSOFT_ENTRA_ID_*
 * so the same Entra app powers both delegated SSO and app-permission Mail.Send
 * once Mail.Send + User.Read.All are admin-consented as Application permissions.
 *
 * MSAL maintains its own token cache; we add a 60s buffer on top so an
 * outbound call near token expiry doesn't race the refresh.
 */

let cca: ConfidentialClientApplication | null = null;
let cachedToken: { value: string; expiresAt: number } | null = null;

function resolveConfig() {
  const clientId = env.ENTRA_CLIENT_ID ?? env.AUTH_MICROSOFT_ENTRA_ID_ID ?? "";
  const clientSecret =
    env.ENTRA_CLIENT_SECRET ?? env.AUTH_MICROSOFT_ENTRA_ID_SECRET ?? "";
  const tenantId = env.ENTRA_TENANT_ID ?? MWG_TENANT_ID;
  return { clientId, clientSecret, tenantId };
}

export function isGraphAppConfigured(): boolean {
  const { clientId, clientSecret } = resolveConfig();
  return Boolean(clientId && clientSecret);
}

function getClient(): ConfidentialClientApplication {
  if (cca) return cca;
  const { clientId, clientSecret, tenantId } = resolveConfig();
  if (!clientId || !clientSecret) {
    throw new EmailNotConfiguredError();
  }
  cca = new ConfidentialClientApplication({
    auth: {
      clientId,
      clientSecret,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
  });
  return cca;
}

/**
 * Phase 25 §4.4 — MSAL acquireTokenByClientCredential throws on 5xx from
 * login.microsoftonline.com and on network failures. Add a 3-attempt
 * exponential backoff so a transient AAD blip doesn't cascade into
 * every Graph-dependent feature failing. Auth/config errors (4xx) are
 * NOT retried — those need code/config fixes, not patience.
 *
 * Note: `sendMail` is explicitly NOT retried at any layer (idempotency
 * unsafe — a partial 5xx that did deliver the message would produce
 * duplicate emails on retry). Only token acquisition gets retry.
 */
function isRetryableMsalError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // MSAL-node tags 5xx + network with ServerError / NetworkError names.
  if (err.name === "ServerError" || err.name === "NetworkError") return true;
  // Defensive: some MSAL paths surface raw HTTP status in the message.
  if (/\b5\d{2}\b/.test(err.message)) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function getGraphAppToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }
  const client = getClient();
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await client.acquireTokenByClientCredential({
        scopes: ["https://graph.microsoft.com/.default"],
      });
      if (!result?.accessToken) {
        throw new EmailNotConfiguredError(
          "Microsoft Graph token acquisition returned no access_token",
        );
      }
      if (attempt > 1) {
        await writeSystemAudit({
          actorEmailSnapshot: "system@graph",
          action: "graph.token.refresh.retried",
          targetType: "graph_token",
          after: { attempt },
        });
      }
      cachedToken = {
        value: result.accessToken,
        expiresAt:
          result.expiresOn?.getTime() ?? Date.now() + 50 * 60 * 1000, // ~50min default
      };
      return cachedToken.value;
    } catch (err) {
      lastErr = err;
      const isLast = attempt === maxAttempts;
      const retryable = isRetryableMsalError(err);
      logger.warn("graph_app_token.acquire_attempt_failed", {
        attempt,
        isLast,
        retryable,
        errorName: err instanceof Error ? err.name : "Unknown",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      if (isLast || !retryable) {
        await writeSystemAudit({
          actorEmailSnapshot: "system@graph",
          action: "graph.token.refresh.exhausted",
          targetType: "graph_token",
          after: {
            attempts: attempt,
            retryable,
            errorName: err instanceof Error ? err.name : "Unknown",
          },
        });
        throw err;
      }
      // Exponential backoff: 500ms, 1s. (Third attempt has no following sleep.)
      await sleep(2 ** attempt * 250);
    }
  }
  // Defensive — loop above always returns or throws.
  throw lastErr instanceof Error
    ? lastErr
    : new EmailNotConfiguredError("Graph token retry path exhausted");
}

export type GraphAppResponse<T> = {
  ok: boolean;
  status: number;
  data?: T;
  error?: { code: string; message: string };
  requestId?: string;
};

/**
 * Lightweight Graph fetch using application-permissions token.
 * Returns shape preserves both success body and error envelope so the
 * caller can audit-log either outcome without exception flow.
 */
export async function graphAppRequest<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<GraphAppResponse<T>> {
  let token: string;
  try {
    token = await getGraphAppToken();
  } catch (err) {
    if (err instanceof EmailNotConfiguredError) {
      return {
        ok: false,
        status: 503,
        error: { code: "ENTRA_NOT_CONFIGURED", message: err.message },
      };
    }
    throw err;
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(`https://graph.microsoft.com/v1.0${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err instanceof GraphTimeoutError) {
      logger.error("graph_app.timeout", {
        path,
        timeoutMs: err.timeoutMs,
      });
      return {
        ok: false,
        status: 0,
        error: { code: "TIMEOUT", message: err.message },
      };
    }
    logger.error("graph_app.network_error", {
      path,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      status: 0,
      error: {
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const requestId = res.headers.get("request-id") ?? res.headers.get("x-ms-ags-diagnostic") ?? undefined;

  if (res.status === 202 || res.status === 204) {
    return { ok: true, status: res.status, requestId };
  }

  const text = await res.text();

  if (!res.ok) {
    let parsed: { error?: { code?: string; message?: string } } = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      // body wasn't JSON
    }
    return {
      ok: false,
      status: res.status,
      error: {
        code: parsed.error?.code ?? `HTTP_${res.status}`,
        message: parsed.error?.message ?? text.slice(0, 500),
      },
      requestId,
    };
  }

  try {
    return {
      ok: true,
      status: res.status,
      data: JSON.parse(text) as T,
      requestId,
    };
  } catch {
    return { ok: true, status: res.status, requestId };
  }
}
