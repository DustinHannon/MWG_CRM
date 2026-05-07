import Link from "next/link";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import {
  LEAD_RATINGS,
  LEAD_SOURCES,
  LEAD_STATUSES,
  listLeads,
} from "@/lib/leads";

export const dynamic = "force-dynamic";

interface SearchParams {
  q?: string;
  status?: string;
  rating?: string;
  source?: string;
  tag?: string;
  page?: string;
  sort?: string;
  dir?: string;
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireSession();
  const sp = await searchParams;
  const perms = await getPermissions(user.id);

  const result = await listLeads(user, sp, perms.canViewAllLeads);

  return (
    <div className="px-10 py-10">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Leads</h1>
          <p className="mt-2 text-sm text-white/60">
            {result.total} {result.total === 1 ? "lead" : "leads"}
            {sp.q ? ` matching "${sp.q}"` : ""}.
          </p>
        </div>
        <div className="flex gap-2">
          {perms.canImport || user.isAdmin ? (
            <Link
              href="/leads/import"
              className="rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white/80 transition hover:bg-white/10"
            >
              Import
            </Link>
          ) : null}
          {perms.canExport || user.isAdmin ? (
            <a
              href={`/api/leads/export?${new URLSearchParams(
                Object.entries(sp).filter(([, v]) => Boolean(v)) as [string, string][],
              ).toString()}`}
              className="rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white/80 transition hover:bg-white/10"
            >
              Export
            </a>
          ) : null}
          {perms.canCreateLeads || user.isAdmin ? (
            <Link
              href="/leads/new"
              className="rounded-md bg-white/90 px-4 py-2 text-sm font-medium text-slate-900 transition hover:bg-white"
            >
              + Add lead
            </Link>
          ) : null}
        </div>
      </div>

      <form className="mt-6 flex flex-wrap gap-3">
        <input
          name="q"
          defaultValue={sp.q ?? ""}
          placeholder="Search name / email / company / phone…"
          className="min-w-[280px] flex-1 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-white/30 focus:outline-none focus:ring-2 focus:ring-white/20"
        />
        <FilterSelect
          name="status"
          defaultValue={sp.status}
          options={LEAD_STATUSES}
          placeholder="Status"
        />
        <FilterSelect
          name="rating"
          defaultValue={sp.rating}
          options={LEAD_RATINGS}
          placeholder="Rating"
        />
        <FilterSelect
          name="source"
          defaultValue={sp.source}
          options={LEAD_SOURCES}
          placeholder="Source"
        />
        <button
          type="submit"
          className="rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white/80 transition hover:bg-white/10"
        >
          Apply
        </button>
        {(sp.q || sp.status || sp.rating || sp.source || sp.tag) ? (
          <Link
            href="/leads"
            className="rounded-md px-3 py-2 text-sm text-white/50 hover:text-white/80"
          >
            Clear
          </Link>
        ) : null}
      </form>

      <div className="mt-8 overflow-hidden rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl">
        <table className="min-w-full divide-y divide-white/5 text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-white/50">
              <th className="px-5 py-3 font-medium">Name</th>
              <th className="px-5 py-3 font-medium">Company</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Rating</th>
              <th className="px-5 py-3 font-medium">Owner</th>
              <th className="px-5 py-3 font-medium">Last activity</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {result.rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-5 py-12 text-center text-white/50">
                  No leads yet. Add your first one to get started.
                </td>
              </tr>
            ) : null}
            {result.rows.map((l) => (
              <tr key={l.id} className="transition hover:bg-white/5">
                <td className="px-5 py-3">
                  <Link
                    href={`/leads/${l.id}`}
                    className="font-medium text-white hover:underline"
                  >
                    {l.firstName} {l.lastName}
                  </Link>
                  <div className="text-xs text-white/40">{l.email ?? "—"}</div>
                </td>
                <td className="px-5 py-3 text-white/70">{l.companyName ?? "—"}</td>
                <td className="px-5 py-3">
                  <StatusPill value={l.status} />
                </td>
                <td className="px-5 py-3">
                  <RatingPill value={l.rating} />
                </td>
                <td className="px-5 py-3 text-white/60">
                  {l.ownerDisplayName ?? "Unassigned"}
                </td>
                <td className="px-5 py-3 text-white/50">
                  {l.lastActivityAt
                    ? new Date(l.lastActivityAt).toLocaleString()
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {result.total > result.pageSize ? (
        <Pagination
          page={result.page}
          pageSize={result.pageSize}
          total={result.total}
          searchParams={sp}
        />
      ) : null}
    </div>
  );
}

function FilterSelect({
  name,
  defaultValue,
  options,
  placeholder,
}: {
  name: string;
  defaultValue?: string;
  options: readonly string[];
  placeholder: string;
}) {
  return (
    <select
      name={name}
      defaultValue={defaultValue ?? ""}
      className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:border-white/30 focus:outline-none focus:ring-2 focus:ring-white/20"
    >
      <option value="">All {placeholder}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o.replaceAll("_", " ")}
        </option>
      ))}
    </select>
  );
}

function StatusPill({ value }: { value: string }) {
  const palette: Record<string, string> = {
    new: "border-blue-300/30 bg-blue-500/10 text-blue-100",
    contacted: "border-cyan-300/30 bg-cyan-500/10 text-cyan-100",
    qualified: "border-emerald-300/30 bg-emerald-500/10 text-emerald-100",
    unqualified: "border-rose-300/30 bg-rose-500/10 text-rose-100",
    converted: "border-violet-300/30 bg-violet-500/10 text-violet-100",
    lost: "border-white/15 bg-white/5 text-white/40",
  };
  const cls = palette[value] ?? palette.lost;
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${cls}`}
    >
      {value}
    </span>
  );
}

function RatingPill({ value }: { value: string }) {
  const palette: Record<string, string> = {
    hot: "border-rose-300/30 bg-rose-500/10 text-rose-100",
    warm: "border-amber-300/30 bg-amber-500/10 text-amber-100",
    cold: "border-sky-300/30 bg-sky-500/10 text-sky-100",
  };
  const cls = palette[value] ?? palette.warm;
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${cls}`}
    >
      {value}
    </span>
  );
}

function Pagination({
  page,
  pageSize,
  total,
  searchParams,
}: {
  page: number;
  pageSize: number;
  total: number;
  searchParams: SearchParams;
}) {
  const totalPages = Math.ceil(total / pageSize);
  const buildHref = (p: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      if (v && k !== "page") params.set(k, v);
    }
    params.set("page", String(p));
    return `/leads?${params.toString()}`;
  };

  return (
    <nav className="mt-6 flex items-center justify-between text-sm text-white/60">
      <span>
        Page {page} of {totalPages}
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link
            href={buildHref(page - 1)}
            className="rounded-md border border-white/15 px-3 py-1.5 hover:bg-white/5"
          >
            ← Previous
          </Link>
        ) : null}
        {page < totalPages ? (
          <Link
            href={buildHref(page + 1)}
            className="rounded-md border border-white/15 px-3 py-1.5 hover:bg-white/5"
          >
            Next →
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
