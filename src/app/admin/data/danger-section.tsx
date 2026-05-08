"use client";

import { useActionState } from "react";
import {
  deleteAllActivitiesAction,
  deleteAllImportsAction,
  deleteAllLeadsAction,
  type DangerSuccessData,
} from "./actions";
import type { ActionResult } from "@/lib/server-action";

const initial: ActionResult<DangerSuccessData> = {
  ok: true,
  data: { affected: -1 },
};

export function DangerSection({
  title,
  description,
  phrase,
  actionId,
}: {
  title: string;
  description: string;
  phrase: string;
  actionId: "leads" | "activities" | "imports";
}) {
  const handler =
    actionId === "leads"
      ? deleteAllLeadsAction
      : actionId === "activities"
        ? deleteAllActivitiesAction
        : deleteAllImportsAction;

  const [state, action, pending] = useActionState<
    ActionResult<DangerSuccessData>,
    FormData
  >(async (_p, fd) => handler(fd), initial);

  return (
    <section className="rounded-2xl border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)]/40 p-6 backdrop-blur-xl">
      <h2 className="text-base font-semibold text-[var(--status-lost-fg)]">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>

      <form action={action} className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-xs uppercase tracking-wide text-muted-foreground">
          Type{" "}
          <code className="rounded bg-black/30 px-1 py-0.5 text-[var(--status-lost-fg)]">
            {phrase}
          </code>{" "}
          to confirm
          <input
            name="confirm"
            autoComplete="off"
            className="mt-1 block min-w-[280px] rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-destructive/50 focus:outline-none focus:ring-2 focus:ring-destructive/40"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-[var(--status-lost-fg)]/40 bg-[var(--status-lost-bg)] px-4 py-2 text-sm font-medium text-[var(--status-lost-fg)] transition hover:bg-destructive/30 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Working…" : title}
        </button>
      </form>

      {!state.ok ? (
        <p className="mt-3 text-sm text-[var(--status-lost-fg)]">{state.error}</p>
      ) : state.data.affected >= 0 ? (
        <p className="mt-3 text-sm text-[var(--status-won-fg)]">
          Deleted {state.data.affected} row
          {state.data.affected === 1 ? "" : "s"}.
        </p>
      ) : null}
    </section>
  );
}
