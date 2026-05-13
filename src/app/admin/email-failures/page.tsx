import { BreadcrumbsSetter } from "@/components/breadcrumbs/breadcrumbs-setter";
import { RetentionBanner } from "@/components/admin/retention-banner";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { adminCrumbs } from "@/lib/navigation/breadcrumbs";
import { requireAdmin } from "@/lib/auth-helpers";
import { listEmailFailureFacets } from "@/lib/email-failures-cursor";
import {
  EmailFailuresListClient,
  type EmailFailuresFilters,
} from "./_components/email-failures-list-client";

export const dynamic = "force-dynamic";

const RANGE_VALUES = ["24h", "7d", "30d", "90d"] as const;
type RangeValue = (typeof RANGE_VALUES)[number];

const RANGE_MS: Record<RangeValue, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

const STATUS_VALUES = ["all", "failed", "blocked_preflight"] as const;
type StatusFilter = (typeof STATUS_VALUES)[number];

function rangeToSince(range: RangeValue): Date {
  const now = new Date();
  return new Date(now.getTime() - RANGE_MS[range]);
}

interface EmailFailuresSearchParams {
  from?: string;
  status?: string;
  feature?: string;
  errorCode?: string;
  fromUser?: string;
}

export default async function EmailFailuresPage({
  searchParams,
}: {
  searchParams: Promise<EmailFailuresSearchParams>;
}) {
  await requireAdmin();
  const sp = await searchParams;

  const range: RangeValue = (RANGE_VALUES as readonly string[]).includes(
    sp.from ?? "",
  )
    ? (sp.from as RangeValue)
    : "7d";
  const statusFilter: StatusFilter = (STATUS_VALUES as readonly string[]).includes(
    sp.status ?? "",
  )
    ? (sp.status as StatusFilter)
    : "all";

  const since = rangeToSince(range);

  const [timePrefs, facets] = await Promise.all([
    getCurrentUserTimePrefs(),
    listEmailFailureFacets(since),
  ]);

  const initialFilters: EmailFailuresFilters = {
    range,
    status: statusFilter,
    feature: sp.feature ?? "",
    errorCode: sp.errorCode ?? "",
    fromUser: sp.fromUser ?? "",
  };

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={adminCrumbs.emailFailures()} />
      <RetentionBanner days={730} label="Email send log entries" />
      <EmailFailuresListClient
        timePrefs={timePrefs}
        features={facets.features}
        errorCodes={facets.errorCodes}
        senders={facets.senders}
        initialFilters={initialFilters}
      />
    </div>
  );
}
