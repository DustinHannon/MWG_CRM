import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { marketingLists } from "@/db/schema/marketing-lists";
import { users } from "@/db/schema/users";
import { UserTime } from "@/components/ui/user-time";

export const dynamic = "force-dynamic";

export default async function ListDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [row] = await db
    .select({
      id: marketingLists.id,
      name: marketingLists.name,
      description: marketingLists.description,
      memberCount: marketingLists.memberCount,
      lastRefreshedAt: marketingLists.lastRefreshedAt,
      filterDsl: marketingLists.filterDsl,
      updatedAt: marketingLists.updatedAt,
      createdByName: users.displayName,
    })
    .from(marketingLists)
    .leftJoin(users, eq(users.id, marketingLists.createdById))
    .where(eq(marketingLists.id, id))
    .limit(1);

  if (!row) notFound();

  return (
    <div className="flex flex-col gap-6 p-6">
      <Link
        href="/marketing/lists"
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to lists
      </Link>
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{row.name}</h1>
        {row.description ? (
          <p className="mt-1 text-sm text-muted-foreground">{row.description}</p>
        ) : null}
      </div>
      <dl className="grid grid-cols-1 gap-4 rounded-lg border border-border bg-card p-5 sm:grid-cols-3">
        <div>
          <dt className="text-xs uppercase tracking-[0.05em] text-muted-foreground">
            Members
          </dt>
          <dd className="mt-1 text-sm font-medium text-foreground">
            {row.memberCount.toLocaleString()}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-[0.05em] text-muted-foreground">
            Last refreshed
          </dt>
          <dd className="mt-1 text-sm text-foreground">
            {row.lastRefreshedAt ? (
              <UserTime value={row.lastRefreshedAt} />
            ) : (
              "Never"
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-[0.05em] text-muted-foreground">
            Created by
          </dt>
          <dd className="mt-1 text-sm text-foreground">
            {row.createdByName ?? "—"}
          </dd>
        </div>
      </dl>
      <div className="rounded-lg border border-border bg-card p-5">
        <p className="mb-3 text-xs uppercase tracking-[0.05em] text-muted-foreground">
          Filter
        </p>
        <pre className="overflow-x-auto rounded bg-muted p-3 text-xs text-foreground">
          {JSON.stringify(row.filterDsl, null, 2)}
        </pre>
      </div>
    </div>
  );
}
