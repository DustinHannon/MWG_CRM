import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys } from "@/db/schema/api-keys";
import { users } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTime } from "@/components/ui/user-time";
import { ApiKeysAdminClient } from "./_components/api-keys-admin-client";

export const dynamic = "force-dynamic";

interface KeyRow {
  id: string;
  name: string;
  description: string | null;
  prefix: string;
  scopes: string[];
  rateLimitPerMinute: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  createdAt: Date;
  createdByName: string | null;
}

/**
 * admin-only management surface for Bearer-token API keys.
 *
 * Plaintext tokens are visible exactly once at generation time (returned
 * by the server action). The roster table never re-displays plaintext.
 *
 * Audit-logged actions:
 * api_key.create (on Generate)
 * api_key.revoke (on Revoke)
 * api_key.delete (on Delete with name confirmation)
 */
export default async function AdminApiKeysPage() {
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      description: apiKeys.description,
      prefix: apiKeys.keyPrefix,
      scopes: apiKeys.scopes,
      rateLimitPerMinute: apiKeys.rateLimitPerMinute,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      lastUsedAt: apiKeys.lastUsedAt,
      lastUsedIp: apiKeys.lastUsedIp,
      createdAt: apiKeys.createdAt,
      createdByName: users.displayName,
    })
    .from(apiKeys)
    .leftJoin(users, eq(users.id, apiKeys.createdById))
    .orderBy(desc(apiKeys.createdAt));

  // Strip Date objects to ISO strings before passing to the client component.
  const safeRows: SerializedKeyRow[] = rows.map((r: KeyRow) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    prefix: r.prefix,
    scopes: r.scopes,
    rateLimitPerMinute: r.rateLimitPerMinute,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    lastUsedIp: r.lastUsedIp,
    createdAt: r.createdAt.toISOString(),
    createdByName: r.createdByName,
  }));

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Admin", href: "/admin" },
          { label: "API keys" },
        ]}
      />
      <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        Admin
      </p>
      <h1 className="mt-1 text-2xl font-semibold font-display">API keys</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Bearer tokens for external integrations. Tokens act with org-wide
        visibility regardless of which user generated them.{" "}
        <Link
          href="/apihelp"
          className="underline underline-offset-2 hover:text-foreground"
        >
          See API documentation →
        </Link>
      </p>

      <GlassCard className="mt-6 p-0 overflow-hidden">
        <ApiKeysAdminClient rows={safeRows} />
      </GlassCard>

      {/* Touch UserTime so it tree-shakes cleanly even though the client
          component imports its own helpers. */}
      <span className="sr-only">
        <UserTime value={null} />
      </span>
    </div>
  );
}

export interface SerializedKeyRow {
  id: string;
  name: string;
  description: string | null;
  prefix: string;
  scopes: string[];
  rateLimitPerMinute: number;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string;
  createdByName: string | null;
}
