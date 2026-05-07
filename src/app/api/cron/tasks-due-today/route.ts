import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { listTasksDueTodayForCron } from "@/lib/tasks";
import { createNotifications } from "@/lib/notifications";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 3D — daily cron at 14:00 UTC (~8 AM Central winter / 9 AM summer).
 * Bearer-auth via CRON_SECRET. For each task due today (status open or
 * in_progress, assignee with notify_tasks_due=true) creates a 'task_due'
 * notification.
 */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.CRON_SECRET ?? ""}`;
  if (!env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

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
    console.error("[cron] tasks-due-today failed", err);
    return NextResponse.json(
      { ok: false, error: "Cron job failed" },
      { status: 500 },
    );
  }
}
