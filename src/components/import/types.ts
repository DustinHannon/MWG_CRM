/**
 * Shared types for the generic Excel import wizard.
 *
 * The wizard at `@/components/import/import-wizard.tsx` is a 3-stage
 * shell (upload → preview → result) that delegates the entity-specific
 * preview / commit logic to a config object. Both the leads import
 * (`@/app/(app)/leads/import/import-client.tsx`) and the static-list
 * import (`@/app/(app)/marketing/lists/[id]/import/`) pass a config
 * matching this contract.
 *
 * No domain types live here. The wizard treats preview and commit
 * payloads as opaque blobs and renders them via the config's
 * `renderPreview` / `renderResult` callbacks. That keeps the wizard
 * free of any leads-specific or marketing-specific knowledge.
 */
import type { ReactNode } from "react";
import type { ActionResult } from "@/lib/server-action";

/**
 * Every preview action MUST return at least `{ jobId, fileName }` so the
 * wizard can drive the commit / cancel flow. Additional fields (preview
 * counts, errors, smart-detect hints, etc.) are part of the entity's
 * own preview type and rendered via `config.renderPreview`.
 */
export interface BaseImportPreview {
  jobId: string;
  fileName: string;
}

/**
 * Each surface defines a config that the wizard consumes. `TPreview`
 * extends `BaseImportPreview` so the wizard can read `jobId` for
 * commit / cancel. `TCommit` is whatever the commit action returns.
 *
 * Note: `ActionResult<T>` resolves to `{ ok: true; data: T }` when T
 * is non-void. We constrain `TPreview` and `TCommit` to objects so the
 * `.data` discriminant is statically present on success.
 */
export interface ImportWizardConfig<
  TPreview extends BaseImportPreview,
  TCommit extends object,
> {
  /** Plural-noun destination shown in headers and toasts. */
  destinationLabel: string;

  /** Optional GET URL for an .xlsx template download. */
  templateDownloadUrl?: string;

  /**
   * Optional docs link displayed beside the upload form.
   */
  documentationUrl?: string;

  /**
   * The form action invoked on file upload. Receives the wizard's
   * FormData (with the file in `file`); the lead path also sets a
   * `smartDetect` checkbox that flows through.
   */
  previewAction: (
    formData: FormData,
  ) => Promise<ActionResult<TPreview>>;

  /** Called after the user confirms the preview. */
  commitAction: (jobId: string) => Promise<ActionResult<TCommit>>;

  /** Called when the user cancels from the preview stage. */
  cancelAction: (jobId: string) => Promise<ActionResult<void>>;

  /**
   * Render the preview pane. Receives the typed preview payload plus
   * `pending` and the commit / cancel handlers so it can render its
   * own action bar in the entity-specific layout.
   */
  renderPreview: (args: {
    preview: TPreview;
    pending: boolean;
    onCommit: () => void;
    onCancel: () => void;
  }) => ReactNode;

  /**
   * Render the post-commit result. Receives either the success payload
   * or a failure surface; the wizard never inspects the shape.
   */
  renderResult: (args: {
    state: ActionResult<TCommit>;
  }) => ReactNode;

  /**
   * Optional extras rendered above the upload form (e.g., resume CTA
   * for a static-list run that's in progress).
   */
  renderUploadExtras?: () => ReactNode;

  /**
   * Optional extras inside the upload form (e.g., smart-detect checkbox).
   * Rendered before the submit button.
   */
  renderUploadFormExtras?: () => ReactNode;

  /**
   * Optional toast message shown after a successful commit. Defaults to
   * "Import committed."
   */
  successToastMessage?: string;
}
