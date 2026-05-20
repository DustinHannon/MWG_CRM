"use client";

import { StandardEmptyState, StandardErrorBoundary } from "@/components/standard";
import type { TimePrefs } from "@/lib/format-time";

export type QueueBucket = "overdue" | "today" | "week" | "all";

export interface QueueTask {
  id: string;
  version: number;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueAt: string | null;
  leadId: string | null;
  accountId: string | null;
  contactId: string | null;
  opportunityId: string | null;
}

export interface QueueClientProps {
  allTasks: QueueTask[];
  initialBucket: QueueBucket | undefined;
  timePrefs: TimePrefs;
  viewerId: string;
}

/**
 * Skeleton mount — fleshed out in the next commit (focused card,
 * cursor, Skip/Done/Snooze, keyboard). Lives behind an error boundary
 * so a runtime crash in the card doesn't blow up the whole /tasks/queue
 * route.
 */
export function QueueClient({ allTasks }: QueueClientProps) {
  return (
    <StandardErrorBoundary>
      {allTasks.length === 0 ? (
        <StandardEmptyState
          title="No open tasks."
          description="You're clear. Nice work."
        />
      ) : (
        <div className="rounded-lg border border-border bg-card p-6">
          <p className="text-sm text-muted-foreground">
            Queue mode coming online — {allTasks.length} task
            {allTasks.length === 1 ? "" : "s"} in queue.
          </p>
        </div>
      )}
    </StandardErrorBoundary>
  );
}
