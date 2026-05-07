import { NextResponse } from "next/server";
import { ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { leads } from "@/db/schema/leads";
import { tags } from "@/db/schema/tags";
import { tasks } from "@/db/schema/tasks";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { logger } from "@/lib/logger";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SearchHit {
  type: "lead" | "contact" | "account" | "opportunity" | "task" | "tag";
  id: string;
  label: string;
  sublabel: string | null;
  link: string;
}

/**
 * Phase 3I — Cmd+K cross-entity search. Returns up to 10 hits per type,
 * grouped client-side. Owner-scope respected for non-admins without
 * canViewAllRecords.
 */
export async function GET(req: Request) {
  const session = await requireSession();
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (q.length === 0) return NextResponse.json({ hits: [] });

  const perms = await getPermissions(session.id);
  const canViewAll = session.isAdmin || perms.canViewAllRecords;
  const pattern = `%${q}%`;
  const hits: SearchHit[] = [];

  try {
    // Leads.
    const leadRows = await db
      .select({
        id: leads.id,
        firstName: leads.firstName,
        lastName: leads.lastName,
        company: leads.companyName,
        email: leads.email,
        ownerId: leads.ownerId,
      })
      .from(leads)
      .where(
        or(
          ilike(leads.firstName, pattern),
          ilike(leads.lastName, pattern),
          ilike(leads.companyName, pattern),
          ilike(leads.email, pattern),
          ilike(leads.phone, pattern),
        ),
      )
      .limit(10);
    for (const r of leadRows) {
      if (!canViewAll && r.ownerId !== session.id) continue;
      hits.push({
        type: "lead",
        id: r.id,
        label: `${r.firstName} ${r.lastName}`,
        sublabel: r.company ?? r.email ?? null,
        link: `/leads/${r.id}`,
      });
    }

    // Contacts.
    const contactRows = await db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        ownerId: contacts.ownerId,
      })
      .from(contacts)
      .where(
        or(
          ilike(contacts.firstName, pattern),
          ilike(contacts.lastName, pattern),
          ilike(contacts.email, pattern),
        ),
      )
      .limit(10);
    for (const r of contactRows) {
      if (!canViewAll && r.ownerId !== session.id) continue;
      hits.push({
        type: "contact",
        id: r.id,
        label: `${r.firstName} ${r.lastName}`,
        sublabel: r.email ?? null,
        link: `/contacts/${r.id}`,
      });
    }

    // Accounts.
    const accountRows = await db
      .select({
        id: crmAccounts.id,
        name: crmAccounts.name,
        industry: crmAccounts.industry,
        ownerId: crmAccounts.ownerId,
      })
      .from(crmAccounts)
      .where(ilike(crmAccounts.name, pattern))
      .limit(10);
    for (const r of accountRows) {
      if (!canViewAll && r.ownerId !== session.id) continue;
      hits.push({
        type: "account",
        id: r.id,
        label: r.name,
        sublabel: r.industry,
        link: `/accounts/${r.id}`,
      });
    }

    // Opportunities.
    const oppRows = await db
      .select({
        id: opportunities.id,
        name: opportunities.name,
        stage: sql<string>`${opportunities.stage}::text`,
        ownerId: opportunities.ownerId,
      })
      .from(opportunities)
      .where(ilike(opportunities.name, pattern))
      .limit(10);
    for (const r of oppRows) {
      if (!canViewAll && r.ownerId !== session.id) continue;
      hits.push({
        type: "opportunity",
        id: r.id,
        label: r.name,
        sublabel: r.stage,
        link: `/opportunities/${r.id}`,
      });
    }

    // Tasks (assigned to me only).
    const taskRows = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: sql<string>`${tasks.status}::text`,
      })
      .from(tasks)
      .where(
        sql`${ilike(tasks.title, pattern)} AND ${eq(tasks.assignedToId, session.id)}`,
      )
      .limit(10);
    for (const r of taskRows) {
      hits.push({
        type: "task",
        id: r.id,
        label: r.title,
        sublabel: r.status,
        link: "/tasks",
      });
    }

    // Tags.
    const tagRows = await db
      .select({ id: tags.id, name: tags.name, color: tags.color })
      .from(tags)
      .where(ilike(tags.name, pattern))
      .limit(5);
    for (const r of tagRows) {
      hits.push({
        type: "tag",
        id: r.id,
        label: r.name,
        sublabel: r.color,
        link: `/leads?tag=${encodeURIComponent(r.name)}`,
      });
    }
  } catch (err) {
    logger.error("search.failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }

  return NextResponse.json({ hits });
}
