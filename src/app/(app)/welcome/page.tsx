import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { requireSession } from "@/lib/auth-helpers";
import { WelcomeClient } from "./welcome-client";

export const dynamic = "force-dynamic";

/**
 * JIT first-login welcome screen.
 *
 * Self-gating: rather than wiring a "first login" flag through the JWT, we
 * read users.first_login_at directly. If it's outside the 5-minute window
 * we silently redirect to /leads. Otherwise we render a one-time
 * orientation card.
 *
 * The 5-minute window is deliberately wider than necessary — it forgives
 * a slow first session (auth → consent → provisioning → photo refresh)
 * while still preventing /welcome from showing up days later if the user
 * bookmarks the URL.
 *
 * The window comparison runs in Postgres (`first_login_at > now() - 5m`)
 * rather than in JS, which sidesteps the `react-hooks/purity` lint that
 * fires on `Date.now()` inside server components. Same correctness, no
 * impure call in render.
 */

export default async function WelcomePage() {
  const session = await requireSession();

  const [row] = await db
    .select({
      firstName: users.firstName,
      displayName: users.displayName,
      withinFirstLoginWindow: sql<boolean>`(${users.firstLoginAt} IS NOT NULL AND ${users.firstLoginAt} > now() - interval '5 minutes')`,
    })
    .from(users)
    .where(eq(users.id, session.id))
    .limit(1);

  if (!row || !row.withinFirstLoginWindow) {
    redirect("/leads");
  }

  // Prefer the explicit first name; fall back to the leading token of
  // displayName so we never render "Welcome, ".
  const firstName =
    row.firstName?.trim() ||
    row.displayName.split(" ")[0]?.trim() ||
    "there";

  return (
    <>
      <BreadcrumbsSetter crumbs={[{ label: "Welcome" }]} />
      <WelcomeClient firstName={firstName} />
    </>
  );
}
