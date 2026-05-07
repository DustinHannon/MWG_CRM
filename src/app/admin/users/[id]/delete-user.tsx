"use client";

import { useState, useTransition } from "react";
import {
  deleteUserAction,
  getDeleteUserPreflight,
  type DeleteUserPreflightData,
} from "./delete-user-actions";
import type { ActionResult } from "@/lib/server-action";

/**
 * Delete-user button + modal.
 *
 * Click "Delete user" → hits getDeleteUserPreflight, which fetches the
 * lead/activity counts and the list of valid reassign targets and admin
 * count (for the last-admin guard). The modal renders one of two shapes:
 *  - "User has 0 leads" → simple "type DELETE" confirmation.
 *  - "User has ≥1 leads" → radio: reassign-vs-cascade-delete.
 *
 * Submission goes through deleteUserAction in a single transaction. On
 * success the action redirects to /admin/users, so we just show the
 * pending state until that happens.
 */
export function DeleteUserButton({
  userId,
  disabled,
  disabledReason,
}: {
  userId: string;
  disabled: boolean;
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const [preflight, setPreflight] = useState<ActionResult<
    DeleteUserPreflightData
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  const handleOpen = () => {
    if (disabled) return;
    setError(null);
    setPreflight(null);
    setOpen(true);
    startTransition(async () => {
      const r = await getDeleteUserPreflight(userId);
      setPreflight(r);
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        className="rounded-md border border-rose-300/30 bg-rose-500/10 px-3 py-1.5 text-sm text-rose-100 transition hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Delete user
      </button>

      {open ? (
        <Modal onClose={() => !submitting && setOpen(false)}>
          {preflight === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !preflight.ok ? (
            <div>
              <h2 className="text-lg font-semibold">Cannot delete</h2>
              <p className="mt-2 text-sm text-rose-100">
                {preflight.error ?? "Unknown error."}
              </p>
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
                >
                  Close
                </button>
              </div>
            </div>
          ) : (
            <DeleteForm
              preflight={preflight.data}
              userId={userId}
              error={error}
              submitting={submitting}
              onSubmit={async (fd) => {
                setError(null);
                setSubmitting(true);
                const res = await deleteUserAction(fd);
                setSubmitting(false);
                // Action redirects on success, so any return here means
                // a guard tripped or validation failed.
                if (res && !res.ok) setError(res.error ?? "Delete failed.");
              }}
              onCancel={() => setOpen(false)}
            />
          )}
        </Modal>
      ) : null}
    </>
  );
}

function DeleteForm({
  preflight,
  userId,
  error,
  submitting,
  onSubmit,
  onCancel,
}: {
  preflight: DeleteUserPreflightData;
  userId: string;
  error: string | null;
  submitting: boolean;
  onSubmit: (fd: FormData) => Promise<void>;
  onCancel: () => void;
}) {
  const u = preflight.user;
  const targets = preflight.reassignTargets;
  const hasLeads = u.leadCount > 0;
  const expected = !hasLeads ? "DELETE" : null;
  // For the leads case the user picks the disposition; expected confirm
  // string flips between DELETE and DELETE LEADS based on the radio.
  const [disposition, setDisposition] = useState<
    "reassign" | "delete_leads"
  >(targets[0] ? "reassign" : "delete_leads");
  const [reassignTo, setReassignTo] = useState<string>(targets[0]?.id ?? "");
  const [confirm, setConfirm] = useState("");

  const expectedConfirm = expected
    ? expected
    : disposition === "delete_leads"
      ? "DELETE LEADS"
      : "DELETE";

  const onFormSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData();
    fd.set("userId", userId);
    // For the no-leads case we always pass "reassign" with reassignTo unset
    // — the server still runs the delete user step and the leads-update is
    // a no-op. Simpler than a third disposition value.
    fd.set("disposition", hasLeads ? disposition : "reassign");
    if (hasLeads && disposition === "reassign") {
      fd.set("reassignTo", reassignTo);
    }
    fd.set("confirm", confirm);
    void onSubmit(fd);
  };

  return (
    <form onSubmit={onFormSubmit}>
      <h2 className="text-lg font-semibold">Delete {u.displayName}?</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        This permanently removes the user account, their personal saved
        views, preferences, OAuth links, and active sessions.
      </p>

      {u.activityCount > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground/80">
          {u.activityCount} activity rows authored by this user will be
          preserved with author shown as &quot;Deleted user&quot;.
        </p>
      ) : null}

      {hasLeads ? (
        <fieldset className="mt-4 rounded-md border border-border bg-muted/40 p-4">
          <legend className="px-2 text-xs uppercase tracking-wide text-muted-foreground/80">
            What about their {u.leadCount} owned lead{u.leadCount === 1 ? "" : "s"}?
          </legend>
          <label className="flex items-start gap-2 py-2">
            <input
              type="radio"
              name="disposition"
              value="reassign"
              checked={disposition === "reassign"}
              onChange={() => setDisposition("reassign")}
              className="mt-1 h-4 w-4 border-border bg-muted/40 text-blue-500 focus:ring-blue-500"
            />
            <span className="flex-1 text-sm">
              <strong className="text-foreground">Reassign to another user</strong>
              <p className="mt-1 text-xs text-muted-foreground">
                Their {u.leadCount} lead{u.leadCount === 1 ? "" : "s"} get a
                new owner. The &quot;Created by&quot; field on each lead is
                preserved.
              </p>
              {disposition === "reassign" ? (
                <select
                  required
                  value={reassignTo}
                  onChange={(e) => setReassignTo(e.target.value)}
                  className="mt-2 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground"
                >
                  {targets.length === 0 ? (
                    <option value="">No active users available</option>
                  ) : null}
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.displayName} ({t.email})
                    </option>
                  ))}
                </select>
              ) : null}
            </span>
          </label>
          <label className="flex items-start gap-2 py-2">
            <input
              type="radio"
              name="disposition"
              value="delete_leads"
              checked={disposition === "delete_leads"}
              onChange={() => setDisposition("delete_leads")}
              className="mt-1 h-4 w-4 border-border bg-muted/40 text-rose-500 focus:ring-rose-500"
            />
            <span className="flex-1 text-sm">
              <strong className="text-rose-100">
                Delete all of their leads
              </strong>
              <p className="mt-1 text-xs text-rose-100/80">
                {u.leadCount} lead{u.leadCount === 1 ? "" : "s"} and their
                activities + attachments will be permanently deleted. This
                cannot be undone.
              </p>
            </span>
          </label>
        </fieldset>
      ) : null}

      <label className="mt-4 block">
        <span className="text-xs uppercase tracking-wide text-muted-foreground/80">
          Type{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">
            {expectedConfirm}
          </code>{" "}
          to confirm
        </span>
        <input
          autoFocus
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-rose-300/50 focus:outline-none"
        />
      </label>

      {error ? (
        <p className="mt-3 rounded-md border border-rose-300/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">
          {error}
        </p>
      ) : null}

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={
            submitting ||
            confirm !== expectedConfirm ||
            (hasLeads && disposition === "reassign" && !reassignTo)
          }
          className="rounded-md bg-rose-500/80 px-4 py-1.5 text-sm font-medium text-foreground transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Deleting…" : "Delete user"}
        </button>
      </div>
    </form>
  );
}

function Modal({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-2xl border border-border bg-[var(--popover)] text-[var(--popover-foreground)] p-6 shadow-2xl"
      >
        {children}
      </div>
    </div>
  );
}
