import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { formatUserTime } from "@/lib/format-time";
import { listActivitiesForLead } from "@/lib/activities";
import type { SessionUser } from "@/lib/auth-helpers";
import { UserChip } from "@/components/user-display";
import { ActivityDeleteButton } from "./activity-delete-button";

const KIND_LABEL: Record<string, string> = {
  note: "Note",
  call: "Call",
  task: "Task",
  email: "Email",
  meeting: "Meeting",
};

const KIND_PALETTE: Record<string, string> = {
  note: "border-border bg-muted/40 text-foreground/80",
  call: "border-[var(--status-contacted-fg)]/30 bg-[var(--status-contacted-bg)] text-[var(--status-contacted-fg)]",
  task: "border-[var(--status-won-fg)]/30 bg-[var(--status-won-bg)] text-[var(--status-won-fg)]",
  email: "border-[var(--status-new-fg)]/30 bg-[var(--status-new-bg)] text-[var(--status-new-fg)]",
  meeting: "border-[var(--status-proposal-fg)]/30 bg-[var(--status-proposal-bg)] text-[var(--status-proposal-fg)]",
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
            className="group/activity relative rounded-xl border border-border bg-muted/40 p-4 backdrop-blur-md"
          >
            {canDelete ? (
              <div className="absolute right-2 top-2 opacity-100 md:opacity-0 md:group-hover/activity:opacity-100">
                <ActivityDeleteButton
                  activityId={r.id}
                  activityName={r.subject ?? `${r.kind} from ${formatUserTime(r.occurredAt, prefs, "date")}`}
                />
              </div>
            ) : null}
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
                {/* author surface uses the canonical
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

          </li>
        );
      })}
    </ol>
  );
}
