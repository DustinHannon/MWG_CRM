import { redirect } from "next/navigation";
import { getPermissions, requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * Phase 19 — Marketing tab gate. Authenticated users without admin OR
 * canManageMarketing get bounced. Mirrors the Reports gate pattern.
 */
export default async function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canManageMarketing) {
    redirect("/dashboard");
  }
  return <>{children}</>;
}
