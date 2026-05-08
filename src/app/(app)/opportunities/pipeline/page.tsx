import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { crmAccounts, opportunities } from "@/db/schema/crm-records";
import { users } from "@/db/schema/users";
import { GlassCard } from "@/components/ui/glass-card";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { OppPipelineBoard } from "./_components/board";

export const dynamic = "force-dynamic";

const STAGES = [
  "prospecting",
  "qualification",
  "proposal",
  "negotiation",
  "closed_won",
  "closed_lost",
] as const;

interface CardRow {
  id: string;
  stage: string;
  // Phase 8D Wave 4 (FIX-004) — OCC version stamp threaded through DnD.
  version: number;
  name: string;
  accountName: string | null;
  amount: string | null;
  // Phase 9C — owner id powers the canonical xs avatar on the card.
  ownerId: string | null;
  ownerName: string | null;
}

export default async function OppPipelinePage() {
  const session = await requireSession();
  const perms = await getPermissions(session.id);
  const canViewAll = session.isAdmin || perms.canViewAllRecords;

  const ownerWhere = canViewAll
    ? undefined
    : eq(opportunities.ownerId, session.id);
  const archivedWhere = eq(opportunities.isDeleted, false);
  const where = ownerWhere
    ? and(ownerWhere, archivedWhere)
    : archivedWhere;

  const rows: CardRow[] = await db
    .select({
      id: opportunities.id,
      stage: sql<string>`${opportunities.stage}::text`,
      // Phase 8D Wave 4 (FIX-004) — version on every card; the DnD
      // handler posts it back so the action can refuse stale moves.
      version: opportunities.version,
      name: opportunities.name,
      accountName: crmAccounts.name,
      amount: opportunities.amount,
      ownerId: opportunities.ownerId,
      ownerName: users.displayName,
    })
    .from(opportunities)
    .leftJoin(crmAccounts, eq(crmAccounts.id, opportunities.accountId))
    .leftJoin(users, eq(users.id, opportunities.ownerId))
    .where(where)
    .orderBy(desc(opportunities.updatedAt));

  const grouped: Record<string, CardRow[]> = {};
  for (const s of STAGES) grouped[s] = [];
  for (const r of rows) {
    if (!grouped[r.stage]) grouped[r.stage] = [];
    grouped[r.stage].push(r);
  }

  return (
    <div className="px-10 py-10">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Pipeline
          </p>
          <h1 className="mt-1 text-2xl font-semibold font-display">
            Opportunity pipeline
          </h1>
        </div>
        <div className="flex gap-1 rounded-lg border border-glass-border bg-glass-1 p-1">
          <Link
            href="/opportunities"
            className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Table
          </Link>
          <span className="rounded bg-primary/20 px-3 py-1.5 text-xs font-medium text-foreground">
            Pipeline
          </span>
        </div>
      </div>

      <GlassCard className="mt-6 p-3">
        <OppPipelineBoard initialColumns={grouped} />
      </GlassCard>
    </div>
  );
}
