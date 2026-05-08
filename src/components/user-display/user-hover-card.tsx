import Link from "next/link";
import { Briefcase, Building2, ListChecks, Mail, Sparkles } from "lucide-react";
import { UserAvatar } from "./user-avatar";
import { getUserProfileSummary } from "@/lib/user-profile";

interface UserHoverCardProps {
  userId: string;
}

/**
 * Phase 9B — hover-card body shown when a UserChip is hovered. Server
 * component: fetched on demand, in-process cached for 60s in
 * getUserProfileSummary, so dozens of chips on one page issue at most
 * one DB hit per user during the cache window.
 *
 * Auth: caller's parent layout already gated `requireSession`. Any
 * signed-in user can see another user's basic profile per the brief.
 */
export async function UserHoverCard({ userId }: UserHoverCardProps) {
  const summary = await getUserProfileSummary(userId);
  if (!summary) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        User not found.
      </div>
    );
  }
  const { user, stats } = summary;
  return (
    <div className="flex flex-col gap-3 p-4 text-sm">
      <div className="flex items-start gap-3">
        <UserAvatar user={user} size="md" />
        <div className="min-w-0 flex-1">
          <Link
            href={`/users/${user.id}`}
            className="block truncate text-sm font-semibold leading-tight hover:underline"
          >
            {user.displayName}
          </Link>
          {user.jobTitle ? (
            <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
              <Briefcase size={11} aria-hidden />
              <span className="truncate">{user.jobTitle}</span>
            </p>
          ) : null}
          {user.department ? (
            <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
              <Building2 size={11} aria-hidden />
              <span className="truncate">{user.department}</span>
            </p>
          ) : null}
          {!user.isActive ? (
            <span className="mt-1 inline-block rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-100">
              Deactivated
            </span>
          ) : null}
        </div>
      </div>

      <a
        href={`mailto:${user.email}`}
        className="flex items-center gap-1.5 truncate text-xs text-muted-foreground hover:text-foreground hover:underline"
      >
        <Mail size={11} aria-hidden />
        <span className="truncate">{user.email}</span>
      </a>

      <div className="grid grid-cols-2 gap-2 border-t border-glass-border pt-3 text-xs">
        <Stat
          icon={<ListChecks size={12} aria-hidden />}
          label="Open leads"
          value={stats.openLeads}
        />
        <Stat
          icon={<Sparkles size={12} aria-hidden />}
          label="Open opps"
          value={stats.openOpportunities}
        />
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-muted/40 px-2.5 py-1.5">
      <span className="text-muted-foreground">{icon}</span>
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="mt-0.5 font-semibold tabular-nums text-foreground">
          {value}
        </p>
      </div>
    </div>
  );
}
