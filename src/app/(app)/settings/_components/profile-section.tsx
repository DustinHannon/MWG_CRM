"use client";

import { Lock } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { GlassCard } from "@/components/ui/glass-card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ProfileData {
  id: string;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  username: string;
  photoBlobUrl: string | null;
  isAdmin: boolean;
  isBreakglass: boolean;
  jobTitle: string | null;
  department: string | null;
  officeLocation: string | null;
  businessPhones: string[];
  mobilePhone: string | null;
  country: string | null;
  managerDisplayName: string | null;
  managerEmail: string | null;
}

const TOOLTIP_COPY =
  "Synced from Microsoft Entra ID. To change this, update your profile in Microsoft 365 or contact IT.";

/**
 * Profile section — every Entra-synced field is rendered as a DISABLED
 * input with reduced opacity, a lock icon at the right edge, and a
 * tooltip pointing the user at Microsoft 365 to make changes.
 */
export function ProfileSection({ profile }: { profile: ProfileData }) {
  const role = profile.isBreakglass
    ? "Breakglass"
    : profile.isAdmin
      ? "Admin"
      : "User";

  return (
    <section id="profile" className="scroll-mt-10">
      <GlassCard className="p-6">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Profile</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              These details come from Microsoft Entra ID. Update them in your
              Microsoft 365 profile to change them here.
            </p>
          </div>
          <Avatar
            src={profile.photoBlobUrl}
            name={profile.displayName}
            id={profile.id}
            size={64}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <ReadOnlyField label="First name" value={profile.firstName} />
          <ReadOnlyField label="Last name" value={profile.lastName} />
          <ReadOnlyField label="Display name" value={profile.displayName} />
          <ReadOnlyField label="Email" value={profile.email} />
          <ReadOnlyField label="Username" value={profile.username} />
          <ReadOnlyField label="Job title" value={profile.jobTitle} />
          <ReadOnlyField label="Department" value={profile.department} />
          <ReadOnlyField label="Office location" value={profile.officeLocation} />
          <ReadOnlyField
            label="Business phone"
            value={profile.businessPhones?.[0] ?? null}
          />
          <ReadOnlyField label="Mobile phone" value={profile.mobilePhone} />
          <ReadOnlyField label="Country" value={profile.country} />
          <ReadOnlyField
            label="Manager"
            value={
              profile.managerDisplayName
                ? `${profile.managerDisplayName}${profile.managerEmail ? ` <${profile.managerEmail}>` : ""}`
                : null
            }
            mailto={profile.managerEmail ?? undefined}
          />
          <ReadOnlyField label="Role" value={role} variant="badge" />
        </div>
      </GlassCard>
    </section>
  );
}

interface ReadOnlyFieldProps {
  label: string;
  value: string | null;
  mailto?: string;
  variant?: "input" | "badge";
}

function ReadOnlyField({ label, value, mailto, variant = "input" }: ReadOnlyFieldProps) {
  return (
    <div>
      <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="relative mt-1.5">
            {variant === "badge" ? (
              <span className="flex h-9 w-fit cursor-not-allowed select-none items-center gap-2 rounded-md border border-glass-border bg-input/50 px-3 text-xs font-medium uppercase tracking-wide text-foreground/80 opacity-60">
                {value}
                <Lock size={12} aria-hidden />
              </span>
            ) : (
              <div
                className="flex h-9 cursor-not-allowed select-none items-center gap-2 rounded-md border border-glass-border bg-input/50 pl-3 pr-9 text-sm text-foreground/80 opacity-60"
                aria-disabled
              >
                {mailto && value ? (
                  <a
                    href={`mailto:${mailto}`}
                    onClick={(e) => e.stopPropagation()}
                    className="pointer-events-auto truncate hover:underline"
                  >
                    {value}
                  </a>
                ) : (
                  <span className="truncate">
                    {value ?? <span className="italic text-muted-foreground/70">Not set in Microsoft Entra</span>}
                  </span>
                )}
              </div>
            )}
            {variant === "input" ? (
              <Lock
                size={14}
                aria-hidden
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/70"
              />
            ) : null}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top">{TOOLTIP_COPY}</TooltipContent>
      </Tooltip>
    </div>
  );
}
