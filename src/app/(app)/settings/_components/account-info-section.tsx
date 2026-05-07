import { GlassCard } from "@/components/ui/glass-card";
import { UserTime } from "@/components/ui/user-time";

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
          <Row label="Sign-in method">
            {isBreakglass ? "Local (breakglass)" : "Microsoft Entra ID"}
          </Row>
          <Row label="Account created">
            <UserTime value={createdAt} />
          </Row>
          <Row label="Last login">
            <UserTime value={lastLoginAt} />
          </Row>
        </dl>
      </GlassCard>
    </section>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-foreground">{children}</dd>
    </div>
  );
}
