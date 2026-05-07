import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/db";
import { userPreferences } from "@/db/schema/views";

export const dynamic = "force-dynamic";

/**
 * Phase 5A — apply the user's default landing preference. Resolution
 * order:
 *   1. user_preferences.default_landing_page (one of the named choices)
 *   2. If choice is "/custom", use user_preferences.custom_landing_path
 *   3. Fallback to /dashboard
 *
 * The custom-path Zod allowlist on the settings server action already
 * narrows /custom destinations to /(dashboard|leads|opportunities|
 * accounts|contacts|tasks)(\?.*)?$, so we don't need a second pass here.
 * As a defensive belt: anything that doesn't start with `/` falls back.
 */
export default async function Home() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/auth/signin");
  }

  const [prefs] = await db
    .select({
      defaultLandingPage: userPreferences.defaultLandingPage,
      customLandingPath: userPreferences.customLandingPath,
    })
    .from(userPreferences)
    .where(eq(userPreferences.userId, session.user.id))
    .limit(1);

  let target = "/dashboard";
  if (prefs?.defaultLandingPage === "/custom") {
    if (prefs.customLandingPath?.startsWith("/")) {
      target = prefs.customLandingPath;
    }
  } else if (prefs?.defaultLandingPage?.startsWith("/")) {
    target = prefs.defaultLandingPage;
  }
  redirect(target);
}
