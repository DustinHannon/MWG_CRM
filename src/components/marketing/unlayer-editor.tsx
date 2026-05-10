"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, Save } from "lucide-react";
import { buildMergeTagDict } from "@/lib/marketing/merge-tags";

/**
 * Phase 21 — Embedded Unlayer drag-and-drop email editor.
 *
 * `react-email-editor` is a thin wrapper around the global Unlayer
 * embed script and only renders in the browser. We mount it via
 * `next/dynamic({ ssr: false })` so it never reaches the server bundle.
 *
 * Sandbox policy:
 *   • The editor's own iframe needs `allow-scripts` and
 *     `allow-same-origin` to operate (the editor is a complex SPA).
 *     This component DOES NOT render untrusted user HTML — that work
 *     is done by `<SafeHtmlPreview>` which runs with sandbox="" .
 *   • We still apply an explicit sandbox attribute below so the iframe
 *     can't pop dialogs, escape via top-level navigation, or run code
 *     in a privileged context. Unlayer's panels stay functional under
 *     `allow-same-origin allow-scripts allow-forms allow-popups`.
 *
 * Merge tags come from `@/lib/marketing/merge-tags` so the editor
 * inserts the same `{{firstName}}` Handlebars tokens that the
 * SendGrid send pipeline materializes per recipient.
 */

interface UnlayerEditorInstance {
  loadDesign: (design: object) => void;
  exportHtml: (cb: (data: { design: object; html: string }) => void) => void;
  saveDesign: (cb: (design: object) => void) => void;
  setMergeTags?: (
    tags: Record<string, { name: string; value: string; sample: string }>,
  ) => void;
}

interface EditorRefShape {
  editor: UnlayerEditorInstance | null;
}

// Typed prop shape for the lazily-loaded `<EmailEditor />`. The package's
// own .d.ts pulls in `@unlayer/types` which is not installed in this
// repo, so we narrow the surface to the fields we actually use.
interface EditorProps {
  ref?: React.Ref<EditorRefShape>;
  minHeight?: number | string;
  style?: React.CSSProperties;
  onReady?: (unlayer: UnlayerEditorInstance) => void;
  options?: {
    projectId?: number;
    displayMode?: string;
    mergeTags?: Record<string, { name: string; value: string; sample: string }>;
    appearance?: {
      theme?: string;
      panels?: { tools?: { dock?: "left" | "right" } };
    };
    customCSS?: string[];
  };
}

const EmailEditor = dynamic<EditorProps>(
  () =>
    import("react-email-editor").then(
      // The package's typings include a generic for displayMode that
      // resolves through the missing `@unlayer/types`, so we narrow to
      // our local `EditorProps` shape via a single typed bridge.
      (mod) => mod.default as unknown as React.ComponentType<EditorProps>,
    ),
  {
    ssr: false,
    loading: () => <EditorSkeleton />,
  },
);

interface UnlayerEditorProps {
  initialDesign: object | null;
  projectId: number;
  onSave: (design: object, html: string) => void | Promise<void>;
  onSendTest?: () => void | Promise<void>;
  saveLabel?: string;
  /**
   * When false the toolbar still renders but the editor mount is replaced
   * with a friendly "not configured" message. The page-level guard at the
   * caller is responsible for using the `unlayerConfigured` boot flag.
   */
  configured?: boolean;
}

export function UnlayerEditor({
  initialDesign,
  projectId,
  onSave,
  onSendTest,
  saveLabel = "Save",
  configured = true,
}: UnlayerEditorProps) {
  const editorRef = useRef<EditorRefShape | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const initialDesignRef = useRef<object | null>(initialDesign);
  const [saving, setSaving] = useState(false);

  const mergeTags = useMemo(() => buildMergeTagDict(), []);

  const handleSave = useCallback(() => {
    const editor = editorRef.current?.editor;
    if (!editor) return;
    setSaving(true);
    editor.exportHtml(async (data) => {
      try {
        await onSave(data.design, data.html);
      } finally {
        setSaving(false);
      }
    });
  }, [onSave]);

  // Apply a tighter sandbox to the Unlayer iframe once it mounts. The
  // editor itself injects an iframe under `wrapperRef`; we wait until
  // it's in the DOM and add the attribute imperatively. This is a
  // belt-and-braces hardening — Unlayer's iframe is same-origin and
  // would normally inherit no restrictions at all.
  useEffect(() => {
    if (!configured) return;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const apply = () => {
      const iframe = wrapper.querySelector("iframe");
      if (iframe) {
        iframe.setAttribute(
          "sandbox",
          "allow-same-origin allow-scripts allow-forms allow-popups",
        );
        return true;
      }
      return false;
    };
    if (apply()) return;
    // The iframe is created asynchronously after script load; observe
    // a few times until it appears, then stop.
    const observer = new MutationObserver(() => {
      if (apply()) observer.disconnect();
    });
    observer.observe(wrapper, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [configured]);

  if (!configured) {
    return (
      <div className="rounded-lg border border-border bg-card p-8">
        <div className="flex items-start gap-3">
          <AlertTriangle
            className="h-5 w-5 text-muted-foreground"
            aria-hidden
          />
          <div>
            <p className="text-sm font-medium text-foreground">
              Email editor not configured
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Set <code className="rounded bg-muted px-1">NEXT_PUBLIC_UNLAYER_PROJECT_ID</code>{" "}
              in your environment to enable the drag-and-drop editor.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end gap-2">
        {onSendTest ? (
          <button
            type="button"
            onClick={() => void onSendTest()}
            className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted"
          >
            Send test
          </button>
        ) : null}
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-4 py-1.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-60"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Save className="h-4 w-4" aria-hidden />
          )}
          {saving ? "Saving…" : saveLabel}
        </button>
      </div>
      <div
        ref={wrapperRef}
        className="overflow-hidden rounded-lg border border-border bg-card"
      >
        <EmailEditor
          ref={editorRef}
          minHeight={600}
          style={{ height: "70vh", minHeight: 600 }}
          options={{
            projectId,
            displayMode: "email",
            mergeTags,
            appearance: {
              theme: "modern_dark",
              panels: { tools: { dock: "left" } },
            },
            customCSS: [],
          }}
          onReady={(unlayer) => {
            const design = initialDesignRef.current;
            if (design && Object.keys(design).length > 0) {
              try {
                unlayer.loadDesign(design);
              } catch {
                // Best-effort — a malformed design shouldn't crash the
                // editor mount; the user can still rebuild from scratch.
              }
            }
          }}
        />
      </div>
    </div>
  );
}

function EditorSkeleton() {
  return (
    <div className="flex h-[600px] w-full animate-pulse items-center justify-center rounded-lg border border-border bg-muted">
      <div className="flex flex-col items-center gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        <p className="text-xs">Loading editor…</p>
      </div>
    </div>
  );
}
