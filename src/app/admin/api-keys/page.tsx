import Link from "next/link";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { adminCrumbs } from "@/lib/navigation/breadcrumbs";
import { requireAdmin } from "@/lib/auth-helpers";
import { ApiKeysListClient } from "./_components/api-keys-list-client";

export const dynamic = "force-dynamic";

/**
 * Admin-only management surface for Bearer-token API keys.
 *
 * Plaintext tokens are visible exactly once at generation time
 * (returned by the server action). The roster table never re-displays
 * plaintext.
 *
 * Audit-logged actions:
 *   api_key.create  — Generate
 *   api_key.revoke  — Revoke
 *   api_key.delete  — Delete with name confirmation
 */
export default async function AdminApiKeysPage() {
  await requireAdmin();

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={adminCrumbs.apiKeys()} />
      <ApiKeysListClient />
      <p className="text-xs text-muted-foreground">
        See the public{" "}
        <Link
          href="/apihelp"
          className="underline underline-offset-2 hover:text-foreground"
        >
          API documentation
        </Link>{" "}
        for endpoint shapes and scope semantics.
      </p>
    </div>
  );
}
