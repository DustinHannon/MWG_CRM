"use client";

import { signOut } from "next-auth/react";
import { useTransition } from "react";
import { toast } from "sonner";
import { GlassCard } from "@/components/ui/glass-card";
import { signOutEverywhereAction } from "../actions";

export function DangerZoneSection() {
  const [pending, startTransition] = useTransition();

  function signOutEverywhere() {
    if (
      !confirm(
        "Sign out of all devices? You will need to sign in again on this device too.",
      )
    ) {
      return;
    }
    startTransition(async () => {
      const res = await signOutEverywhereAction();
      if (res.ok) {
        toast.success("Signed out everywhere — redirecting…");
        await signOut({ callbackUrl: "/auth/signin" });
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <section id="danger" className="scroll-mt-10">
      <GlassCard className="border border-destructive/30 p-6">
        <h2 className="text-lg font-semibold text-destructive">Danger zone</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Destructive actions. They can&apos;t be undone.
        </p>

        <div className="mt-5 space-y-3">
          <ActionRow
            title="Sign out everywhere"
            description="Bumps your session version, kicking every device on its next request — including this one."
          >
            <button
              type="button"
              onClick={signOutEverywhere}
              disabled={pending}
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/20 disabled:opacity-60"
            >
              Sign out everywhere
            </button>
          </ActionRow>

          <ActionRow
            title="Sign out"
            description="End your session on this device only."
          >
            <button
              type="button"
              onClick={() => void signOut({ callbackUrl: "/auth/signin" })}
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/20"
            >
              Sign out
            </button>
          </ActionRow>
        </div>
      </GlassCard>
    </section>
  );
}

interface ActionRowProps {
  title: string;
  description: string;
  children: React.ReactNode;
}

function ActionRow({ title, description, children }: ActionRowProps) {
  return (
    <div className="flex flex-col items-start justify-between gap-3 rounded-lg border border-glass-border bg-input/30 p-3 sm:flex-row sm:items-center">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}
