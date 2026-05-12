import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { env, unlayerConfigured } from "@/lib/env";
import { getLock } from "@/lib/marketing/template-lock";
import { canEditTemplate, canViewTemplate } from "@/lib/marketing/templates";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";
import { TemplateEditor } from "./_components/template-editor";

export const dynamic = "force-dynamic";

/**
 * Phase 21 — Full template editor page. Server-component shell that
 * gates on permission and the soft-lock, then hands off to the
 * client `<TemplateEditor>` which mounts Unlayer and the lock hook.
 *
 * Phase 29 §4.3/4.4/4.5 — Visibility-aware:
 *   - A personal template that the user can't see returns 404.
 *   - The edit gate (creator-only for personal; creator OR
 *     canMarketingTemplatesEdit for global) is applied here; users
 *     without edit rights bounce back to the read-only detail page.
 */
export default async function EditTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canManageMarketing) {
    redirect("/dashboard");
  }
  const { id } = await params;

  const [row] = await db
    .select()
    .from(marketingTemplates)
    .where(
      and(
        eq(marketingTemplates.id, id),
        eq(marketingTemplates.isDeleted, false),
      ),
    )
    .limit(1);
  if (!row) notFound();

  // Phase 29 §4.4 — visibility 404. Don't leak existence of personal
  // templates the caller can't see.
  if (
    !canViewTemplate({
      template: { scope: row.scope, createdById: row.createdById },
      userId: user.id,
      isAdmin: user.isAdmin,
    })
  ) {
    notFound();
  }

  // Phase 29 §4.5 — edit gate. If the user can SEE but not EDIT, drop
  // them back at the read-only detail page rather than rendering an
  // editor that would 403 on save.
  if (
    !canEditTemplate({
      template: { scope: row.scope, createdById: row.createdById },
      userId: user.id,
      canMarketingTemplatesEdit: perms.canMarketingTemplatesEdit,
      isAdmin: user.isAdmin,
    })
  ) {
    redirect(`/marketing/templates/${row.id}`);
  }

  const initialLock = await getLock(row.id);
  const initiallyLockedByOther =
    initialLock !== null && initialLock.userId !== user.id;

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={marketingCrumbs.templatesEdit(row.name, row.id)}
      />

      <Link
        href={`/marketing/templates/${row.id}`}
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to template
      </Link>

      <TemplateEditor
        templateId={row.id}
        initialName={row.name}
        initialSubject={row.subject}
        initialPreheader={row.preheader ?? ""}
        initialDescription={row.description ?? ""}
        initialDesign={row.unlayerDesignJson}
        initialStatus={row.status}
        initialScope={row.scope}
        initialVersion={row.version}
        isCreator={row.createdById === user.id}
        canMarketingTemplatesEdit={perms.canMarketingTemplatesEdit}
        currentUserEmail={user.email}
        unlayerProjectId={env.NEXT_PUBLIC_UNLAYER_PROJECT_ID ?? null}
        unlayerConfigured={unlayerConfigured}
        isAdmin={user.isAdmin}
        initialLockedHolder={
          initiallyLockedByOther && initialLock
            ? {
                userId: initialLock.userId,
                userName: initialLock.userName,
                acquiredAt: initialLock.acquiredAt.toISOString(),
              }
            : null
        }
      />
    </div>
  );
}
