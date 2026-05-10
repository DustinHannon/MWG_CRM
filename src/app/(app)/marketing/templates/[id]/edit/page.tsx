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
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";
import { TemplateEditor } from "./_components/template-editor";

export const dynamic = "force-dynamic";

/**
 * Phase 21 — Full template editor page. Server-component shell that
 * gates on permission and the soft-lock, then hands off to the
 * client `<TemplateEditor>` which mounts Unlayer and the lock hook.
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
