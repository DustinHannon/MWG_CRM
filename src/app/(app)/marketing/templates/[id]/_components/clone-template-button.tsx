"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cloneTemplateAction } from "../../actions";

interface CloneTemplateButtonProps {
  templateId: string;
  icon?: ReactNode;
}

/**
 * "Clone to personal" trigger on the template detail
 * page. Posts to the clone server action and, on success, navigates
 * to the editor for the new (personal) row so the marketer can start
 * iterating immediately.
 */
export function CloneTemplateButton({
  templateId,
  icon,
}: CloneTemplateButtonProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("id", templateId);
      const result = await cloneTemplateAction(fd);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/marketing/templates/${result.data.id}/edit`);
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 whitespace-nowrap transition hover:bg-muted disabled:opacity-60"
      >
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          icon
        )}
        {pending ? "Cloning…" : "Clone to personal"}
      </button>
      {error ? (
        <span
          role="alert"
          className="text-xs text-[var(--status-lost-fg)]"
        >
          {error}
        </span>
      ) : null}
    </>
  );
}
