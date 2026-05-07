import { entraConfigured, env, MWG_TENANT_ID } from "@/lib/env";

export const dynamic = "force-dynamic";

export default function AdminSettingsPage() {
  return (
    <div className="px-10 py-10">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Read-only view of the deployed configuration. Edit via Vercel
        environment variables and redeploy.
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card title="Identity">
          <Row label="App name" value={env.APP_NAME} />
          <Row label="Default timezone" value={env.DEFAULT_TIMEZONE} />
          <Row label="Tenant ID" value={MWG_TENANT_ID} mono />
        </Card>

        <Card title="Allowed email domains">
          <ul className="flex flex-wrap gap-2">
            {env.ALLOWED_EMAIL_DOMAINS.map((d) => (
              <li
                key={d}
                className="rounded-full border border-border bg-muted/40 px-3 py-1 text-xs text-foreground/80"
              >
                {d}
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Microsoft Entra (SSO)">
          <Row
            label="Status"
            value={entraConfigured ? "Configured" : "Pending — set env vars"}
            tone={entraConfigured ? "ok" : "warn"}
          />
          <Row
            label="Issuer"
            value={env.AUTH_MICROSOFT_ENTRA_ID_ISSUER ?? "—"}
            mono
          />
          <Row
            label="Client ID"
            value={
              env.AUTH_MICROSOFT_ENTRA_ID_ID
                ? `${env.AUTH_MICROSOFT_ENTRA_ID_ID.slice(0, 6)}…${env.AUTH_MICROSOFT_ENTRA_ID_ID.slice(-4)}`
                : "—"
            }
            mono
          />
        </Card>

        <Card title="Storage">
          <Row
            label="Vercel Blob"
            value={env.BLOB_READ_WRITE_TOKEN ? "Connected" : "Not configured"}
            tone={env.BLOB_READ_WRITE_TOKEN ? "ok" : "warn"}
          />
          <Row
            label="Postgres"
            value="Connected via Supabase pooler"
            tone="ok"
          />
        </Card>
      </div>
    </div>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-muted/40 p-6 backdrop-blur-xl">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="mt-4 flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Row({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "ok" | "warn";
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={`text-sm ${mono ? "font-mono text-xs" : ""} ${
          tone === "ok"
            ? "text-emerald-700 dark:text-emerald-200"
            : tone === "warn"
              ? "text-amber-700 dark:text-amber-200"
              : "text-foreground/90"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
