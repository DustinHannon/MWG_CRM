"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import type { ActionFailure, ActionResult } from "@/lib/server-action";
import type {
  BaseImportPreview,
  ImportWizardConfig,
} from "./types";

/**
 * Phase 29 §6 — Generic Excel import wizard.
 *
 * Preserves the 3-stage flow from the lead-import wizard
 * (upload → preview → result) while parameterizing the surface
 * via `ImportWizardConfig`. Both the leads import path and the
 * static-list import path mount this component with their own config.
 *
 * The wizard owns:
 *   • Stage state machine (upload / preview / result).
 *   • Upload form chrome (file picker + Preview-import button + template
 *     download link).
 *   • Commit / cancel button wiring and pending state.
 *   • Toast surfacing of success / failure.
 *
 * The config owns:
 *   • What the preview pane looks like (`renderPreview`).
 *   • What the result pane looks like (`renderResult`).
 *   • Any extras inside / above the upload form (smart-detect checkbox,
 *     resume-from-run CTA, etc.).
 */
type Stage = "upload" | "preview" | "result";

export function ImportWizard<
  TPreview extends BaseImportPreview,
  TCommit extends object,
>({
  config,
  resumeRunId,
}: {
  config: ImportWizardConfig<TPreview, TCommit>;
  /**
   * Optional run id to auto-load on mount. When present, the wizard
   * skips the upload form on first render and jumps straight to the
   * preview stage by calling `config.previewAction` with `resumeRunId`
   * set in FormData. Used by the static-list import flow to surface
   * an in-progress run.
   */
  resumeRunId?: string;
}) {
  const [stage, setStage] = useState<Stage>("upload");
  const [previewState, setPreviewState] = useState<TPreview | null>(null);
  const [commitState, setCommitState] = useState<ActionResult<TCommit> | null>(
    null,
  );
  const [pending, startTransition] = useTransition();
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Auto-load a persisted preview on first mount when resumeRunId is
  // provided. Guarded by a ref so React 19 strict double-invoke does
  // not fire two preview calls.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (!resumeRunId) return;
    if (resumedRef.current) return;
    resumedRef.current = true;
    const fd = new FormData();
    fd.set("resumeRunId", resumeRunId);
    startTransition(async () => {
      const res = (await config.previewAction(fd)) as
        | { ok: true; data: TPreview }
        | ActionFailure;
      if (!res.ok) {
        setUploadError(res.error ?? "Resume failed.");
        return;
      }
      setPreviewState(res.data);
      setStage("preview");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeRunId]);

  function onUpload(formData: FormData) {
    setUploadError(null);
    startTransition(async () => {
      const res = (await config.previewAction(formData)) as
        | { ok: true; data: TPreview }
        | ActionFailure;
      if (!res.ok) {
        setUploadError(res.error ?? "Upload failed.");
        return;
      }
      setPreviewState(res.data);
      setStage("preview");
    });
  }

  function onCommit() {
    if (!previewState?.jobId) return;
    startTransition(async () => {
      const res = await config.commitAction(previewState.jobId);
      setCommitState(res);
      setStage("result");
      if (!res.ok) {
        toast.error(res.error ?? "Commit failed.", {
          duration: Infinity,
          dismissible: true,
        });
      } else {
        toast.success(config.successToastMessage ?? "Import committed.");
      }
    });
  }

  function onCancel() {
    if (!previewState?.jobId) {
      setStage("upload");
      setPreviewState(null);
      return;
    }
    startTransition(async () => {
      await config.cancelAction(previewState.jobId);
      setStage("upload");
      setPreviewState(null);
    });
  }

  return (
    <div>
      {stage === "upload" ? (
        <>
          {config.renderUploadExtras ? config.renderUploadExtras() : null}
          <UploadForm
            pending={pending}
            uploadError={uploadError}
            templateDownloadUrl={config.templateDownloadUrl}
            documentationUrl={config.documentationUrl}
            onSubmit={onUpload}
            renderExtras={config.renderUploadFormExtras}
          />
        </>
      ) : null}
      {stage === "preview" && previewState
        ? config.renderPreview({
            preview: previewState,
            pending,
            onCommit,
            onCancel,
          })
        : null}
      {stage === "result" && commitState
        ? config.renderResult({ state: commitState })
        : null}
    </div>
  );
}

function UploadForm({
  pending,
  uploadError,
  templateDownloadUrl,
  documentationUrl,
  onSubmit,
  renderExtras,
}: {
  pending: boolean;
  uploadError: string | null;
  templateDownloadUrl?: string;
  documentationUrl?: string;
  onSubmit: (fd: FormData) => void;
  renderExtras?: () => React.ReactNode;
}) {
  return (
    <form
      action={onSubmit}
      className="mt-8 flex flex-col gap-4 rounded-2xl border border-border bg-muted/40 p-6 backdrop-blur-xl"
    >
      <div className="flex items-center justify-between gap-4">
        <label className="flex-1 text-xs uppercase tracking-wide text-muted-foreground">
          Upload .xlsx file
          <input
            type="file"
            name="file"
            accept=".xlsx"
            required
            className="mt-2 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground file:mr-4 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1 file:text-xs file:font-medium file:text-primary-foreground hover:file:bg-primary/90"
          />
        </label>
        {templateDownloadUrl ? (
          <Link
            href={templateDownloadUrl}
            className="self-end rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-foreground/90 transition hover:bg-muted"
          >
            Download template (.xlsx)
          </Link>
        ) : null}
      </div>

      {renderExtras ? renderExtras() : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Parsing…" : "Preview import"}
        </button>
        {documentationUrl ? (
          <Link
            href={documentationUrl}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Documentation
          </Link>
        ) : null}
      </div>

      {uploadError ? (
        <p className="text-sm text-[var(--status-lost-fg)]">{uploadError}</p>
      ) : null}
    </form>
  );
}
