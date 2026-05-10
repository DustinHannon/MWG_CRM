"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Building2,
  Calendar,
  DownloadCloud,
  FileText,
  Mail,
  Phone,
  Sparkles,
  StickyNote,
  Users,
} from "lucide-react";
import { GlassCard } from "@/components/ui/glass-card";
import { quickPullAction } from "@/app/admin/d365-import/actions";
import { cn } from "@/lib/utils";
import type { D365EntityType } from "@/lib/d365/types";

/**
 * Phase 23 — Nine entity quick-pull buttons.
 *
 * Each card represents one D365 entity. Clicking "Pull next 100"
 * either creates a new run (default scope: modifiedSince=2 years ago)
 * or appends a new batch to the user's most recent open run for
 * that entity. The server action returns the runId; the client
 * navigates to /admin/d365-import/<runId>.
 */

interface EntityCardSpec {
  type: D365EntityType;
  label: string;
  description: string;
  icon: typeof DownloadCloud;
}

const ENTITIES: EntityCardSpec[] = [
  {
    type: "lead",
    label: "Leads",
    description: "Pre-qualified inbound contacts.",
    icon: Sparkles,
  },
  {
    type: "contact",
    label: "Contacts",
    description: "Individual person records.",
    icon: Users,
  },
  {
    type: "account",
    label: "Accounts",
    description: "Organisations / companies.",
    icon: Building2,
  },
  {
    type: "opportunity",
    label: "Opportunities",
    description: "Active + historical deals.",
    icon: DownloadCloud,
  },
  {
    type: "annotation",
    label: "Notes",
    description: "Annotations attached to any entity.",
    icon: StickyNote,
  },
  {
    type: "task",
    label: "Tasks",
    description: "Task activity records.",
    icon: FileText,
  },
  {
    type: "phonecall",
    label: "Phone Calls",
    description: "Phone-call activity records.",
    icon: Phone,
  },
  {
    type: "appointment",
    label: "Appointments",
    description: "Calendar appointments.",
    icon: Calendar,
  },
  {
    type: "email",
    label: "Emails",
    description: "Email activity records.",
    icon: Mail,
  },
];

export function QuickPullButtons({ disabled }: { disabled?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {ENTITIES.map((e) => (
        <QuickPullCard key={e.type} spec={e} disabled={disabled} />
      ))}
    </div>
  );
}

function QuickPullCard({
  spec,
  disabled,
}: {
  spec: EntityCardSpec;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const Icon = spec.icon;

  function onPull() {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("entityType", spec.type);
      const res = await quickPullAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push(`/admin/d365-import/${res.data.runId}`);
    });
  }

  return (
    <GlassCard className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Icon className="h-5 w-5 text-foreground" strokeWidth={1.5} />
        <h3 className="text-sm font-medium text-foreground">{spec.label}</h3>
      </div>
      <p className="text-xs text-muted-foreground">{spec.description}</p>
      <button
        type="button"
        onClick={onPull}
        disabled={disabled || pending}
        className={cn(
          "mt-auto rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60 disabled:opacity-50",
        )}
      >
        {pending ? "Pulling…" : "Pull next 100"}
      </button>
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </GlassCard>
  );
}
