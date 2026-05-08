import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { users } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { GlassCard } from "@/components/ui/glass-card";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { PipelineBoard } from "./_components/board";

export const dynamic = "force-dynamic";

const PIPELINE_STATUSES = [
  "new",
  "contacted",
  "qualified",
  "unqualified",
  "lost",
] as const;

interface CardRow {
  id: string;
  status: string;
  version: number;
  firstName: string;
  lastName: string | null;
  companyName: string | null;
  rating: string;
  // Phase 9C — owner id surfaced for the UserAvatar chip on Kanban
  // cards (avatars only, no hover card; high-cardinality surface).
  ownerId: string | null;
  ownerName: string | null;
  estimatedValue: string | null;
  lastActivityAt: Date | null;
}

const CARDS_PER_COLUMN = 50;

export default async function PipelinePage() {
  const session = await requireSession();
  const perms = await getPermissions(session.id);
  const canViewAll = session.isAdmin || perms.canViewAllRecords;

  const ownerFilter = canViewAll
    ? undefined
    : eq(leads.ownerId, session.id);

  const rows: CardRow[] = await db
    .select({
      id: leads.id,
      status: sql<string>`${leads.status}::text`,
      // Phase 8D Wave 4 (FIX-003) — carry version into the board so DnD
      // can post it back; OCC enforces compare-and-set on commit.
      version: leads.version,
      firstName: leads.firstName,
      lastName: leads.lastName,
      companyName: leads.companyName,
      rating: sql<string>`${leads.rating}::text`,
      ownerId: leads.ownerId,
      ownerName: users.displayName,
      estimatedValue: leads.estimatedValue,
      lastActivityAt: leads.lastActivityAt,
    })
    .from(leads)
    .leftJoin(users, eq(users.id, leads.ownerId))
    .where(
      ownerFilter
        ? and(
            ownerFilter,
            sql`${leads.status} != 'converted'`,
            eq(leads.isDeleted, false),
          )
        : and(
            sql`${leads.status} != 'converted'`,
            eq(leads.isDeleted, false),
          ),
    )
    .orderBy(desc(leads.lastActivityAt));

  const grouped: Record<string, CardRow[]> = {};
  for (const status of PIPELINE_STATUSES) {
    grouped[status] = [];
  }
  for (const r of rows) {
    if (!grouped[r.status]) grouped[r.status] = [];
    if (grouped[r.status].length < CARDS_PER_COLUMN) {
      grouped[r.status].push(r);
    }
  }

  return (
    <div className="px-10 py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Leads", href: "/leads" },
          { label: "Pipeline" },
        ]}
      />
      <PageRealtime entities={["leads"]} />
      <PagePoll entities={["leads"]} />
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Pipeline
          </p>
          <h1 className="mt-1 text-2xl font-semibold font-display">Lead pipeline</h1>
        </div>
        <div className="flex gap-2 rounded-lg border border-glass-border bg-glass-1 p-1">
          <Link
            href="/leads"
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
        <PipelineBoard initialColumns={grouped} />
      </GlassCard>
    </div>
  );
}
