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
import { RichBody } from "@/components/activity/rich-body";
import { StatusPill } from "@/components/ui/status-pill";
import { PriorityPill } from "@/components/ui/priority-pill";
import { UserTimeClient } from "@/components/ui/user-time-client";
import { toZonedTime } from "date-fns-tz";
import type { TimePrefs } from "@/lib/format-time";
import { updateTaskAction, toggleTaskCompleteAction } from "@/app/(app)/tasks/actions";
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
  // "Later this week" runs from tomorrow through Saturday. Calendar
  // weeks here are Sun–Sat (dow 0–6); a Saturday viewer has an empty
  // "Later this week" by design (everything later is next week).
  // Previously used dow→(7-dow), which gave Sunday viewers an 8-day
  // window vs every other day's 1–6.
  const dow = nowZoned.getDay();
  const daysToWeekEnd = 6 - dow;
  const endOfWeekZoned = new Date(nowZoned);
  endOfWeekZoned.setDate(nowZoned.getDate() + daysToWeekEnd);
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

function QueueClientInner({
  allTasks,
  initialBucket,
  timePrefs,
}: QueueClientProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  // `now` refreshes every 60s so day-bucket math (Today / Overdue /
  // Later this week) stays accurate across midnight and DST boundaries
  // for reps who keep the queue open all session.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
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
  // A Done / Snooze advances the cursor optimistically (so the next card
  // shows immediately) but the follow-up router.refresh() re-slices
  // `allTasks`: the actioned row drops out and everything after it shifts
  // down one index. Without reconciliation the cursor would then point one
  // row too far and the next task would be silently skipped. This ref drives
  // the reconcile that re-pins the cursor once the refreshed list lands.
  //   removedId — the actioned card. The reconcile only runs once this id has
  //     actually left the list, so an unrelated re-slice (a 60s `now` tick, a
  //     realtime refresh) while the row is still present can't consume the
  //     reconcile early and let the next task be skipped.
  //   nextId — the card we advanced TO; the cursor is re-pinned to its
  //     post-refresh index. null = the last card was actioned, so the
  //     reconcile settles at the end instead.
  const pendingReconcileRef = useRef<
    { removedId: string; nextId: string | null } | null
  >(null);
  const [doneIds, setDoneIds] = useState<Set<string>>(() => new Set());
  const [skippedIds, setSkippedIds] = useState<Set<string>>(() => new Set());
  const [snoozedIds, setSnoozedIds] = useState<Set<string>>(() => new Set());
  const [snoozePending, setSnoozePending] = useState(false);
  const [donePending, setDonePending] = useState(false);
  // Tracks the latest server-known version after a successful Done /
  // Snooze, so back-arrow navigating to a previously-completed card
  // doesn't post a stale version (which would surface a ConflictError
  // toast on a task the rep already actioned).
  const [versionOverrides, setVersionOverrides] = useState<
    Record<string, number>
  >({});

  // If the bucket switches (URL change), reset cursor to 0 and clear
  // session state — we're effectively starting a new walk-through.
  const lastBucketRef = useRef(activeBucket);
  useEffect(() => {
    if (lastBucketRef.current !== activeBucket) {
      lastBucketRef.current = activeBucket;
      // Drop any in-flight reconcile so it can't override the fresh cursor
      // reset against the new bucket's list.
      pendingReconcileRef.current = null;
      setCursor(0);
      setDoneIds(new Set());
      setSkippedIds(new Set());
      setSnoozedIds(new Set());
    }
  }, [activeBucket]);

  const totalCount = taskIds.length;
  // Use a unioned Set so a task that's been Skipped-then-Done (or any
  // combination) counts ONCE in the progress bar / "remaining" math —
  // not three times across the three sets.
  const processedCount = useMemo(() => {
    const seen = new Set<string>();
    for (const id of doneIds) seen.add(id);
    for (const id of skippedIds) seen.add(id);
    for (const id of snoozedIds) seen.add(id);
    return Math.min(seen.size, totalCount);
  }, [doneIds, skippedIds, snoozedIds, totalCount]);
  const currentId = taskIds[cursor];
  const rawCurrentTask = currentId ? taskMap.get(currentId) : undefined;
  const currentTask = useMemo<QueueTask | undefined>(() => {
    if (!rawCurrentTask) return undefined;
    const override = versionOverrides[rawCurrentTask.id];
    if (override === undefined) return rawCurrentTask;
    return { ...rawCurrentTask, version: override };
  }, [rawCurrentTask, versionOverrides]);
  const atEnd = cursor >= totalCount;

  // Reconcile the cursor against the re-sliced list once a Done / Snooze
  // refresh lands (see pendingReconcileRef above). Re-pinning to the
  // advanced-to id's actual index means the reindex (the actioned row being
  // dropped and the rest shifting down) never skips the following task.
  useEffect(() => {
    const pending = pendingReconcileRef.current;
    if (!pending) return; // no reconcile pending
    // Wait until the actioned row has actually left the list. If it's still
    // present the refresh hasn't landed (or this was a Snooze that kept the
    // task in the active bucket) — in either case the optimistic advance
    // already left the cursor in the right place, so don't reconcile yet.
    if (taskIds.includes(pending.removedId)) return;
    pendingReconcileRef.current = null;
    if (pending.nextId === null) {
      // The actioned card was the last in the list — settle at the end.
      setCursor(totalCount);
      return;
    }
    const idx = taskIds.indexOf(pending.nextId);
    // If the pinned next card was itself removed by a concurrent change,
    // fall back to the actioned row's old position (clamped) so we resume at
    // the first surviving task rather than skipping ahead.
    setCursor(idx === -1 ? Math.min(cursor, totalCount) : idx);
  }, [taskIds, totalCount, cursor]);

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
    (newVersion: number) => {
      if (!currentId) return;
      setDoneIds((s) => {
        const next = new Set(s);
        next.add(currentId);
        return next;
      });
      setVersionOverrides((v) => ({ ...v, [currentId]: newVersion }));
      // The refresh removes the just-completed row and shifts the rest down
      // by one. Pin the card we're advancing TO so the post-refresh reconcile
      // lands the cursor on it; null nextId = we completed the last card.
      pendingReconcileRef.current = {
        removedId: currentId,
        nextId: taskIds[cursor + 1] ?? null,
      };
      advanceCursor();
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      router.refresh();
    },
    [currentId, cursor, taskIds, advanceCursor, queryClient, router],
  );

  // Direct Done call — used by both the keyboard handler (`D`) and a
  // belt-and-suspenders fallback. The visible Done toggle is the
  // canonical click path (TaskCompleteToggle owns OCC + toast), but the
  // keyboard shortcut calls the action here so we don't depend on a
  // DOM querySelector against the toggle's internal markup.
  //
  // If the current card is already completed (rep pressed ← back to a
  // task they finished earlier this session), `D` is a no-op-advance
  // rather than re-opening the task — pressing D on a done card means
  // "next", not "re-open".
  const triggerDone = useCallback(async () => {
    if (!currentTask || donePending) return;
    if (currentTask.status === "completed") {
      advanceCursor();
      return;
    }
    setDonePending(true);
    try {
      const res = await toggleTaskCompleteAction(
        currentTask.id,
        currentTask.version,
        currentTask.status !== "completed",
      );
      if (!res.ok) {
        toast.error(res.error, { duration: 10_000, dismissible: true });
        return;
      }
      handleDoneSuccess(res.data.version);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to complete task.";
      toast.error(message, { duration: 10_000, dismissible: true });
    } finally {
      setDonePending(false);
    }
  }, [currentTask, donePending, advanceCursor, handleDoneSuccess]);

  const handleSnooze = useCallback(
    async (targetUtc: Date) => {
      if (!currentTask || snoozePending) return;
      setSnoozePending(true);
      try {
        const res = await updateTaskAction({
          id: currentTask.id,
          version: currentTask.version,
          dueAt: targetUtc,
          source: "snooze",
        });
        if (!res.ok) {
          const message =
            res.code === "CONFLICT"
              ? "Task was changed elsewhere — refresh to see the latest."
              : res.error;
          toast.error(message, {
            duration: 10_000,
            dismissible: true,
          });
          return;
        }
        setSnoozedIds((s) => {
          const next = new Set(s);
          next.add(currentTask.id);
          return next;
        });
        setVersionOverrides((v) => ({ ...v, [currentTask.id]: res.data.version }));
        // Arm the post-refresh reconcile only when the new due date moves the
        // task out of the active bucket (it'll drop from the list and shift
        // the rest down). If the snoozed task still matches the bucket — or
        // we're in "all", which keeps every task — the row stays put and the
        // optimistic advance alone correctly steps past it; arming here would
        // leave a stale reconcile that could later mis-fire.
        const cls = classifyBucket(
          { ...currentTask, dueAt: targetUtc.toISOString() },
          now,
          timezone,
        );
        const staysInBucket =
          activeBucket === "all" ||
          (activeBucket === "overdue" && cls.overdue) ||
          (activeBucket === "today" && cls.today) ||
          (activeBucket === "week" && cls.week);
        if (!staysInBucket) {
          pendingReconcileRef.current = {
            removedId: currentTask.id,
            nextId: taskIds[cursor + 1] ?? null,
          };
        }
        advanceCursor();
        void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        router.refresh();
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to snooze task.";
        toast.error(message, {
          duration: 10_000,
          dismissible: true,
        });
      } finally {
        setSnoozePending(false);
      }
    },
    [
      currentTask,
      snoozePending,
      cursor,
      taskIds,
      activeBucket,
      now,
      timezone,
      advanceCursor,
      queryClient,
      router,
    ],
  );

  // Keyboard handler — D / S / Z / ← → / j k / Esc.
  // Suppression layers (each independent, all must pass to fire):
  //   - Modifier keys (Ctrl/Cmd/Alt/Shift) bypass shortcuts so they
  //     don't collide with browser/OS shortcuts.
  //   - Key auto-repeat (held key) ignored so holding D doesn't burst-
  //     fire the action against a stale version.
  //   - IME composition ignored (CJK / Japanese keyboards mid-compose).
  //   - INPUT / TEXTAREA / SELECT / contentEditable focused → ignored
  //     (Snooze custom-date picker stays usable).
  //   - Snooze popover open → only Escape fires (closes the popover).
  //     This is the Radix-Popover focus case: focus lands on a
  //     <button> inside the popover, which isn't a text input, so
  //     without an explicit popover-open guard a "D" inside the popover
  //     would synthesize Done on the underlying card.
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
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.repeat) return;
      if (e.isComposing) return;
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

      // While the snooze popover is open, swallow everything but Esc.
      if (snoozeOpen) return;

      if (atEnd) return;

      const k = e.key.toLowerCase();
      if (k === "d") {
        e.preventDefault();
        void triggerDone();
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
  }, [atEnd, snoozeOpen, triggerDone, handleSkip, handlePrev, handleNext, router]);

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
    // Wipe per-session state so a new walk-through starts cleanly with
    // whatever rows the server now returns; otherwise the cursor would
    // resume at `atEnd` even if the server now has unprocessed tasks.
    pendingReconcileRef.current = null;
    setCursor(0);
    setDoneIds(new Set());
    setSkippedIds(new Set());
    setSnoozedIds(new Set());
    setVersionOverrides({});
    router.refresh();
  }

  if (totalCount === 0) {
    return (
      <>
        <BucketTabs counts={counts} active={activeBucket} buildHref={buildBucketHref} />
        <StandardEmptyState
          title="No tasks in this bucket."
          description="Switch buckets above or return to the list."
        />
      </>
    );
  }

  if (atEnd) {
    const cappedProcessed = Math.min(processedCount, totalCount);
    return (
      <>
        <BucketTabs counts={counts} active={activeBucket} buildHref={buildBucketHref} />
        <StandardEmptyState
          title="Queue cleared."
          description={`Processed ${cappedProcessed} of ${totalCount} task${totalCount === 1 ? "" : "s"} (${doneIds.size} done, ${snoozedIds.size} snoozed, ${skippedIds.size} skipped).`}
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
            ·{" "}
            {Math.max(
              0,
              totalCount - Math.min(processedCount, totalCount),
            )}{" "}
            remaining {remainingLabel}
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

      <div
        data-queue-card
        className="mt-6 rounded-lg border border-border bg-card p-6 shadow-sm"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="pt-0.5">
              <TaskCompleteToggle
                task={{
                  id: currentTask.id,
                  title: currentTask.title,
                  version: currentTask.version,
                  status: currentTask.status,
                }}
                disabled={donePending}
                onSuccess={handleDoneSuccess}
                errorToastDuration={10_000}
              />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-foreground">
                {currentTask.title}
              </h2>
              <RichBody
                body={currentTask.description}
                className="mt-2 whitespace-pre-wrap text-sm text-foreground/80"
                containerClassName="mt-2"
              />
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

export function QueueClient(props: QueueClientProps) {
  return (
    <StandardErrorBoundary>
      <QueueClientInner {...props} />
    </StandardErrorBoundary>
  );
}
