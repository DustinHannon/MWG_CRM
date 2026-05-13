import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { RetentionBanner } from "@/components/admin/retention-banner";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { adminCrumbs } from "@/lib/navigation/breadcrumbs";
import { requireAdmin } from "@/lib/auth-helpers";
import { listApiKeysForFilter } from "@/lib/api-usage-cursor";
import {
  ApiUsageListClient,
  type ApiUsageFilters,
} from "./_components/api-usage-list-client";

export const dynamic = "force-dynamic";

interface ApiUsageSearchParams {
  q?: string;
  method?: string;
  path?: string;
  status?: string | string[];
  api_key_id?: string | string[];
  created_at_gte?: string;
  created_at_lte?: string;
}

function isoDateOnly(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

function parseList(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.flatMap((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export default async function ApiUsageLogPage({
  searchParams,
}: {
  searchParams: Promise<ApiUsageSearchParams>;
}) {
  await requireAdmin();
  const sp = await searchParams;

  // Default range is the last 7 days when nothing is supplied. The
  // export URL needs the same defaults to round-trip cleanly.
  const defaultGte = isoDateOnly(daysAgo(7));
  const defaultLte = isoDateOnly(new Date());

  const initialFilters: ApiUsageFilters = {
    q: sp.q ?? "",
    method: sp.method ?? "",
    path: sp.path ?? "",
    apiKeyId: parseList(sp.api_key_id)[0] ?? "",
    statusBuckets: parseList(sp.status).filter((s) =>
      ["2xx", "3xx", "4xx", "5xx"].includes(s),
    ),
    from: sp.created_at_gte ?? defaultGte,
    to: sp.created_at_lte ?? defaultLte,
  };

  const [timePrefs, apiKeyRows] = await Promise.all([
    getCurrentUserTimePrefs(),
    listApiKeysForFilter(),
  ]);

  const apiKeyOptions = apiKeyRows.map((k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    revoked: Boolean(k.revokedAt),
  }));

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={adminCrumbs.apiUsage()} />
      <RetentionBanner days={730} label="API usage logs" />
      <ApiUsageListClient
        timePrefs={timePrefs}
        apiKeyOptions={apiKeyOptions}
        initialFilters={initialFilters}
      />
    </div>
  );
}
