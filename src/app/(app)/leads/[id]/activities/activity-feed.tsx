import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { formatUserTime } from "@/lib/format-time";
import { listActivitiesForLead } from "@/lib/activities";
import { deleteActivityAction } from "./actions";
import type { SessionUser } from "@/lib/auth-helpers";

const KIND_LABEL: Record<string, string> = {
  note: "Note",
  call: "Call",
  task: "Task",
  email: "Email",
  meeting: "Meeting",
};

const KIND_PALETTE: Record<string, string> = {
  note: "border-white/10 bg-white/5 text-white/70",
  call: "border-cyan-300/30 bg-cyan-500/10 text-cyan-100",
  task: "border-emerald-300/30 bg-emerald-500/10 text-emerald-100",
  email: "border-blue-300/30 bg-blue-500/10 text-blue-100",
  meeting: "border-violet-300/30 bg-violet-500/10 text-violet-100",
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
      <p className="text-sm text-white/40">
        No activity yet. Use the composer above to log a note, call, or
        task. Email and meeting activities arrive in Phase 7.
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
            className="rounded-xl border border-white/10 bg-white/5 p-4 backdrop-blur-md"
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
                  <p className="text-sm font-medium text-white">{r.subject}</p>
                ) : null}
              </div>
              <div className="text-right">
                <p
                  className="text-xs text-white/40"
                  title={tooltip}
                  suppressHydrationWarning
                >
                  {relative}
                </p>
                {r.userDisplayName ? (
                  <p className="text-xs text-white/40">{r.userDisplayName}</p>
                ) : null}
              </div>
            </header>

            {r.outcome ? (
              <p className="mt-2 text-xs text-white/50">
                Outcome: <span className="text-white/80">{r.outcome}</span>
                {r.durationMinutes
                  ? ` · ${r.durationMinutes} min`
                  : ""}
              </p>
            ) : null}

            {r.body ? (
              <p className="mt-3 whitespace-pre-wrap text-sm text-white/85">
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
                      className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-white/70 hover:bg-white/10"
                    >
                      📎 {a.filename}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}

            {canDelete ? (
              <form action={deleteActivityAction} className="mt-3">
                <input type="hidden" name="activityId" value={r.id} />
                <input type="hidden" name="leadId" value={leadId} />
                <button
                  type="submit"
                  className="text-[11px] text-white/40 underline-offset-4 hover:text-white/70 hover:underline"
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
