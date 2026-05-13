import { redirect } from "next/navigation";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { hasAnyMarketingView } from "@/lib/permissions/role-bundles";

export const dynamic = "force-dynamic";

/**
 * Marketing tab gate. Authenticated users without admin and with no
 * marketing view permission get bounced. Mirrors the Reports gate
 * pattern. Child pages enforce their own granular permission per
 * action.
 */
export default async function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !hasAnyMarketingView(perms)) {
    redirect("/dashboard");
  }
  return <>{children}</>;
}
