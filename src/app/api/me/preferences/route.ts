import { NextResponse } from "next/server";
import { z } from "zod";
import { updatePreferencesAction } from "@/app/(app)/settings/actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 13 — narrow PATCH endpoint dedicated to client-side prefs
 * toggles like the sidebar collapse switch. The settings page uses
 * the full server action via form post; the sidebar needs a JSON
 * fetch that doesn't navigate. Both paths funnel through
 * updatePreferencesAction so OCC, validation, and audit stay shared.
 */

const SidebarPatchSchema = z.object({
  sidebar_collapsed: z.boolean().optional(),
});

export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = SidebarPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "Invalid body",
        details: parsed.error.errors.map((e) => ({
          field: e.path.join("."),
          issue: e.message,
        })),
      },
      { status: 422 },
    );
  }

  const result = await updatePreferencesAction({
    sidebarCollapsed: parsed.data.sidebar_collapsed,
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true });
}
