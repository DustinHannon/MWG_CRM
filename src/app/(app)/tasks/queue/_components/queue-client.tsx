"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  SkipForward,
} from "lucide-react";
import {
  StandardEmptyState,
  StandardErrorBoundary,
} from "@/components/standard";
import { TaskCompleteToggle } from "@/components/tasks/task-complete-toggle";
import { StatusPill } from "@/components/ui/status-pill";
import { PriorityPill } from "@/components/ui/priority-pill";
import { UserTimeClient } from "@/components/ui/user-time-client";
import { toZonedTime } from "date-fns-tz";
import type { TimePrefs } from "@/lib/format-time";
import { updateTaskAction } from "@/app/(app)/tasks/actions";
import { SnoozePopover } from "./snooze-popover";

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

interface BucketCounts {
  overdue: number;
  today: number;
  week: number;
  all: number;
}

/**
 * Classify a task into a bucket based on its dueAt vs "now" in the
 * user's timezone. Pure function, callable per-task during filtering or
 * counting. Tasks with no dueAt fall into "all" only (never overdue,
 * never today, never week).
 */
function classifyBucket(
  task: QueueTask,
  now: Date,
  timezone: string,
): { overdue: boolean; today: boolean; week: boolean } {
  if (!task.dueAt) return { overdue: false, today: false, week: false };
  const dueZoned = toZonedTime(new Date(task.dueAt), timezone);
  const nowZoned = toZonedTime(now, timezone);

  const dueYmd =
    dueZoned.getFullYear() * 10000 +
    (dueZoned.getMonth() + 1) * 100 +
    dueZoned.getDate();
  const nowYmd =
    nowZoned.getFullYear() * 10000 +
    (nowZoned.getMonth() + 1) * 100 +
    nowZoned.getDate();

  const overdue = dueYmd < nowYmd;
  const today = dueYmd === nowYmd;
  const endOfWeekZoned = new Date(nowZoned);
  const dow = nowZoned.getDay();
  endOfWeekZoned.setDate(nowZoned.getDate() + (7 - dow));
  const eowYmd =
    endOfWeekZoned.getFullYear() * 10000 +
    (endOfWeekZoned.getMonth() + 1) * 100 +
    endOfWeekZoned.getDate();
  const week = dueYmd > nowYmd && dueYmd <= eowYmd;

  return { overdue, today, week };
}

function pickDefaultBucket(counts: BucketCounts): QueueBucket {
  if (counts.today > 0) return "today";
  if (counts.overdue > 0) return "overdue";
  return "all";
}

function entityLink(task: QueueTask): string | null {
  if (task.leadId) return `/leads/${task.leadId}`;
  if (task.accountId) return `/accounts/${task.accountId}`;
  if (task.contactId) return `/contacts/${task.contactId}`;
  if (task.opportunityId) return `/opportunities/${task.opportunityId}`;
  return null;
}

interface QueueClientInnerProps extends QueueClientProps {}

