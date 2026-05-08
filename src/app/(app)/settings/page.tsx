import { eq } from "drizzle-orm";
import { db } from "@/db";
import { savedViews, userPreferences } from "@/db/schema/views";
import { users } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { GlassCard } from "@/components/ui/glass-card";
import { requireSession } from "@/lib/auth-helpers";
import { ProfileSection } from "./_components/profile-section";
import { PreferencesSection } from "./_components/preferences-section";
import { NotificationsSection } from "./_components/notifications-section";
import { GraphConnectionSection } from "./_components/graph-connection-section";
import { AccountInfoSection } from "./_components/account-info-section";
import { DangerZoneSection } from "./_components/danger-zone-section";

export const dynamic = "force-dynamic";

/**
 * /settings — Phase 3B. Six sections, two-column desktop layout (left
 * rail of anchors, scrolling right pane). All cards are glass weight 1.
 *
 * Profile section renders ENTRA-SYNCED FIELDS as disabled inputs with a
 * lock icon + tooltip saying "Synced from Microsoft Entra ID". They are
 * NEVER editable here; admins manage them via Microsoft 365.
 */
export default async function SettingsPage() {
  const session = await requireSession();

  const [profile] = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      displayName: users.displayName,
      email: users.email,
      username: users.username,
      photoBlobUrl: users.photoBlobUrl,
      isAdmin: users.isAdmin,
      isBreakglass: users.isBreakglass,
      jobTitle: users.jobTitle,
      department: users.department,
      officeLocation: users.officeLocation,
      businessPhones: users.businessPhones,
      mobilePhone: users.mobilePhone,
      country: users.country,
      managerDisplayName: users.managerDisplayName,
      managerEmail: users.managerEmail,
      entraSyncedAt: users.entraSyncedAt,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, session.id))
    .limit(1);

  const [prefs] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, session.id))
    .limit(1);

  const myViews = await db
    .select({
      id: savedViews.id,
      name: savedViews.name,
    })
    .from(savedViews)
    .where(eq(savedViews.userId, session.id));

  if (!profile) {
    return (
      <div className="px-10 py-10">
        <BreadcrumbsSetter crumbs={[{ label: "Settings" }]} />
        <p className="text-sm text-destructive">User profile not found.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-7xl gap-8 px-10 py-10">
      <BreadcrumbsSetter crumbs={[{ label: "Settings" }]} />
      {/* Left rail */}
      <aside className="sticky top-10 hidden h-[calc(100vh-5rem)] w-48 shrink-0 lg:block">
        <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
          Settings
        </p>
        <h1 className="mt-1 text-2xl font-semibold font-display">
          {profile.displayName.split(" ")[0]}&apos;s preferences
        </h1>
        <nav className="mt-6 flex flex-col gap-1 text-sm">
          <a href="#profile" className="rounded px-2 py-1.5 text-muted-foreground hover:bg-accent/40 hover:text-foreground">
            Profile
          </a>
          <a href="#preferences" className="rounded px-2 py-1.5 text-muted-foreground hover:bg-accent/40 hover:text-foreground">
            Preferences
          </a>
          <a href="#notifications" className="rounded px-2 py-1.5 text-muted-foreground hover:bg-accent/40 hover:text-foreground">
            Notifications
          </a>
          <a href="#m365" className="rounded px-2 py-1.5 text-muted-foreground hover:bg-accent/40 hover:text-foreground">
            Microsoft 365
          </a>
          <a href="#account" className="rounded px-2 py-1.5 text-muted-foreground hover:bg-accent/40 hover:text-foreground">
            Account
          </a>
          <a href="#danger" className="rounded px-2 py-1.5 text-destructive/80 hover:bg-destructive/10 hover:text-destructive">
            Danger zone
          </a>
        </nav>
      </aside>

      {/* Right pane */}
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        <div className="lg:hidden">
          <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Settings
          </p>
          <h1 className="mt-1 text-2xl font-semibold font-display">
            {profile.displayName.split(" ")[0]}&apos;s preferences
          </h1>
        </div>

        <ProfileSection profile={profile} />
        <PreferencesSection
          prefs={prefs ?? null}
          savedViews={myViews}
        />
        <NotificationsSection prefs={prefs ?? null} />
        <GraphConnectionSection
          userId={session.id}
          isBreakglass={profile.isBreakglass}
        />
        <AccountInfoSection
          isBreakglass={profile.isBreakglass}
          createdAt={profile.createdAt}
          lastLoginAt={profile.lastLoginAt}
        />
        <DangerZoneSection />
      </div>
    </div>
  );
}

// Re-export GlassCard so children using `import { GlassCard } from "../page"`
// resolve cleanly. (Children import from the canonical path instead.)
export { GlassCard };
