import "server-only";
import { fetchWithTimeout } from "@/lib/graph-fetch";

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
 * Minimal Microsoft Graph fetch wrapper. only uses it for `/me`
 * during user provisioning. wraps this further with token refresh
 * + delegated-token resolution.
 */
export async function graphFetchWithToken<T>(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetchWithTimeout(`https://graph.microsoft.com/v1.0${path}`, {
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

/**
 * extended /me fields used to populate the read-only Profile
 * section of /settings. NEVER consumed by lead-tracking surfaces.
 */
export interface GraphMeProfileExtended extends GraphMeProfile {
  jobTitle?: string | null;
  department?: string | null;
  officeLocation?: string | null;
  businessPhones?: string[] | null;
  mobilePhone?: string | null;
  country?: string | null;
}

/** /me/manager response shape (subset). */
export interface GraphManager {
  id: string;
  displayName?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
}
