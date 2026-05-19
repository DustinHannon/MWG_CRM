"use client";

import { useTransition } from "react";
import { Circle, CheckCircle2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { toggleTaskCompleteAction } from "@/app/(app)/tasks/actions";

/**
 * Shared per-row complete-toggle for tasks.
 *
 * Rule-of-3 extraction (CLAUDE.md §18): now used in 3 places —
 *  - tasks list desktop row     (TanStack-cached list, owns invalidate)
 *  - tasks list mobile card     (same list, same invalidate)
 *  - entity tasks section row   (RSC, router.refresh() is enough)
 *
 * API contract:
 * - `onSuccess(newVersion)` — if provided, the caller is responsible
 *    for invalidating its own cache (TanStack lists, optimistic state,
 *    etc.). The toggle's only job is to fire the action and pass the
 *    new version back.
 * - omitted → falls back to `router.refresh()` so server-component
 *   consumers (entity-tasks-section) get a fresh RSC tree without any
 *   wiring.
 * Conflict / error paths are handled here (consistent toast copy
 * across all surfaces). Disabled state is forwarded; the in-flight
 * transition disables the button too.
 */
export interface TaskCompleteToggleProps {
  task: {
    id: string;
    title: string;
    version: number;
    // String-typed because `TaskRow.status` is `sql<string>`; the
    // toggle only branches on `=== "completed"` so the wider type is
    // safe and avoids a cast at every call site.
    status: string;
  };
  disabled?: boolean;
  onSuccess?: (newVersion: number) => void;
}

export function TaskCompleteToggle({
  task,
  disabled,
  onSuccess,
}: TaskCompleteToggleProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const isCompleted = task.status === "completed";

  function onClick() {
    const next = !isCompleted;
    startTransition(async () => {
      const res = await toggleTaskCompleteAction(
        task.id,
        task.version,
        next,
      );
      if (!res.ok) {
        toast.error(res.error, { duration: Infinity, dismissible: true });
        return;
      }
      if (onSuccess) {
        onSuccess(res.data.version);
      } else {
        router.refresh();
      }
    });
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || pending}
      aria-pressed={isCompleted}
      aria-label={`Mark ${task.title} ${isCompleted ? "open" : "complete"}`}
      className="inline-flex items-center justify-center rounded-full text-muted-foreground transition hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
    >
      {isCompleted ? (
        <CheckCircle2
          className="h-5 w-5 text-[var(--status-won-fg)]"
          aria-hidden
        />
      ) : (
        <Circle className="h-5 w-5" aria-hidden />
      )}
    </button>
  );
}
