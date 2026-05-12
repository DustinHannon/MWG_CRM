"use client";

import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";
import { GlassCard } from "@/components/ui/glass-card";

interface WelcomeClientProps {
  firstName: string;
}

/**
 * Phase 15 — first-login orientation card. No mutations, no client state;
 * the only reason this is a client component is so the lucide icon set
 * tree-shakes per the project's existing pattern (icons live in client
 * boundaries).
 */
export function WelcomeClient({ firstName }: WelcomeClientProps) {
  return (
    <div className="px-4 py-8 sm:px-6 sm:py-12 xl:px-10 xl:py-14">
      <div className="mx-auto max-w-4xl">
        <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground/80">
          First sign-in
        </p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight sm:text-4xl">
          Welcome to MWG CRM, {firstName}
        </h1>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground sm:text-base">
          Manage leads, accounts, contacts, opportunities, tasks, and reports.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <FeatureCard
            href="/leads"
            icon={<Users className="h-5 w-5" aria-hidden />}
            title="Leads"
            description="Prospects and pipeline."
          />
          <FeatureCard
            href="/reports"
            icon={<BarChart3 className="h-5 w-5" aria-hidden />}
            title="Reports"
            description="Pivot pipeline, activity, and outcome data."
          />
          <FeatureCard
            href="/settings"
            icon={<Settings className="h-5 w-5" aria-hidden />}
            title="Settings"
            description="Timezone, notifications, and Outlook integration."
          />
        </div>

        <GlassCard
          weight="2"
          className="mt-10 flex flex-col gap-4 p-6 sm:flex-row sm:items-start"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-muted/40 text-muted-foreground">
            <ShieldCheck className="h-5 w-5" aria-hidden />
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">
              Access level: Standard
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              View, create, and edit leads across the organization. Send
              email from lead detail pages. For imports, exports, or admin
              tooling, ask your manager or IT to grant additional
              permissions.
            </p>
          </div>
        </GlassCard>

        <div className="mt-10 flex flex-wrap items-center gap-3">
          <Link
            href="/leads"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90"
          >
            Get started
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
          <Link
            href="/settings"
            className="inline-flex items-center gap-2 rounded-md border border-border bg-muted/40 px-4 py-2 text-sm text-foreground/90 transition hover:bg-muted"
          >
            Set my preferences
          </Link>
        </div>
      </div>
    </div>
  );
}

function FeatureCard({
  href,
  icon,
  title,
  description,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Link href={href} className="group block">
      <GlassCard
        weight="2"
        interactive
        className="flex h-full flex-col gap-3 p-6"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-muted/40 text-foreground/80 transition group-hover:text-foreground">
            {icon}
          </div>
          <p className="text-sm font-medium text-foreground">{title}</p>
        </div>
        <p className="text-sm text-muted-foreground">{description}</p>
        <span className="mt-auto inline-flex items-center gap-1 text-xs text-muted-foreground transition group-hover:text-foreground">
          Open {title.toLowerCase()}
          <ArrowRight className="h-3 w-3" aria-hidden />
        </span>
      </GlassCard>
    </Link>
  );
}
