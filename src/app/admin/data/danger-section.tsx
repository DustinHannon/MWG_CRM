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
    <section className="rounded-2xl border border-rose-500/30 dark:border-rose-300/30 bg-rose-500/5 p-6 backdrop-blur-xl">
      <h2 className="text-base font-semibold text-rose-50">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>

      <form action={action} className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-xs uppercase tracking-wide text-muted-foreground">
          Type{" "}
          <code className="rounded bg-black/30 px-1 py-0.5 text-rose-700 dark:text-rose-100">
            {phrase}
          </code>{" "}
          to confirm
          <input
            name="confirm"
            autoComplete="off"
            className="mt-1 block min-w-[280px] rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-rose-300/50 focus:outline-none focus:ring-2 focus:ring-rose-500/40"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-rose-300/40 bg-rose-500/20 px-4 py-2 text-sm font-medium text-rose-50 transition hover:bg-rose-500/30 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Working…" : title}
        </button>
      </form>

      {!state.ok ? (
        <p className="mt-3 text-sm text-rose-700 dark:text-rose-200">{state.error}</p>
      ) : state.data.affected >= 0 ? (
        <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-200">
          Deleted {state.data.affected} row
          {state.data.affected === 1 ? "" : "s"}.
        </p>
      ) : null}
    </section>
  );
}
