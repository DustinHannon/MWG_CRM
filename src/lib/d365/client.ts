import "server-only";
import { ConfidentialClientApplication } from "@azure/msal-node";
import { logger } from "@/lib/logger";
import { getD365Env, type D365Env } from "./env";
import { D365HttpError, withD365Retry } from "./with-retry";

/**
 * Dynamics 365 OData client.
 *
 * MSAL client-credentials auth with token caching (60s buffer before
 * expiry). All HTTP calls flow through `withD365Retry` for 429/5xx
 * resilience.
 *
 * Used exclusively from server-side code (route handlers, server
 * actions, cron). Never instantiated client-side. Credentials never
 * leave the server.
 *
 * Pattern mirrors `src/lib/email/graph-app-token.ts` (
 * Microsoft Graph) but targets the Dynamics CRM resource and uses a
 * separate Entra app (Q-01 — `MWG-D365-Reader-MWGCRM`) with a
 * read-only D365 Security Role.
 */

interface CachedToken {
  value: string;
  expiresAt: number;
}

export interface D365ODataPage<T> {
  value: T[];
  nextLink?: string;
  count?: number;
}

export interface FetchPageOptions {
  select?: string[];
  filter?: string;
  expand?: string;
  top?: number;
  orderby?: string;
  count?: boolean;
  pageSize?: number;
  /** When true, also include OData annotations (e.g. formatted values). */
  includeAnnotations?: boolean;
  /** Optional AbortSignal to cancel in-flight requests. */
  signal?: AbortSignal;
}

export class D365Client {
  private readonly env: D365Env;
  private readonly cca: ConfidentialClientApplication;
  private cachedToken: CachedToken | null = null;
  private inflightAcquire: Promise<string> | null = null;

  constructor(env?: D365Env) {
    this.env = env ?? getD365Env();
    this.cca = new ConfidentialClientApplication({
      auth: {
        clientId: this.env.clientId,
        clientSecret: this.env.clientSecret,
        authority: `https://login.microsoftonline.com/${this.env.tenantId}`,
      },
    });
  }

