import "server-only";
import { ConfidentialClientApplication } from "@azure/msal-node";
import { env, MWG_TENANT_ID } from "@/lib/env";
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

export async function getGraphAppToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }
  const client = getClient();
  const result = await client.acquireTokenByClientCredential({
    scopes: ["https://graph.microsoft.com/.default"],
  });
  if (!result?.accessToken) {
    throw new EmailNotConfiguredError(
      "Microsoft Graph token acquisition returned no access_token",
    );
  }
  cachedToken = {
    value: result.accessToken,
    expiresAt:
      result.expiresOn?.getTime() ?? Date.now() + 50 * 60 * 1000, // ~50min default
  };
  return cachedToken.value;
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
    res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
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
