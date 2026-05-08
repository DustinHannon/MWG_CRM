import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { formatUserTime } from "@/lib/format-time";
import { listActivitiesForLead } from "@/lib/activities";
import { deleteActivityAction } from "./actions";
import type { SessionUser } from "@/lib/auth-helpers";
import { UserChip } from "@/components/user-display";

const KIND_LABEL: Record<string, string> = {
  note: "Note",
  call: "Call",
  task: "Task",
  email: "Email",
  meeting: "Meeting",
};

const KIND_PALETTE: Record<string, string> = {
  note: "border-border bg-muted/40 text-foreground/80",
  call: "border-cyan-500/30 dark:border-cyan-300/30 bg-cyan-500/20 dark:bg-cyan-500/15 dark:bg-cyan-500/10 text-cyan-700 dark:text-cyan-100",
  task: "border-emerald-500/30 dark:border-emerald-300/30 bg-emerald-500/20 dark:bg-emerald-500/15 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-100",
  email: "border-blue-500/30 dark:border-blue-300/30 bg-blue-500/20 dark:bg-blue-500/15 dark:bg-blue-500/10 text-blue-700 dark:text-blue-100",
  meeting: "border-violet-500/30 dark:border-violet-300/30 bg-violet-500/20 dark:bg-violet-500/15 dark:bg-violet-500/10 text-violet-700 dark:text-violet-100",
};

export async function ActivityFeed({
  leadId,
  user,
}: {
  leadId: string;
  user: SessionUser;
}) {
  const rows = await listActivitiesForLead(leadId);
  const prefs = await getCurrentUserTimePrefs();

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground/80">
        No activities yet. Add a note, call, email, or meeting above.
      </p>
    );
  }

  return (
    <ol className="space-y-4">
      {rows.map((r) => {
        const canDelete = user.isAdmin || r.userId === user.id;
        const tooltip = formatUserTime(r.occurredAt, prefs);
        const relative = formatUserTime(r.occurredAt, prefs, "relative");

        return (
          <li
            key={r.id}
            className="rounded-xl border border-border bg-muted/40 p-4 backdrop-blur-md"
          >
            <header className="flex items-start justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                    KIND_PALETTE[r.kind] ?? KIND_PALETTE.note
                  }`}
                >
                  {KIND_LABEL[r.kind] ?? r.kind}
                </span>
                {r.subject ? (
                  <p className="text-sm font-medium text-foreground">{r.subject}</p>
                ) : null}
              </div>
              <div className="text-right">
                <p
                  className="text-xs text-muted-foreground/80"
                  title={tooltip}
                  suppressHydrationWarning
                >
                  {relative}
                </p>
                {/* Phase 9C — author surface uses the canonical
                    UserChip. Hover card omitted because a noisy lead
                    can have many activities. */}
                {r.userId ? (
                  <div className="mt-0.5 flex justify-end">
                    <UserChip
                      user={{
                        id: r.userId,
                        displayName: r.userDisplayName,
                        photoUrl: null,
                      }}
                    />
                  </div>
                ) : null}
              </div>
            </header>

            {r.outcome ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Outcome: <span className="text-foreground/90">{r.outcome}</span>
                {r.durationMinutes
                  ? ` · ${r.durationMinutes} min`
                  : ""}
              </p>
            ) : null}

            {r.body ? (
              <p className="mt-3 whitespace-pre-wrap text-sm text-foreground/90">
                {r.body}
              </p>
            ) : null}

            {r.attachments.length > 0 ? (
              <ul className="mt-3 flex flex-wrap gap-2">
                {r.attachments.map((a) => (
                  <li key={a.id}>
                    <a
                      href={a.blobUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-foreground/80 hover:bg-muted"
                    >
                      📎 {a.filename}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}

            {canDelete ? (
              <form
                action={async (fd) => {
                  "use server";
                  await deleteActivityAction(fd);
                }}
                className="mt-3"
              >
                <input type="hidden" name="activityId" value={r.id} />
                <input type="hidden" name="leadId" value={leadId} />
                <button
                  type="submit"
                  className="text-[11px] text-muted-foreground/80 underline-offset-4 hover:text-foreground/80 hover:underline"
                >
                  Delete
                </button>
              </form>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
