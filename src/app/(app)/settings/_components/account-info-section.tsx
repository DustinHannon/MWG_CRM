import { GlassCard } from "@/components/ui/glass-card";

interface AccountInfoSectionProps {
  isBreakglass: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export function AccountInfoSection({
  isBreakglass,
  createdAt,
  lastLoginAt,
}: AccountInfoSectionProps) {
  return (
    <section id="account" className="scroll-mt-10">
      <GlassCard className="p-6">
        <h2 className="text-lg font-semibold">Account info</h2>
        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
          <Row
            label="Sign-in method"
            value={isBreakglass ? "Local (breakglass)" : "Microsoft Entra ID"}
          />
          <Row
            label="Account created"
            value={new Date(createdAt).toLocaleString()}
          />
          <Row
            label="Last login"
            value={lastLoginAt ? new Date(lastLoginAt).toLocaleString() : "—"}
          />
        </dl>
      </GlassCard>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-foreground">{value}</dd>
    </div>
  );
}
