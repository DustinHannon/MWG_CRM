"use client";

import { Check } from "lucide-react";
import { signIn } from "next-auth/react";
import { useTransition } from "react";
import { toast } from "sonner";
import { GlassCard } from "@/components/ui/glass-card";
import { Pill } from "@/components/ui/pill";
import { disconnectGraphAction } from "../actions";

interface GraphConnectionSectionProps {
  isConnected: boolean;
  isBreakglass: boolean;
}

export function GraphConnectionSection({
  isConnected,
  isBreakglass,
}: GraphConnectionSectionProps) {
  const [pending, startTransition] = useTransition();

  function reconnect() {
    void signIn("microsoft-entra-id", { callbackUrl: "/settings" });
  }

  function disconnect() {
    if (!confirm("Disconnect Microsoft 365? Email and calendar features will be disabled until you reconnect.")) {
      return;
    }
    startTransition(async () => {
      const res = await disconnectGraphAction();
      if (res.ok) toast.success("Disconnected from Microsoft 365");
      else toast.error(res.error);
    });
  }

  if (isBreakglass) {
    return (
      <section id="m365" className="scroll-mt-10">
        <GlassCard className="p-6">
          <h2 className="text-lg font-semibold">Microsoft 365 connection</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The breakglass account does not connect to Microsoft 365.
            Email and calendar features are disabled.
          </p>
        </GlassCard>
      </section>
    );
  }

  return (
    <section id="m365" className="scroll-mt-10">
      <GlassCard className="p-6">
        <h2 className="text-lg font-semibold">Microsoft 365 connection</h2>
        <p className="mt-2 text-sm">
          {isConnected ? (
            <Pill variant="bg-primary/15 text-primary" className="gap-1">
              <Check className="h-3.5 w-3.5" aria-hidden />
              Connected
            </Pill>
          ) : (
            <Pill variant="bg-muted text-muted-foreground">Not connected</Pill>
          )}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {isConnected
            ? "Used for sending email, scheduling meetings, and the saved-search email digest."
            : "Connect to send email, schedule meetings, and receive the saved-search email digest."}
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={reconnect}
            disabled={pending}
            className="rounded-md border border-glass-border bg-input/60 px-3 py-1.5 text-sm hover:bg-accent/40 disabled:opacity-60"
          >
            {isConnected ? "Reconnect" : "Connect"}
          </button>
          {isConnected ? (
            <button
              type="button"
              onClick={disconnect}
              disabled={pending}
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/20 disabled:opacity-60"
            >
              Disconnect
            </button>
          ) : null}
        </div>
      </GlassCard>
    </section>
  );
}
