import "server-only";

export class GraphError extends Error {
  constructor(
    public status: number,
    public body: string,
    public path: string,
  ) {
    super(`Graph ${status} on ${path}: ${body.slice(0, 240)}`);
  }
}

/**
 * Minimal Microsoft Graph fetch wrapper. Phase 3 only uses it for `/me`
 * during user provisioning. Phase 7 wraps this further with token refresh
 * + delegated-token resolution.
 */
export async function graphFetchWithToken<T>(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new GraphError(res.status, body, path);
  }
  return res.json() as Promise<T>;
}

export interface GraphMeProfile {
  id: string;
  givenName?: string | null;
  surname?: string | null;
  displayName?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
}
