/**
 * Phase 29 §7 — Type definitions shared across the extraction script.
 */

export type EditorType =
  | "custom-html"
  | "free-style"
  | "email-designer"
  | "drag-and-drop"
  | "unknown";

export type TemplateStatus = "extracted" | "failed" | "skipped";

export interface TemplateCandidate {
  /** D365 template GUID (lowercased, no braces). */
  cdTemplateId: string;
  cdTemplateName: string;
  cdSubject?: string | null;
  cdCategory?: string | null;
  cdOwner?: string | null;
  cdCreatedAt?: string | null;
  cdModifiedAt?: string | null;
  /** Deep-link URL into the legacy CD UI's open-template view. */
  detailUrl: string;
}

export interface ExtractedTemplate extends TemplateCandidate {
  editorType: EditorType;
  rawHtml: string | null;
  status: TemplateStatus;
  errorReason?: string | null;
}

export interface PersistedState {
  runId: string;
  startedAtIso: string;
  /** cdTemplateId → outcome for already-processed rows. */
  processed: Record<string, TemplateStatus>;
}

export interface ScriptConfig {
  cdBaseUrl: string;
  cdTemplatesUrl: string | null;
  mwgApiBase: string;
  mwgApiKey: string;
  concurrency: number;
  perTemplateTimeoutMs: number;
  storageStatePath: string;
  extractionStatePath: string;
  /** Optional CLI override — process at most this many templates. */
  limit: number | null;
}
