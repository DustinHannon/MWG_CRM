// batch lookups for owner emails and "By: Name" references
// inside parsed activities. Avoids N+1 round-trips during a 10k-row
// import by making at most two queries: one for emails, one for names.

import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";

function normaliseName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Resolve a set of email strings (case-insensitive) to user ids.
 * Returns a map keyed by lower-case email.
 */
export async function resolveOwnerEmails(
  emails: Iterable<string>,
): Promise<Map<string, string>> {
  const cleaned = Array.from(
    new Set(
      Array.from(emails)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0 && e.includes("@")),
    ),
  );
  const map = new Map<string, string>();
  if (cleaned.length === 0) return map;

  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(sql`lower(${users.email}) IN (${sql.join(
      cleaned.map((e) => sql`${e}`),
      sql`, `,
    )})`);
  for (const r of rows) map.set(r.email.toLowerCase(), r.id);
  return map;
}

/**
 * Resolve display-name strings ("Tanzania Griffith") to user ids.
 * Tries `display_name` first, then `first_name + ' ' + last_name`,
 * both case-insensitive after collapsing internal whitespace.
 */
export async function resolveByNames(
  names: Iterable<string>,
): Promise<Map<string, string>> {
  const cleaned = Array.from(
    new Set(
      Array.from(names)
        .map((n) => normaliseName(n))
        .filter((n) => n.length > 0),
    ),
  );
  const map = new Map<string, string>();
  if (cleaned.length === 0) return map;

  const rows = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(users);
  // Index by both display name and first+last on the user side, then
  // populate map for any input that matches.
  for (const u of rows) {
    const candidates: string[] = [];
    if (u.displayName) candidates.push(normaliseName(u.displayName));
    if (u.firstName && u.lastName) {
      candidates.push(normaliseName(`${u.firstName} ${u.lastName}`));
    }
    for (const c of candidates) {
      if (cleaned.includes(c) && !map.has(c)) {
        map.set(c, u.id);
      }
    }
  }
  return map;
}

export function lookupByName(
  rawName: string | undefined | null,
  map: Map<string, string>,
): string | null {
  if (!rawName) return null;
  return map.get(normaliseName(rawName)) ?? null;
}
