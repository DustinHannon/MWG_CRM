import "server-only";
import { graphAppRequest, type GraphAppResponse } from "@/lib/email/graph-app-token";
import { logger } from "@/lib/logger";
import type { GraphDirectoryUser } from "@/lib/entra-provisioning";

export interface DirectoryClassification {
  /** true → checkbox checked by default in the wizard. */
  recommended: boolean;
  /** human-readable reasons it was auto-deselected (empty when recommended). */
  reasons: string[];
}

const SERVICE_NAME_PATTERNS = [
  /\bsvc\b/i, /\bservice\b/i, /\bservice account\b/i, /\badmin\b/i,
  /\bsystem\b/i, /\bno[\s_-]?reply\b/i, /\bdonotreply\b/i, /\btest\b/i,
  /\bdemo\b/i, /\bshared\b/i, /\bmailbox\b/i, /\bsupport\b/i, /\binfo\b/i,
];

const RESOURCE_NAME_PATTERNS = [
  /\broom\b/i, /\bconference\b/i, /\bconf[\s_-]?room\b/i, /\bequipment\b/i,
  /\bprojector\b/i, /\bboard ?room\b/i, /\bhuddle\b/i, /\bdesk\b/i, /\bkiosk\b/i,
];

const SERVICE_LOCALPART =
  /^(svc|service|admin|no-?reply|donotreply|test|demo|shared|mailbox|support|info|sa|sql|backup|sync|automation|robot|bot)[-_.]?/i;

/**
 * Pure heuristic: should this directory user be checked-for-import by
 * default? Never authoritative — the admin overrides any row in the
 * wizard. There is no single Graph flag for "is a real person", so this
 * is signal-based and intentionally conservative (a false negative is
 * cheap: the admin just re-checks the box).
 */
export function classifyDirectoryUser(
  u: GraphDirectoryUser,
  allowedDomains: readonly string[],
): DirectoryClassification {
  const reasons: string[] = [];
  const upn = (u.userPrincipalName ?? u.mail ?? "").toLowerCase();
  const localPart = upn.split("@")[0] ?? "";
  const domain = upn.split("@")[1] ?? "";
  const name = (u.displayName ?? "").trim();
  const haystack = `${name} ${upn}`;

  if (u.accountEnabled === false) reasons.push("Account disabled in Entra");
  if ((u.userType ?? "Member").toLowerCase() === "guest")
    reasons.push("Guest / external account");
  if (!u.mail || u.mail.trim().length === 0)
    reasons.push("No mailbox / mail address");
  if (allowedDomains.length > 0 && domain.length > 0 && !allowedDomains.includes(domain))
    reasons.push(`Email domain outside allowed domains (${domain})`);
  if (!u.assignedLicenses || u.assignedLicenses.length === 0)
    reasons.push("No assigned license");
  if (SERVICE_LOCALPART.test(localPart) || SERVICE_NAME_PATTERNS.some((re) => re.test(haystack)))
    reasons.push("Looks like a service/system account");
  if (RESOURCE_NAME_PATTERNS.some((re) => re.test(haystack)))
    reasons.push("Looks like a room/equipment resource mailbox");
  if (name.length === 0) reasons.push("No display name");

  return { recommended: reasons.length === 0, reasons };
}

const DIR_SELECT =
  "id,displayName,givenName,surname,mail,userPrincipalName,jobTitle,department,officeLocation,country,mobilePhone,businessPhones,accountEnabled,userType,assignedLicenses";

const MAX_PAGES = 60; // 60 * 999 ≈ 60k users — defensive upper bound.

interface GraphUsersPage {
  value: GraphDirectoryUser[];
  "@odata.nextLink"?: string;
}

export interface DirectoryFetchResult {
  ok: boolean;
  users: GraphDirectoryUser[];
  /** set when the app token lacks User.Read.All / Directory.Read.All, or not configured. */
  permissionError?: string;
}

/**
 * Enumerate the Entra directory via the existing app-permission Graph
 * client. Requires `User.Read.All` (or `Directory.Read.All`) Application
 * permission admin-consented on the Entra app — a 403 surfaces a clear
 * actionable message rather than throwing. Paginates @odata.nextLink.
 */
export async function fetchEntraDirectoryUsers(): Promise<DirectoryFetchResult> {
  const all: GraphDirectoryUser[] = [];
  let path: string | null = `/users?$select=${DIR_SELECT}&$top=999`;
  let page = 0;

  while (path && page < MAX_PAGES) {
    const res: GraphAppResponse<GraphUsersPage> =
      await graphAppRequest<GraphUsersPage>("GET", path);
    if (!res.ok) {
      if (res.status === 403 || res.error?.code === "Authorization_RequestDenied") {
        logger.error("entra.directory.permission_denied", {
          status: res.status, code: res.error?.code,
        });
        return {
          ok: false, users: [],
          permissionError:
            "The Entra app is missing the User.Read.All (or Directory.Read.All) Application permission. An admin must grant and admin-consent it on the app registration before directory sync can run.",
        };
      }
      if (res.status === 503 && res.error?.code === "ENTRA_NOT_CONFIGURED") {
        return {
          ok: false, users: [],
          permissionError: "Microsoft Entra app credentials are not configured for this environment.",
        };
      }
      logger.error("entra.directory.fetch_failed", {
        status: res.status, code: res.error?.code,
      });
      return {
        ok: false, users: [],
        permissionError: `Directory fetch failed (${res.status}). ${res.error?.message ?? ""}`.trim(),
      };
    }
    const body = res.data;
    if (body?.value?.length) all.push(...body.value);
    const next = body?.["@odata.nextLink"];
    // nextLink is an absolute URL; graphAppRequest prepends the v1.0
    // base, so strip the origin+version prefix back to a relative path.
    path = next ? next.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, "") : null;
    page += 1;
  }

  return { ok: true, users: all };
}
