"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { htmlToPlainText, isLikelyHtml } from "@/lib/html-text";
import { SafeHtmlPreview } from "@/components/security/safe-html-preview";

interface RichBodyProps {
  /** The raw body — plain text or full/fragment HTML (e.g. a D365 email). */
  body: string | null | undefined;
  /** Class on the plain-text `<p>` (typography + margin the call site owns). */
  className?: string;
  /** Class on the HTML toggle wrapper so its margin matches the call site. */
  containerClassName?: string;
  /** Label on the expand toggle when the body is HTML. */
  expandLabel?: string;
  /** Characters of plain-text preview shown while the HTML stays collapsed. */
  snippetLength?: number;
}

/**
 * Renders a body that may be plain text OR HTML.
 *
 * Imported D365 emails, notes, and tasks carry full Outlook/Word HTML
 * documents; native CRM bodies are plain text. Plain text renders inline as
 * before. HTML renders a plain-text snippet by default and reveals the
 * faithful full email — rendered verbatim inside the sandboxed `SafeHtmlPreview`
 * iframe (the canonical safe sink, `sandbox=""`) — on demand. Lazy-mounting the
 * iframe keeps a feed of many emails cheap.
 *
 * `isLikelyHtml`/`htmlToPlainText` are pure string ops, so the collapsed
 * snippet computed during SSR matches the client render (no hydration drift).
 */
export function RichBody({
  body,
  className = "whitespace-pre-wrap text-sm text-foreground/90",
  containerClassName = "mt-3",
  expandLabel = "Show full content",
  snippetLength = 180,
}: RichBodyProps) {
  const [expanded, setExpanded] = useState(false);
  const isHtml = useMemo(() => isLikelyHtml(body), [body]);
  const snippet = useMemo(() => {
    if (!isHtml) return "";
    const text = htmlToPlainText(body);
    return text.length > snippetLength
      ? `${text.slice(0, snippetLength).trimEnd()}…`
      : text;
  }, [body, isHtml, snippetLength]);

  if (!body) return null;

  // Plain-text body — render directly, preserving author line breaks.
  if (!isHtml) {
    return <p className={className}>{body}</p>;
  }

  // HTML body — plain-text snippet, faithful full render on expand.
  return (
    <div className={containerClassName}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
          aria-hidden
        />
        {expanded ? "Hide formatted content" : expandLabel}
      </button>
      {expanded ? (
        <SafeHtmlPreview
          html={body}
          className="mt-2 h-[min(640px,70vh)] w-full rounded border border-border bg-white"
        />
      ) : snippet ? (
        <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/80">
          {snippet}
        </p>
      ) : null}
    </div>
  );
}
