"use client";

import Link from "next/link";
import { useActionState } from "react";
import { importLeadsAction, type ImportActionResult } from "./actions";

const initial: ImportActionResult = { ok: true };

export function ImportClient() {
  const [state, action, pending] = useActionState(
    async (_p: ImportActionResult, fd: FormData) => importLeadsAction(fd),
    initial,
  );

  return (
    <>
      <form
        action={action}
        className="mt-8 flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl"
      >
        <label className="text-xs uppercase tracking-wide text-white/50">
          Upload .xlsx file
          <input
            type="file"
            name="file"
            accept=".xlsx"
            required
            className="mt-2 block w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white file:mr-4 file:rounded-md file:border-0 file:bg-white/90 file:px-3 file:py-1 file:text-xs file:font-medium file:text-slate-900 hover:file:bg-white"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-white/90 px-4 py-2 text-sm font-medium text-slate-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Importing…" : "Start import"}
        </button>

        {state.error ? (
          <p className="text-sm text-rose-200">{state.error}</p>
        ) : null}
      </form>

      {state.result ? (
        <div className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl">
          <h2 className="text-sm font-medium uppercase tracking-wide text-white/60">
            Results
          </h2>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Total rows" value={state.result.totalRows} />
            <Stat label="Successful" value={state.result.successful} />
            <Stat label="Errors" value={state.result.failed} tone="danger" />
            <Stat
              label="Needs review"
              value={state.result.needsReview}
              tone="warn"
            />
          </div>

          {state.result.errors.length > 0 ? (
            <div className="mt-6">
              <h3 className="text-xs uppercase tracking-wide text-white/50">
                Errors (first 50)
              </h3>
              <ul className="mt-2 max-h-64 overflow-y-auto divide-y divide-white/5 text-xs">
                {state.result.errors.slice(0, 50).map((e, i) => (
                  <li key={i} className="py-2 text-white/70">
                    Row {e.row} · <strong>{e.field}</strong>: {e.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {state.result.needsReviewRows.length > 0 ? (
            <div className="mt-6">
              <h3 className="text-xs uppercase tracking-wide text-amber-100/70">
                Needs review
              </h3>
              <ul className="mt-2 divide-y divide-white/5 text-xs">
                {state.result.needsReviewRows.map((r) => (
                  <li key={r.row} className="py-2 text-white/70">
                    Row {r.row}: {r.reason} —{" "}
                    <Link
                      href={`/leads/${r.existingLeadId}`}
                      className="text-amber-100 underline"
                    >
                      view existing lead
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <Link
            href="/leads"
            className="mt-6 inline-block rounded-md border border-white/15 bg-white/5 px-4 py-2 text-sm text-white/80 transition hover:bg-white/10"
          >
            View leads
          </Link>
        </div>
      ) : null}
    </>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "danger" | "warn";
}) {
  const ring =
    tone === "danger"
      ? "border-rose-300/30 bg-rose-500/10 text-rose-100"
      : tone === "warn"
        ? "border-amber-300/30 bg-amber-500/10 text-amber-100"
        : "border-white/10 bg-white/5 text-white/80";
  return (
    <div className={`rounded-xl border px-4 py-3 ${ring}`}>
      <p className="text-[10px] uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
