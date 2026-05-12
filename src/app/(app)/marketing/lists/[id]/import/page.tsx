import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, desc, eq, inArray } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader } from "@/components/standard";
import { db } from "@/db";
import { listImportRuns } from "@/db/schema/list-import-runs";
import { marketingLists } from "@/db/schema/marketing-lists";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";
import { StaticListImportClient } from "./_components/static-list-import-client";

export const dynamic = "force-dynamic";

/**
 * Static-list Excel import wizard.
 *
 * Access: admin OR `canMarketingListsImport` OR `canMarketingListsEdit`
 * OR the list's creator (for "edit own" semantics).
 *
 * Loads any in-progress (`status='previewing'`) run owned by the
 * current user so the wizard can offer a "Resume import" CTA.
 */
export default async function StaticListImportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireSession();

  const [list] = await db
    .select({
      id: marketingLists.id,
      name: marketingLists.name,
      listType: marketingLists.listType,
      createdById: marketingLists.createdById,
      isDeleted: marketingLists.isDeleted,
    })
    .from(marketingLists)
    .where(eq(marketingLists.id, id))
    .limit(1);
  if (!list || list.isDeleted) notFound();

  // Static-only — dynamic lists are populated by filter, not import.
  if (list.listType !== "static_imported") {
    redirect(`/marketing/lists/${id}`);
  }

  // Permission gate.
  const perms = await getPermissions(user.id);
  const isCreator = list.createdById === user.id;
  const allowed =
    user.isAdmin ||
    perms.canMarketingListsImport ||
    perms.canMarketingListsEdit ||
    perms.canManageMarketing ||
    isCreator;
  if (!allowed) {
    redirect(`/marketing/lists/${id}`);
  }

  // Look up the most-recent resumable run for this list owned by the
  // current user. Admins also see resumable runs belonging to others
  // so they can clean up stuck imports.
  const ownershipFilter = user.isAdmin
    ? undefined
    : eq(listImportRuns.userId, user.id);
  const [resumeRow] = await db
    .select({
      id: listImportRuns.id,
      filename: listImportRuns.filename,
      totalRows: listImportRuns.totalRows,
      successfulRows: listImportRuns.successfulRows,
      failedRows: listImportRuns.failedRows,
      needsReviewRows: listImportRuns.needsReviewRows,
    })
    .from(listImportRuns)
    .where(
      and(
        eq(listImportRuns.listId, id),
        inArray(listImportRuns.status, ["previewing"]),
        ownershipFilter,
      ),
    )
    .orderBy(desc(listImportRuns.createdAt))
    .limit(1);

  const resumable = resumeRow
    ? {
        id: resumeRow.id,
        fileName: resumeRow.filename,
        totalRows: resumeRow.totalRows,
        successfulRows: resumeRow.successfulRows,
        invalidRows: resumeRow.failedRows,
        duplicateRows: resumeRow.needsReviewRows,
      }
    : null;

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={marketingCrumbs.listsImport(list.name)} />
      <Link
        href={`/marketing/lists/${list.id}`}
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to list
      </Link>
      <StandardPageHeader
        kicker="Import"
        title={`Import recipients into ${list.name}`}
        description="Upload an .xlsx file with one row per recipient. Duplicate emails inside the file or already in this list are flagged and skipped."
      />

      <div className="flex gap-3">
        <a
          href={`/api/marketing/lists/${list.id}/import-template`}
          className="rounded-md border border-border bg-muted/40 px-4 py-2 text-sm text-foreground/90 transition hover:bg-muted"
        >
          Download template
        </a>
      </div>

      <StaticListImportClient listId={list.id} resumable={resumable} />
    </div>
  );
}
