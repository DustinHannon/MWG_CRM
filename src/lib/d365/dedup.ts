import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { externalIds } from "@/db/schema/d365-imports";
import { leads } from "@/db/schema/leads";
import type { NewAccount } from "./mapping/account";
import type { NewContact } from "./mapping/contact";
import type { NewLead } from "./mapping/lead";
import type { NewOpportunity } from "./mapping/opportunity";

/**
 * Dedup helpers.
 *
 * Q-03 default conflict resolution is `dedup_merge`: mwg-crm wins
 * where conflicting; D365 fills in nulls. The reviewer can override
 * per record from the admin UI.
 *
 * Dedup precedence (every entity):
 * 1. external_ids row matching (source='d365', sourceEntityType, sourceId).
 * → re-import is idempotent; same record always lands on the same
 * local row.
 * 2. Entity-specific natural-key fallback (email, name+domain, etc.).
 * Only applied when no external_ids row exists.
 *
 * Leaving (1) but no (2) match means the record is a brand-new import.
 *
 * Activities (note/task/call/appointment/email) dedup ONLY by
 * external_id; their natural-key shape is too noisy for safe
 * auto-merge. Re-imports stay idempotent via external_ids; new
 * activities always land as new rows.
 */

const D365_SOURCE = "d365";

export type ConflictResolution =
  | "none"
  | "dedup_skip"
  | "dedup_merge"
  | "dedup_overwrite"
  | "manual_resolved";

export interface DedupResult {
  /** Local UUID this D365 record duplicates, or null when unique. */
  conflictWith: string | null;
  /** Default conflict resolution (Q-03). */
  conflictResolution: ConflictResolution;
  /** Discriminator on which path matched, for audit / debug. */
  matchedBy: "external_id" | "email" | "name+domain" | null;
}

/* -------------------------------------------------------------------------- *
 * external_ids match *
 * -------------------------------------------------------------------------- */

async function findByExternalId(
  sourceEntityType: string,
  sourceId: string,
): Promise<string | null> {
  const rows = await db
    .select({ localId: externalIds.localId })
    .from(externalIds)
    .where(
      and(
        eq(externalIds.source, D365_SOURCE),
        eq(externalIds.sourceEntityType, sourceEntityType),
        eq(externalIds.sourceId, sourceId),
      ),
    )
    .limit(1);
  return rows[0]?.localId ?? null;
}

/* -------------------------------------------------------------------------- *
 * Lead *
 * -------------------------------------------------------------------------- */

export async function dedupLead(
  mapped: NewLead,
  externalId: string,
): Promise<DedupResult> {
  const byExt = await findByExternalId("lead", externalId);
  if (byExt) {
    return {
      conflictWith: byExt,
      conflictResolution: "dedup_merge",
      matchedBy: "external_id",
    };
  }

  const email = mapped.email?.trim().toLowerCase();
  if (email) {
    const rows = await db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.isDeleted, false),
          sql`lower(${leads.email}) = ${email}`,
        ),
      )
      .limit(1);
    if (rows[0]) {
      return {
        conflictWith: rows[0].id,
        conflictResolution: "dedup_merge",
        matchedBy: "email",
      };
    }
  }

  return { conflictWith: null, conflictResolution: "none", matchedBy: null };
}

/* -------------------------------------------------------------------------- *
 * Contact *
 * -------------------------------------------------------------------------- */

export async function dedupContact(
  mapped: NewContact,
  externalId: string,
): Promise<DedupResult> {
  const byExt = await findByExternalId("contact", externalId);
  if (byExt) {
    return {
      conflictWith: byExt,
      conflictResolution: "dedup_merge",
      matchedBy: "external_id",
    };
  }

  const email = mapped.email?.trim().toLowerCase();
  if (email) {
    const rows = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.isDeleted, false),
          sql`lower(${contacts.email}) = ${email}`,
        ),
      )
      .limit(1);
    if (rows[0]) {
      return {
        conflictWith: rows[0].id,
        conflictResolution: "dedup_merge",
        matchedBy: "email",
      };
    }
  }

  return { conflictWith: null, conflictResolution: "none", matchedBy: null };
}

/* -------------------------------------------------------------------------- *
 * Account *
 * -------------------------------------------------------------------------- */

/**
 * Extract a website's host (lowercased, no `www.`) for domain match.
 * Returns null when website is missing or unparseable.
 */
function websiteDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  try {
    const url = new URL(v.includes("://") ? v : `https://${v}`);
    let host = url.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return host || null;
  } catch {
    return null;
  }
}

export async function dedupAccount(
  mapped: NewAccount,
  externalId: string,
): Promise<DedupResult> {
  const byExt = await findByExternalId("account", externalId);
  if (byExt) {
    return {
      conflictWith: byExt,
      conflictResolution: "dedup_merge",
      matchedBy: "external_id",
    };
  }

  const name = mapped.name?.trim().toLowerCase();
  const domain = websiteDomain(mapped.website);
  if (!name) {
    return { conflictWith: null, conflictResolution: "none", matchedBy: null };
  }

  // Match on lower(name) AND a non-empty website with the same host.
  // Without a website we don't auto-merge — name alone is too noisy.
  if (!domain) {
    return { conflictWith: null, conflictResolution: "none", matchedBy: null };
  }

  const rows = await db
    .select({ id: crmAccounts.id, website: crmAccounts.website })
    .from(crmAccounts)
    .where(
      and(
        eq(crmAccounts.isDeleted, false),
        sql`lower(${crmAccounts.name}) = ${name}`,
      ),
    )
    .limit(20);

  for (const row of rows) {
    if (websiteDomain(row.website) === domain) {
      return {
        conflictWith: row.id,
        conflictResolution: "dedup_merge",
        matchedBy: "name+domain",
      };
    }
  }

  return { conflictWith: null, conflictResolution: "none", matchedBy: null };
}

/* -------------------------------------------------------------------------- *
 * Opportunity *
 * -------------------------------------------------------------------------- */

export async function dedupOpportunity(
  _mapped: NewOpportunity,
  externalId: string,
): Promise<DedupResult> {
  const byExt = await findByExternalId("opportunity", externalId);
  if (byExt) {
    return {
      conflictWith: byExt,
      conflictResolution: "dedup_merge",
      matchedBy: "external_id",
    };
  }
  return { conflictWith: null, conflictResolution: "none", matchedBy: null };
}

/* -------------------------------------------------------------------------- *
 * Activities *
 * -------------------------------------------------------------------------- */

/**
 * Activities (annotation, task, phonecall, appointment, email) dedup
 * by external_id only — the parent's natural keys keep new
 * activities from being mistakenly merged into existing ones.
 */
export async function dedupActivity(
  sourceEntityType: string,
  externalId: string,
): Promise<DedupResult> {
  const byExt = await findByExternalId(sourceEntityType, externalId);
  if (byExt) {
    return {
      conflictWith: byExt,
      conflictResolution: "dedup_merge",
      matchedBy: "external_id",
    };
  }
  return { conflictWith: null, conflictResolution: "none", matchedBy: null };
}
