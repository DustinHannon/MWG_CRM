import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import {
  acquireLock,
  heartbeat,
  releaseLock,
} from "@/lib/marketing/template-lock";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Template soft-lock endpoints. Session-authenticated; the
 * client lives inside the marketing UI and sends `{ sessionId }` in
 * the body for every method.
 *
 * POST acquire (or refresh own lock) 200 / 409
 * PUT heartbeat 200 / 410
 * DELETE release 204
 *
 * 409 returns `{ holder: { userId, userName, acquiredAt } }` so the
 * banner can render who's editing.
 */

const bodySchema = z.object({
  sessionId: z.string().min(1).max(200),
});

const idSchema = z.string().uuid();

async function authorize(templateId: string): Promise<
  | { ok: true; userId: string; templateId: string }
  | { ok: false; response: NextResponse }
> {
  const idCheck = idSchema.safeParse(templateId);
  if (!idCheck.success) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Invalid template id." },
        { status: 400 },
      ),
    };
  }

  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canMarketingTemplatesEdit) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden." }, { status: 403 }),
    };
  }

  const [tpl] = await db
    .select({ id: marketingTemplates.id })
    .from(marketingTemplates)
    .where(
      and(
        eq(marketingTemplates.id, idCheck.data),
        eq(marketingTemplates.isDeleted, false),
      ),
    )
    .limit(1);
  if (!tpl) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Template not found." },
        { status: 404 },
      ),
    };
  }
  return { ok: true, userId: user.id, templateId: idCheck.data };
}

async function parseBody(req: Request): Promise<
  | { ok: true; sessionId: string }
  | { ok: false; response: NextResponse }
> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400 },
      ),
    };
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "sessionId required." },
        { status: 400 },
      ),
    };
  }
  return { ok: true, sessionId: parsed.data.sessionId };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await authorize(id);
  if (!auth.ok) return auth.response;
  const body = await parseBody(req);
  if (!body.ok) return body.response;

  const result = await acquireLock(auth.templateId, auth.userId, body.sessionId);
  if (!result.acquired) {
    return NextResponse.json(
      {
        holder: {
          userId: result.lockedBy.userId,
          userName: result.lockedBy.userName,
          acquiredAt: result.lockedBy.acquiredAt.toISOString(),
        },
      },
      { status: 409 },
    );
  }
  return NextResponse.json({
    ok: true,
    holder: {
      userId: result.lock.userId,
      userName: result.lock.userName,
      acquiredAt: result.lock.acquiredAt.toISOString(),
    },
  });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await authorize(id);
  if (!auth.ok) return auth.response;
  const body = await parseBody(req);
  if (!body.ok) return body.response;

  const result = await heartbeat(auth.templateId, auth.userId, body.sessionId);
  if (!result.ok) {
    // The heartbeat caller no longer holds the lock — likely
    // force-unlocked by an admin. Tell the client to refresh.
    return NextResponse.json({ error: "Lock lost." }, { status: 410 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await authorize(id);
  if (!auth.ok) return auth.response;
  const body = await parseBody(req);
  if (!body.ok) return body.response;

  await releaseLock(auth.templateId, auth.userId, body.sessionId);
  return new NextResponse(null, { status: 204 });
}
