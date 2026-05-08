import { desc } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTime } from "@/components/ui/user-time";
import {
  leadScoringRules,
  leadScoringSettings,
} from "@/db/schema/lead-scoring";
import { requireAdmin } from "@/lib/auth-helpers";
import { ScoringRulesTable } from "./_components/rules-table";
import { ThresholdSliders } from "./_components/threshold-sliders";
import { RecomputeButton } from "./_components/recompute-button";

export const dynamic = "force-dynamic";

/**
 * /admin/scoring — Phase 5B. Three sections:
 *
 *   1. Rules list — toggle active, edit, delete (with the predicate
 *      summary inline so admins don't have to open the modal to recall
 *      what each rule does).
 *   2. Threshold sliders — hot / warm / cool. CHECK constraint enforces
 *      hot > warm > cool server-side; the client also validates so the
 *      UX doesn't bounce.
 *   3. Recompute button — runs the same loop as the nightly cron, with
 *      a 10,000-lead safety cap.
 *
 * `/admin/scoring/help` documents the field + operator catalog and the
 * import-doesn't-count rule.
 */
export default async function AdminScoringPage() {
  await requireAdmin();

  const [rules, [settings]] = await Promise.all([
    db.select().from(leadScoringRules).orderBy(desc(leadScoringRules.updatedAt)),
    db.select().from(leadScoringSettings).limit(1),
  ]);

  const t = settings ?? {
    hotThreshold: 70,
    warmThreshold: 40,
    coolThreshold: 15,
    updatedAt: new Date(),
    version: 1,
  };

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Admin", href: "/admin" },
          { label: "Lead Scoring" },
        ]}
      />
      <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        Admin
      </p>
      <div className="mt-1 flex items-center justify-between">
        <h1 className="text-2xl font-semibold font-display">Lead scoring</h1>
        <Link
          href="/admin/scoring/help"
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Help / field catalog →
        </Link>
      </div>
      <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
        Rules sum to a per-lead score. The score maps to a band via the
        thresholds below. Imports never count as activity — see the help
        page for details.
      </p>

      <GlassCard className="mt-6 p-6">
        <h2 className="text-base font-semibold">Scoring rules</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Toggle <em>Active</em> to include / exclude a rule from the next
          recompute. Editing the predicate is via raw JSON for now — see
          the help page for shape.
        </p>
        <ScoringRulesTable
          rows={rules.map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            predicate: r.predicate as object,
            points: r.points,
            isActive: r.isActive,
            version: r.version,
          }))}
        />
      </GlassCard>

      <GlassCard className="mt-6 p-6">
        <h2 className="text-base font-semibold">Band thresholds</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Score ≥ Hot &rarr; <strong>hot</strong>; ≥ Warm &rarr;{" "}
          <strong>warm</strong>; ≥ Cool &rarr; <strong>cool</strong>;
          otherwise <strong>cold</strong>. Hot &gt; Warm &gt; Cool is
          enforced server-side.
        </p>
        <ThresholdSliders
          initial={{
            hot: t.hotThreshold,
            warm: t.warmThreshold,
            cool: t.coolThreshold,
          }}
        />
        <p className="mt-3 text-[10px] text-muted-foreground">
          Last changed: <UserTime value={t.updatedAt} />
        </p>
      </GlassCard>

      <GlassCard className="mt-6 p-6">
        <h2 className="text-base font-semibold">Recompute</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Re-scores every active lead with the current rules + thresholds.
          Capped at 10,000 leads — over that, wait for the nightly cron.
        </p>
        <div className="mt-4">
          <RecomputeButton />
        </div>
      </GlassCard>
    </div>
  );
}