  /**
   * Returns a cached token, refreshing if within 60s of expiry.
   * Concurrent callers share a single in-flight acquisition.
   */
  async getToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) {
      return this.cachedToken.value;
    }
    if (this.inflightAcquire) return this.inflightAcquire;

    this.inflightAcquire = this.acquireFreshToken().finally(() => {
      this.inflightAcquire = null;
    });
    return this.inflightAcquire;
  }

  /** Force-clear the token cache (e.g. on 401 from a prior call). */
  invalidateToken(): void {
    this.cachedToken = null;
  }

  private async acquireFreshToken(): Promise<string> {
    const result = await this.cca.acquireTokenByClientCredential({
      scopes: [`${this.env.baseUrl}/.default`],
    });
    if (!result?.accessToken) {
      // invariant: MSAL's acquireTokenByClientCredential resolves
      // with an accessToken or rejects. A nullish accessToken with
      // a resolved result is a library-contract violation, not a
      // domain error — bubble as a bare Error per CLAUDE.md.
      throw new Error("D365 token acquisition returned no access_token");
    }
    this.cachedToken = {
      value: result.accessToken,
      expiresAt: result.expiresOn?.getTime() ?? Date.now() + 50 * 60 * 1000,
    };
    logger.info("d365.token.acquired", {
      expiresAt: new Date(this.cachedToken.expiresAt).toISOString(),
    });
    return this.cachedToken.value;
  }

  /**
   * Fetch one page of an OData entity set with retry + 401 refresh.
   * Returns the raw OData envelope (`value`, `@odata.nextLink`, `@odata.count`).
   */
  async fetchPage<T>(
    path: string,
    opts: FetchPageOptions = {},
  ): Promise<D365ODataPage<T>> {
    const url = this.buildUrl(path, opts);
    return this.execWithAuth<D365ODataPage<T>>(url, opts);
  }

  /**
   * Follow an `@odata.nextLink` to the next page. The link is
   * server-generated and absolute — no further mutation of params.
   */
  async followNextLink<T>(
    nextLink: string,
    signal?: AbortSignal,
  ): Promise<D365ODataPage<T>> {
    return this.execWithAuth<D365ODataPage<T>>(nextLink, {
      includeAnnotations: false,
      signal,
    });
  }

  /**
   * Fetch attribute metadata for an entity (used by §2.5 schema
   * discovery and Sub-agent B's mapping registry validation).
   */
  async fetchEntityDefinitions(entityName: string, signal?: AbortSignal) {
    const path = `EntityDefinitions(LogicalName='${entityName}')/Attributes?$select=LogicalName,AttributeType,IsCustomAttribute,DisplayName`;
    return this.fetchPage<{
      LogicalName: string;
      AttributeType: string;
      IsCustomAttribute: boolean;
      DisplayName: { UserLocalizedLabel?: { Label?: string } };
    }>(path, { signal });
  }

  private buildUrl(path: string, opts: FetchPageOptions): string {
    const base = `${this.env.baseUrl}/api/data/v${this.env.apiVersion}/`;
    const url = new URL(path.replace(/^\//, ""), base);
    if (opts.select?.length) {
      url.searchParams.set("$select", opts.select.join(","));
    }
    if (opts.filter) url.searchParams.set("$filter", opts.filter);
    if (opts.expand) url.searchParams.set("$expand", opts.expand);
    if (opts.top != null) url.searchParams.set("$top", String(opts.top));
    if (opts.orderby) url.searchParams.set("$orderby", opts.orderby);
    if (opts.count) url.searchParams.set("$count", "true");
    return url.toString();
  }

  private async execWithAuth<T>(
    url: string,
    opts: FetchPageOptions,
  ): Promise<T> {
    return withD365Retry(async () => {
      const headers = await this.buildHeaders(opts);
      let res: Response;
      try {
        res = await fetch(url, { method: "GET", headers, signal: opts.signal });
      } catch (err) {
        // Network / abort / DNS — let withRetry decide whether to back off.
        throw err instanceof Error
          ? err
          : new Error(`D365 fetch failed: ${String(err)}`);
      }

      if (res.status === 401) {
        // Token may have been invalidated server-side; clear and let
        // the next withRetry attempt acquire a fresh one.
        this.invalidateToken();
        const body = await safeReadBody(res);
        throw new D365HttpError(401, "D365 unauthorized", {
          responseBody: body,
        });
      }

      if (!res.ok) {
        const body = await safeReadBody(res);
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        throw new D365HttpError(
          res.status,
          `D365 HTTP ${res.status}: ${body.slice(0, 300)}`,
          { retryAfterSeconds: retryAfter, responseBody: body },
        );
      }

      const json = (await res.json()) as Record<string, unknown> & {
        value?: unknown;
        "@odata.nextLink"?: string;
        "@odata.count"?: number;
      };
      // Normalize OData envelope into our typed shape.
      return {
        value: (json.value ?? []) as unknown,
        nextLink: json["@odata.nextLink"],
        count: json["@odata.count"],
      } as T;
    });
  }

  private async buildHeaders(opts: FetchPageOptions): Promise<HeadersInit> {
    const token = await this.getToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
    };
    const preferParts: string[] = [];
    if (opts.pageSize) {
      preferParts.push(`odata.maxpagesize=${opts.pageSize}`);
    }
    if (opts.includeAnnotations) {
      preferParts.push('odata.include-annotations="*"');
    }
    if (preferParts.length) headers.Prefer = preferParts.join(",");
    return headers;
  }
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  if (Number.isFinite(n) && n > 0) return n;
  // HTTP-date form — convert to seconds-from-now.
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  const seconds = Math.ceil((date - Date.now()) / 1000);
  return seconds > 0 ? seconds : undefined;
}

/**
 * Module-singleton accessor. Lazy-instantiated; safe to call from
 * any server-side path. Throws via `getD365Env()` if envs missing.
 */
let singleton: D365Client | null = null;
export function getD365Client(): D365Client {
  if (!singleton) singleton = new D365Client();
  return singleton;
}
