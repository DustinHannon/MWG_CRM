"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { FilterDsl } from "@/lib/security/filter-dsl";

/**
 * Phase 21 — Right-rail live preview for the new/edit list pages.
 *
 * Debounces 500ms after dsl changes, POSTs to
 * `/api/v1/marketing/lists/preview` with the DSL, and renders the
 * resulting count + sample.
 */
interface Props {
  dsl: FilterDsl | null;
}

interface SampleRow {
  id: string;
  email: string | null;
  firstName: string;
  lastName: string | null;
}

interface PreviewResponse {
  ok: true;
  data: {
    count: number;
    sample: SampleRow[];
  };
}

interface PreviewError {
  ok: false;
  error: string;
  code: string;
}

export function LivePreviewPanel({ dsl }: Props) {
  const [count, setCount] = useState<number | null>(null);
  const [sample, setSample] = useState<SampleRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const runPreview = useCallback(async (input: FilterDsl) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/marketing/lists/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ dsl: input }),
        signal: ctrl.signal,
      });
      const json = (await res.json()) as
        | PreviewResponse
        | PreviewError;
      if (!res.ok || !("ok" in json) || !json.ok) {
        const message =
          "ok" in json && !json.ok ? json.error : `HTTP ${res.status}`;
        throw new Error(message);
      }
      setCount(json.data.count);
      setSample(json.data.sample);
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Preview failed.");
      setCount(null);
      setSample([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Stable signature of the dsl so the effect re-runs only when content
  // actually changes (the parent re-binds `dsl` on every keystroke even
  // when the underlying object is identical).
  const dslSignature = useMemo(
    () => (dsl ? JSON.stringify(dsl) : null),
    [dsl],
  );

  useEffect(() => {
    if (!dsl || dslSignature === null) {
      // Reset only when there's no DSL — gated so we don't update state
      // unconditionally on every render.
      return;
    }
    const handle = setTimeout(() => {
      void runPreview(dsl);
    }, 500);
    return () => clearTimeout(handle);
  }, [dslSignature, dsl, runPreview]);

  return (
    <aside className="flex h-fit w-full flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Preview</h2>
        {loading ? (
          <Loader2
            className="h-4 w-4 animate-spin text-muted-foreground"
            aria-label="Loading preview"
          />
        ) : null}
      </div>

      {!dsl ? (
        <p className="text-xs text-muted-foreground">
          Add a rule to see who matches.
        </p>
      ) : error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : count === null ? (
        <p className="text-xs text-muted-foreground">Waiting for input…</p>
      ) : (
        <>
          <p className="text-2xl font-semibold tabular-nums text-foreground">
            {count.toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground">
            {count === 1 ? "lead matches" : "leads match"} (excludes do-not-email
            and archived).
          </p>
          {sample.length > 0 ? (
            <div className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
              <p className="text-[10px] uppercase tracking-[0.05em] text-muted-foreground">
                Sample
              </p>
              <ul className="flex flex-col gap-0.5">
                {sample.map((s) => (
                  <li
                    key={s.id}
                    className="truncate text-xs text-foreground"
                  >
                    <span className="font-medium">
                      {s.firstName}
                      {s.lastName ? ` ${s.lastName}` : ""}
                    </span>
                    {s.email ? (
                      <span className="ml-2 text-muted-foreground">
                        {s.email}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </aside>
  );
}
