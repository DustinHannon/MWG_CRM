"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import type { WorklistRow } from "./worklist-client";

/**
 * Phase 29 §7 — Modal viewer for the captured HTML of a single
 * ClickDimensions migration row. Fetched on demand from the
 * `/admin/migrations/clickdimensions/[id]/html` route to avoid
 * shipping large blobs to the client up-front.
 */

type FetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; html: string }
  | { status: "error"; message: string };

export function ViewHtmlDialog({
  row,
  onClose,
}: {
  row: WorklistRow | null;
  onClose: () => void;
}) {
  const rowId = row?.id ?? null;
  const [state, setState] = useState<FetchState>({ status: "idle" });
  const [view, setView] = useState<"raw" | "preview">("raw");

  useEffect(() => {
    if (!rowId) return;
    const ac = new AbortController();
    fetch(
      `/admin/migrations/clickdimensions/${encodeURIComponent(rowId)}/html`,
      { cache: "no-store", signal: ac.signal },
    )
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Failed to load HTML (status ${res.status}).`);
        }
        return res.text();
      })
      .then((text) => {
        if (!ac.signal.aborted) {
          setState({ status: "success", html: text });
        }
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    // We can't call setState synchronously inside the effect body, so
    // we let the resolution above flip status from `idle` to `loading`
    // by using the queueMicrotask sequence below: the fetch promise
    // has already begun; we mark loading on the next microtask.
    queueMicrotask(() => {
      if (!ac.signal.aborted) setState({ status: "loading" });
    });
    return () => {
      ac.abort();
    };
  }, [rowId]);

  const html =
    state.status === "success" ? state.html : null;
  const errorMessage =
    state.status === "error" ? state.message : null;
  const loading = state.status === "loading";

  return (
    <Dialog.Root
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[85vh] w-[min(960px,90vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-background shadow-xl focus:outline-none">
          <div className="flex items-start justify-between gap-3 border-b border-border p-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-sm font-semibold text-foreground">
                {row?.cdTemplateName ?? "Template HTML"}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-muted-foreground">
                Captured HTML preview. {row?.htmlBytes ?? 0} bytes.
              </Dialog.Description>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setView("raw")}
                className={[
                  "rounded-md border px-2 py-1 text-xs font-medium",
                  view === "raw"
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background text-foreground hover:bg-muted",
                ].join(" ")}
              >
                Raw
              </button>
              <button
                type="button"
                onClick={() => setView("preview")}
                className={[
                  "rounded-md border px-2 py-1 text-xs font-medium",
                  view === "preview"
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background text-foreground hover:bg-muted",
                ].join(" ")}
              >
                Preview
              </button>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-foreground hover:bg-muted"
                >
                  Close
                </button>
              </Dialog.Close>
            </div>
          </div>
          <div className="flex-1 overflow-hidden p-4">
            {loading ? (
              <div className="text-xs text-muted-foreground">Loading…</div>
            ) : errorMessage ? (
              <div className="text-xs text-destructive">{errorMessage}</div>
            ) : html === null ? (
              <div className="text-xs text-muted-foreground">
                No HTML captured for this row.
              </div>
            ) : view === "raw" ? (
              <pre className="h-full overflow-auto rounded-md border border-border bg-muted/40 p-3 text-[11px] leading-relaxed text-foreground">
                <code>{html}</code>
              </pre>
            ) : (
              // Preview pane: sandboxed iframe with srcDoc. The sandbox
              // attribute prevents script execution and form submission;
              // captured HTML is never trusted.
              <iframe
                title="Captured template preview"
                sandbox=""
                srcDoc={html}
                className="h-full w-full rounded-md border border-border bg-card"
              />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