function QueueClientInner({
  allTasks,
  initialBucket,
  timePrefs,
  viewerId: _viewerId,
}: QueueClientInnerProps) {
  void _viewerId;
  const router = useRouter();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const now = useMemo(() => new Date(), []);
  const timezone = timePrefs.timezone;

  const counts = useMemo<BucketCounts>(() => {
    const c: BucketCounts = { overdue: 0, today: 0, week: 0, all: allTasks.length };
    for (const t of allTasks) {
      const cls = classifyBucket(t, now, timezone);
      if (cls.overdue) c.overdue++;
      if (cls.today) c.today++;
      if (cls.week) c.week++;
    }
    return c;
  }, [allTasks, now, timezone]);

  const activeBucket: QueueBucket = initialBucket ?? pickDefaultBucket(counts);

  const filteredTasks = useMemo(() => {
    if (activeBucket === "all") return allTasks;
    return allTasks.filter((t) => {
      const cls = classifyBucket(t, now, timezone);
      if (activeBucket === "overdue") return cls.overdue;
      if (activeBucket === "today") return cls.today;
      if (activeBucket === "week") return cls.week;
      return false;
    });
  }, [allTasks, activeBucket, now, timezone]);

  const taskIds = useMemo(() => filteredTasks.map((t) => t.id), [filteredTasks]);
  const taskMap = useMemo(() => {
    const m = new Map<string, QueueTask>();
    for (const t of filteredTasks) m.set(t.id, t);
    return m;
  }, [filteredTasks]);

  const [cursor, setCursor] = useState(0);
  const [doneIds, setDoneIds] = useState<Set<string>>(() => new Set());
  const [skippedIds, setSkippedIds] = useState<Set<string>>(() => new Set());
  const [snoozedIds, setSnoozedIds] = useState<Set<string>>(() => new Set());
  const [snoozePending, setSnoozePending] = useState(false);

  // If the bucket switches (URL change), reset cursor to 0 and clear
  // session state — we're effectively starting a new walk-through.
  const lastBucketRef = useRef(activeBucket);
  useEffect(() => {
    if (lastBucketRef.current !== activeBucket) {
      lastBucketRef.current = activeBucket;
      setCursor(0);
      setDoneIds(new Set());
      setSkippedIds(new Set());
      setSnoozedIds(new Set());
    }
  }, [activeBucket]);

  const totalCount = taskIds.length;
  const processedCount = doneIds.size + skippedIds.size + snoozedIds.size;
  const currentId = taskIds[cursor];
  const currentTask = currentId ? taskMap.get(currentId) : undefined;
  const atEnd = cursor >= totalCount;

  const advanceCursor = useCallback(() => {
    setCursor((c) => Math.min(c + 1, totalCount));
  }, [totalCount]);

  const handleSkip = useCallback(() => {
    if (!currentId) return;
    setSkippedIds((s) => {
      const next = new Set(s);
      next.add(currentId);
      return next;
    });
    advanceCursor();
  }, [currentId, advanceCursor]);

  const handlePrev = useCallback(() => {
    setCursor((c) => Math.max(0, c - 1));
  }, []);

  const handleNext = useCallback(() => {
    setCursor((c) => Math.min(totalCount, c + 1));
  }, [totalCount]);

  const handleDoneSuccess = useCallback(
    (_newVersion: number) => {
      void _newVersion;
      if (!currentId) return;
      setDoneIds((s) => {
        const next = new Set(s);
        next.add(currentId);
        return next;
      });
      advanceCursor();
      try {
        void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      } catch {
        // queryClient unavailable in this surface — refresh covers it.
      }
      router.refresh();
    },
    [currentId, advanceCursor, queryClient, router],
  );

  const handleSnooze = useCallback(
    async (targetUtc: Date) => {
      if (!currentTask) return;
      setSnoozePending(true);
      try {
        const res = await updateTaskAction({
          id: currentTask.id,
          version: currentTask.version,
          dueAt: targetUtc,
        });
        if (!res.ok) {
          toast.error(res.error, {
            duration: Infinity,
            dismissible: true,
          });
          return;
        }
        setSnoozedIds((s) => {
          const next = new Set(s);
          next.add(currentTask.id);
          return next;
        });
        advanceCursor();
        try {
          void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        } catch {
          // ignore — refresh covers it
        }
        router.refresh();
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to snooze task.";
        toast.error(message, {
          duration: Infinity,
          dismissible: true,
        });
      } finally {
        setSnoozePending(false);
      }
    },
    [currentTask, advanceCursor, queryClient, router],
  );

  // Keyboard handler — D / S / Z / ← → / j k / Esc.
  // Suppress when an input / textarea / select is focused (e.g. the
  // custom-date picker inside the snooze popover) OR when a Radix
  // dialog/popover is open and its content owns focus.
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  useEffect(() => {
    function isTextInputFocused(): boolean {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if ((el as HTMLElement).isContentEditable) return true;
      return false;
    }

    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTextInputFocused()) return;

      if (e.key === "Escape") {
        if (snoozeOpen) {
          e.preventDefault();
          setSnoozeOpen(false);
          return;
        }
        e.preventDefault();
        router.push("/tasks");
        return;
      }

      if (atEnd) return;

      const k = e.key.toLowerCase();
      if (k === "d") {
        e.preventDefault();
        // Synthesize a click on the visible Done toggle so the
        // existing TaskCompleteToggle + onSuccess wiring fires
        // exactly once, including its toast-on-error path.
        const btn = document.querySelector<HTMLButtonElement>(
          "[data-queue-done] button",
        );
        btn?.click();
        return;
      }
      if (k === "s") {
        e.preventDefault();
        handleSkip();
        return;
      }
      if (k === "z") {
        e.preventDefault();
        setSnoozeOpen((o) => !o);
        return;
      }
      if (k === "arrowleft" || k === "j") {
        e.preventDefault();
        handlePrev();
        return;
      }
      if (k === "arrowright" || k === "k") {
        e.preventDefault();
        handleNext();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [atEnd, snoozeOpen, handleSkip, handlePrev, handleNext, router]);

  const remainingLabel = useMemo(() => {
    if (activeBucket === "today") return "today";
    if (activeBucket === "overdue") return "overdue";
    if (activeBucket === "week") return "this week";
    return "in queue";
  }, [activeBucket]);

  const progressPct =
    totalCount === 0 ? 0 : Math.min(100, Math.round((processedCount / totalCount) * 100));

  function buildBucketHref(b: QueueBucket): string {
    const params = new URLSearchParams(searchParams.toString());
    if (b === "all") params.delete("bucket");
    else params.set("bucket", b);
    const qs = params.toString();
    return qs ? `/tasks/queue?${qs}` : "/tasks/queue";
  }

  function refreshQueue() {
    router.refresh();
  }

  if (totalCount === 0) {
    return (
      <>
        <BucketTabs counts={counts} active={activeBucket} buildHref={buildBucketHref} />
        <StandardEmptyState
          title="Nothing here."
          description="Switch buckets above or head back to the list."
        />
      </>
    );
  }

  if (atEnd) {
    return (
      <>
        <BucketTabs counts={counts} active={activeBucket} buildHref={buildBucketHref} />
        <StandardEmptyState
          title="Queue cleared. Nice work."
          description={`Processed ${processedCount} of ${totalCount} task${totalCount === 1 ? "" : "s"} (${doneIds.size} done, ${snoozedIds.size} snoozed, ${skippedIds.size} skipped).`}
        />
        <div className="mt-4 flex justify-center gap-3">
          <Link
            href="/tasks"
            className="rounded-md border border-border bg-muted/40 px-4 py-2 text-sm text-foreground/80 transition hover:bg-muted"
          >
            Back to list
          </Link>
          <button
            type="button"
            onClick={refreshQueue}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
          >
            Refresh queue
          </button>
        </div>
      </>
    );
  }

  if (!currentTask) {
    return (
      <StandardEmptyState
        title="Couldn't load the next task."
        description="Refresh the queue to try again."
      />
    );
  }

  const link = entityLink(currentTask);

  return (
    <>
      <BucketTabs counts={counts} active={activeBucket} buildHref={buildBucketHref} />

      <div className="mt-4 flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Task {Math.min(cursor + 1, totalCount)} of {totalCount}
          <span className="ml-2">
            · {Math.max(0, totalCount - processedCount)} remaining {remainingLabel}
          </span>
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handlePrev}
            disabled={cursor === 0}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/80 transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Previous task"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden /> Prev
          </button>
          <button
            type="button"
            onClick={handleNext}
            disabled={cursor >= totalCount}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/80 transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Next task"
          >
            Next <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>

      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={progressPct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Queue progress"
      >
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      <div className="mt-6 rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div data-queue-done className="pt-0.5">
              <TaskCompleteToggle
                task={{
                  id: currentTask.id,
                  title: currentTask.title,
                  version: currentTask.version,
                  status: currentTask.status,
                }}
                onSuccess={handleDoneSuccess}
              />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-foreground">
                {currentTask.title}
              </h2>
              {currentTask.description ? (
                <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/80">
                  {currentTask.description}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <StatusPill status={currentTask.status} />
            <PriorityPill priority={currentTask.priority} />
          </div>
        </div>

        <dl className="mt-6 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div className="flex items-center gap-2">
            <dt className="text-muted-foreground">Due</dt>
            <dd className="text-foreground">
              {currentTask.dueAt ? (
                <UserTimeClient
                  value={currentTask.dueAt}
                  prefs={timePrefs}
                  mode="date"
                />
              ) : (
                <span className="text-muted-foreground">No due date</span>
              )}
            </dd>
          </div>
          {link ? (
            <div className="flex items-center gap-2">
              <dt className="text-muted-foreground">Linked record</dt>
              <dd>
                <Link
                  href={link}
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  Open <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </Link>
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <SnoozePopover
            open={snoozeOpen}
            onOpenChange={setSnoozeOpen}
            disabled={snoozePending}
            timezone={timezone}
            currentDueAt={currentTask.dueAt}
            onSelect={handleSnooze}
          />
          <button
            type="button"
            onClick={handleSkip}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/80 transition hover:bg-muted"
            aria-label="Skip task"
          >
            <SkipForward className="h-4 w-4" aria-hidden /> Skip
          </button>
        </div>
      </div>

      <p className="mt-4 hidden text-xs text-muted-foreground md:flex md:items-center md:gap-4">
        <span>
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
            D
          </kbd>{" "}
          Done
        </span>
        <span>
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
            S
          </kbd>{" "}
          Skip
        </span>
        <span>
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
            Z
          </kbd>{" "}
          Snooze
        </span>
        <span>
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
            ←
          </kbd>{" "}
          /{" "}
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
            →
          </kbd>{" "}
          Prev / Next
        </span>
        <span>
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
            Esc
          </kbd>{" "}
          Back to list
        </span>
      </p>
    </>
  );
}

function BucketTabs({
  counts,
  active,
  buildHref,
}: {
  counts: BucketCounts;
  active: QueueBucket;
  buildHref: (b: QueueBucket) => string;
}) {
  const tabs: Array<{ key: QueueBucket; label: string; count: number }> = [
    { key: "overdue", label: "Overdue", count: counts.overdue },
    { key: "today", label: "Today", count: counts.today },
    { key: "week", label: "Later this week", count: counts.week },
    { key: "all", label: "All", count: counts.all },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <Link
            key={t.key}
            href={buildHref(t.key)}
            className={
              isActive
                ? "rounded-md border border-primary/40 bg-primary/15 px-3 py-1.5 text-xs font-medium text-foreground"
                : "rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-muted"
            }
            aria-current={isActive ? "page" : undefined}
          >
            {t.label}{" "}
            <span className="ml-1 text-[10px] text-muted-foreground">
              ({t.count})
            </span>
          </Link>
        );
      })}
    </div>
  );
}

export interface QueueClientPropsExternal extends QueueClientProps {}

export function QueueClient(props: QueueClientPropsExternal) {
  return (
    <StandardErrorBoundary>
      <QueueClientInner {...props} />
    </StandardErrorBoundary>
  );
}
