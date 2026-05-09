import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";
import { listTasksDueTodayForCron } from "@/lib/tasks";
import { createNotifications } from "@/lib/notifications";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Phase 3D — daily cron at 14:00 UTC (~8 AM Central winter / 9 AM summer).
 * Bearer-auth via CRON_SECRET. For each task due today (status open or
 * in_progress, assignee with notify_tasks_due=true) creates a 'task_due'
 * notification.
 */
export async function GET(req: Request) {
  const unauth = requireCronAuth(req);
  if (unauth) return unauth;

  try {
    const tasks = await listTasksDueTodayForCron();
    if (tasks.length === 0) {
      return NextResponse.json({ ok: true, processed: 0 });
    }

    await createNotifications(
      tasks.map((t) => ({
        userId: t.assignedToId,
        kind: "task_due" as const,
        title: `Due today: ${t.title}`,
        link: t.leadId ? `/leads/${t.leadId}` : "/tasks",
      })),
    );

    return NextResponse.json({ ok: true, processed: tasks.length });
  } catch (err) {
    logger.error("cron.tasks_due_today_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "Cron job failed" },
      { status: 500 },
    );
  }
}
