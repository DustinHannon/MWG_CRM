import Link from "next/link";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { GlassCard } from "@/components/ui/glass-card";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export default async function ScoringHelpPage() {
  await requireAdmin();
  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Admin", href: "/admin" },
          { label: "Lead Scoring", href: "/admin/scoring" },
          { label: "Help" },
        ]}
      />
      <Link
        href="/admin/scoring"
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        ← Back to scoring
      </Link>
      <h1 className="mt-3 text-2xl font-semibold font-display">
        Scoring rules — field & operator catalog
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Rules are JSON predicates. Each rule sums into a per-lead score.
        Bands are defined by the threshold sliders on the main page.
      </p>

      <GlassCard className="mt-6 p-6">
        <h2 className="text-base font-semibold">Predicate shape</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          A predicate has <code>all</code> (AND) and / or <code>any</code>{" "}
          (OR) arrays of clauses. Both arrays must match for the rule to
          apply. An empty predicate matches no leads.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-md bg-input/40 p-3 text-xs">{`{
  "all": [
    { "field": "industry",      "op": "eq",  "value": "Insurance" },
    { "field": "estimatedValue","op": "gte", "value": 50000 }
  ],
  "any": [
    { "field": "rating",        "op": "eq",  "value": "hot" },
    { "field": "last_activity_within_days", "op": "lte", "value": 14 }
  ]
}`}</pre>
      </GlassCard>

      <GlassCard className="mt-6 p-6">
        <h2 className="text-base font-semibold">Lead fields</h2>
        <ul className="mt-2 grid grid-cols-1 gap-1 text-xs text-muted-foreground md:grid-cols-2">
          <li><code>firstName, lastName, displayName</code> — strings</li>
          <li><code>email, phone, mobilePhone</code> — strings</li>
          <li><code>jobTitle, companyName, industry</code> — strings</li>
          <li><code>website, linkedinUrl</code> — strings</li>
          <li><code>city, state, country</code> — strings</li>
          <li><code>status</code> — new/contacted/qualified/unqualified/converted/lost</li>
          <li><code>rating</code> — hot/warm/cold</li>
          <li><code>source</code> — web/referral/event/cold_call/partner/marketing/import/other</li>
          <li><code>estimatedValue</code> — number (USD)</li>
          <li><code>estimatedCloseDate</code> — date string YYYY-MM-DD</li>
          <li><code>doNotContact, doNotEmail, doNotCall</code> — booleans</li>
          <li><code>tags</code> — array of strings</li>
          <li><code>ownerId, createdById</code> — UUIDs</li>
          <li><code>createdAt, updatedAt, lastActivityAt</code> — timestamps</li>
          <li><code>createdVia</code> — manual/imported/api</li>
        </ul>
      </GlassCard>

      <GlassCard className="mt-6 p-6">
        <h2 className="text-base font-semibold">Pseudo-fields</h2>
        <dl className="mt-2 space-y-2 text-xs text-muted-foreground">
          <div>
            <dt className="font-mono text-foreground">last_activity_within_days</dt>
            <dd>
              Days since the most recent counting activity (note, call,
              email, meeting, task). <strong>NULL</strong> when there are
              no counting activities — and <code>&lt;=</code> /{" "}
              <code>&gt;=</code> clauses against NULL evaluate to false.
              Imports and lead-create do <strong>not</strong> count.
            </dd>
          </div>
          <div>
            <dt className="font-mono text-foreground">activity_count</dt>
            <dd>Total count of counting activities for the lead.</dd>
          </div>
          <div>
            <dt className="font-mono text-foreground">has_no_activity</dt>
            <dd>
              True iff <code>activity_count === 0</code>. Use this for
              explicit &quot;never engaged&quot; rules — distinct from
              &quot;stale&quot;.
            </dd>
          </div>
        </dl>
      </GlassCard>

      <GlassCard className="mt-6 p-6">
        <h2 className="text-base font-semibold">Operators</h2>
        <ul className="mt-2 grid grid-cols-2 gap-1 text-xs text-muted-foreground md:grid-cols-3">
          <li><code>eq</code> — equal</li>
          <li><code>neq</code> — not equal</li>
          <li><code>lt, lte, gt, gte</code> — numeric comparisons</li>
          <li><code>in</code> — value in array</li>
          <li><code>not_in</code> — value not in array</li>
          <li><code>contains</code> — string contains (case-insensitive)</li>
          <li><code>is_null</code> — field is null</li>
          <li><code>is_not_null</code> — field is non-null</li>
        </ul>
      </GlassCard>

      <GlassCard className="mt-6 p-6">
        <h2 className="text-base font-semibold">Worked examples</h2>
        <div className="mt-3 space-y-4 text-xs">
          <div>
            <p className="text-foreground">High-value insurance lead (+25)</p>
            <pre className="mt-1 overflow-x-auto rounded-md bg-input/40 p-3">{`{
  "all": [
    { "field": "industry",       "op": "eq",  "value": "Insurance" },
    { "field": "estimatedValue", "op": "gte", "value": 50000 }
  ]
}`}</pre>
          </div>

          <div>
            <p className="text-foreground">Recent meeting in last 14 days (+15)</p>
            <pre className="mt-1 overflow-x-auto rounded-md bg-input/40 p-3">{`{
  "all": [
    { "field": "last_activity_within_days", "op": "lte", "value": 14 }
  ]
}`}</pre>
            <p className="mt-1 text-muted-foreground">
              Newly-imported leads have <code>last_activity_within_days = NULL</code>{" "}
              and won&apos;t match this rule until a real activity is logged.
            </p>
          </div>

          <div>
            <p className="text-foreground">Stale (no activity in 90+ days) (-10)</p>
            <pre className="mt-1 overflow-x-auto rounded-md bg-input/40 p-3">{`{
  "all": [
    { "field": "last_activity_within_days", "op": "gte", "value": 90 }
  ]
}`}</pre>
            <p className="mt-1 text-muted-foreground">
              This skips leads with NULL <code>last_activity_within_days</code>{" "}
              — those are &quot;never engaged,&quot; a different category.
              For &quot;never engaged,&quot; use <code>has_no_activity</code>.
            </p>
          </div>

          <div>
            <p className="text-foreground">Never engaged (-5)</p>
            <pre className="mt-1 overflow-x-auto rounded-md bg-input/40 p-3">{`{
  "all": [
    { "field": "has_no_activity", "op": "eq", "value": true }
  ]
}`}</pre>
          </div>
        </div>
      </GlassCard>
    </div>
  );
}
