"use client";

import { useActionState, useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import {
  StandardFormField,
  StandardFormTextarea,
  useEditFormResult,
} from "@/components/standard";
import { OccConflictDialog } from "@/components/standard/occ-conflict-dialog";
import type { OccConflictField } from "@/components/standard/occ-conflict-dialog";
import type { ActionFailure, ActionResult } from "@/lib/server-action";
import {
  getActivityForConflictAction,
  updateActivityAction,
} from "./actions";

/**
 * Inline-edit trigger + form for a note/call timeline entry. Mirrors
 * the hover-revealed placement of ActivityDeleteButton. Edits a note
 * (body only) or a call (subject/body/outcome/duration/occurred-at)
 * with full OCC: the row's `version` is submitted as a hidden field;
 * a lost version race comes back as a ConflictError envelope which
 * opens the canonical OccConflictDialog (refresh = take server's,
 * overwrite = force-apply against the server's bumped version).
 *
 * Only rendered by ActivityFeed for kind in ('note','call') rows that
 * are not Graph-synced / D365-imported — the same gate the server
 * action enforces (client hides what the server also rejects).
 */
type CallFields = {
  subject: string | null;
  outcome: string | null;
  durationMinutes: number | null;
  occurredAt: string;
};

// Activity timestamp -> yyyy-MM-dd in the viewer's local zone for the
// date input (and for diffing draft vs server in the conflict table).
function toLocalDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
}

export function ActivityEditButton({
  activityId,
  kind,
  version,
  subject,
  body,
  call,
}: {
  activityId: string;
  kind: "note" | "call";
  version: number;
  subject: string | null;
  body: string | null;
  call: CallFields | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const initial: ActionResult<never> = { ok: true };
  const [state, formAction, pending] = useActionState<
    ActionResult<never>,
    FormData
  >(async (_prev, fd) => updateActivityAction(fd), initial);

  // Conflict-dialog state, populated when a save loses the version race.
  const [conflict, setConflict] = useState<{
    fields: OccConflictField[];
    serverVersion: number;
  } | null>(null);
  // The draft the user tried to save, captured at submit so Overwrite
  // can replay it against the server's bumped version.
  const draftRef = useRef<FormData | null>(null);

  const onSuccess = useCallback(() => {
    setOpen(false);
    setConflict(null);
    router.refresh();
  }, [router]);

  const onFailure = useCallback(
    (failure: ActionFailure) => {
      if (failure.code !== "CONFLICT") return false;
      // Load the server's current state to build the side-by-side diff.
      // Runs in this callback (not synchronously in an effect body), so
      // the setState here is react-hooks/set-state-in-effect compliant.
      void (async () => {
        const res = await getActivityForConflictAction({ activityId });
        if (!res.ok) {
          toast.error(res.error, { duration: Infinity, dismissible: true });
          return;
        }
        const srv = res.data;
        const draft = draftRef.current;
        const get = (k: string) =>
          draft ? ((draft.get(k) as string | null) ?? "") : "";
        const fields: OccConflictField[] = [];
        const push = (
          label: string,
          draftValue: string | number | null,
          serverValue: string | number | null,
        ) => {
          if (String(draftValue ?? "") !== String(serverValue ?? "")) {
            fields.push({ label, draftValue, serverValue });
          }
        };
        if (kind === "note") {
          push("Note", get("body"), srv.body);
        } else {
          push("Subject", get("subject"), srv.subject);
          push("Notes", get("body"), srv.body);
          push("Outcome", get("outcome"), srv.outcome);
          push("Duration (min)", get("durationMinutes"), srv.durationMinutes);
          push("Occurred", get("occurredAt"), toLocalDate(srv.occurredAt));
        }
        setConflict({ fields, serverVersion: srv.version });
      })();
      return true;
    },
    [activityId, kind],
  );

  useEditFormResult(state, onSuccess, "Activity updated", onFailure);

  const handleSubmit = (fd: FormData) => {
    // Snapshot the submitted draft so an Overwrite can replay it.
    const copy = new FormData();
    fd.forEach((v, k) => copy.append(k, v));
    draftRef.current = copy;
    formAction(fd);
  };

  const onOverwrite = () => {
    if (!conflict || !draftRef.current) return;
    const fd = new FormData();
    draftRef.current.forEach((v, k) => {
      if (k !== "version") fd.append(k, v);
    });
    // Force-apply against the server's current version so the OCC
    // predicate matches and this write lands.
    fd.set("version", String(conflict.serverVersion));
    setConflict(null);
    formAction(fd);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Edit activity"
        className="rounded-md p-1.5 text-muted-foreground/70 transition hover:bg-muted hover:text-foreground"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
    );
  }

  return (
    <>
      <form
        action={handleSubmit}
        className="mt-3 flex flex-col gap-3 rounded-lg border border-border bg-background/60 p-3"
      >
        <input type="hidden" name="activityId" value={activityId} />
        <input type="hidden" name="version" value={version} />

        {kind === "call" ? (
          <StandardFormField
            name="subject"
            label="Subject"
            maxLength={240}
            defaultValue={subject ?? ""}
          />
        ) : null}

        <StandardFormTextarea
          name="body"
          label={kind === "note" ? "Note" : "Notes"}
          rows={4}
          maxLength={20_000}
          required={kind === "note"}
          defaultValue={body ?? ""}
        />

        {kind === "call" && call ? (
          <div className="grid gap-3 md:grid-cols-3">
            <StandardFormField
              name="outcome"
              label="Outcome"
              maxLength={120}
              defaultValue={call.outcome ?? ""}
            />
            <StandardFormField
              name="durationMinutes"
              label="Duration (min)"
              type="text"
              inputMode="numeric"
              defaultValue={
                call.durationMinutes != null
                  ? String(call.durationMinutes)
                  : ""
              }
            />
            <StandardFormField
              name="occurredAt"
              label="Occurred"
              type="date"
              defaultValue={toLocalDate(call.occurredAt)}
            />
          </div>
        ) : null}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "Saving…" : "Save changes"}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            disabled={pending}
            className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm hover:bg-muted"
          >
            Cancel
          </button>
        </div>
      </form>

      <OccConflictDialog
        open={conflict !== null}
        entityLabel="activity"
        fields={conflict?.fields ?? []}
        pending={pending}
        onDismiss={() => setConflict(null)}
        onRefresh={() => {
          setConflict(null);
          setOpen(false);
          router.refresh();
        }}
        onOverwrite={onOverwrite}
      />
    </>
  );
}
