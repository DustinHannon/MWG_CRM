import "server-only";

/**
 * Default timeout for Microsoft Graph and Entra (login.microsoftonline.com)
 * fetches. Microsoft typically responds in ≤3s; 30s is generous and only
 * fires on real stalls. Cron jobs (maxDuration=300s) retain ample budget
 * after a clean timeout to log + exit.
 */
export const GRAPH_FETCH_TIMEOUT_MS = 30_000;

/**
 * Thrown when a Microsoft endpoint takes longer than the configured timeout.
 * Distinct from `ReauthRequiredError` (which signals the user needs to
 * reconnect) and `GraphRequestError` / `GraphError` (which signal the API
 * returned a non-2xx). A timeout is a network-level fault and must not be
 * misclassified as either.
 */
export class GraphTimeoutError extends Error {
  constructor(
    public path: string,
    public timeoutMs: number,
  ) {
    super(`Graph request timed out after ${timeoutMs}ms: ${path}`);
    this.name = "GraphTimeoutError";
  }
}

/**
 * `fetch` with an `AbortController`-bounded timeout. On timeout throws
 * `GraphTimeoutError`; non-timeout errors propagate unchanged. The caller
 * keeps full control over the response handling.
 */
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = GRAPH_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      let path = url;
      try {
        path = new URL(url).pathname;
      } catch {
        // Keep the full URL if parsing fails.
      }
      throw new GraphTimeoutError(path, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
