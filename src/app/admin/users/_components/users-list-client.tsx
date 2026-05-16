// consistency-exempt: list-page-pattern: admin-utility-table
// Admin /users uses fixed-width row cells (w-56, w-32, etc.) rather
// than the canonical 140px flex-basis pattern because the displayed
// columns (avatar+name, email, role pills, status pill, source label,
// lead count, last login) have intrinsically non-uniform widths and
// no associated columnHeaderSlot to align against. No saved views,
// no MODIFIED badge, no bulk selection — admin operational page.
"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import {
  StandardEmptyState,
  StandardListPage,
  type StandardListPagePage,
} from "@/components/standard";
import { UserTimeClient } from "@/components/ui/user-time-client";
import { UserAvatar } from "@/components/user-display/user-avatar";
import { type TimePrefs } from "@/lib/format-time";

const RECENT_JIT_FILTER = "jit-7d";

export interface UserRow {
  id: string;
  username: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  isBreakglass: boolean;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  jitProvisioned: boolean;
  jitProvisionedAt: string | null;
  photoUrl: string | null;
  leadCount: number;
}

interface UsersFilters {
  q: string;
  recent: "all" | "jit-7d";
}

const EMPTY_FILTERS: UsersFilters = { q: "", recent: "all" };

interface UsersListClientProps {
  timePrefs: TimePrefs;
  initialRecent: "all" | "jit-7d";
}

export function UsersListClient({
  timePrefs,
  initialRecent,
}: UsersListClientProps) {
  const [filters, setFilters] = useState<UsersFilters>({
    q: "",
    recent: initialRecent,
  });
  const [draft, setDraft] = useState<UsersFilters>({
    q: "",
    recent: initialRecent,
  });

  const memoizedFilters = useMemo<UsersFilters>(() => filters, [filters]);

  const fetchPage = useCallback(
    async (
      cursor: string | null,
      f: UsersFilters,
    ): Promise<StandardListPagePage<UserRow>> => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (f.q) params.set("q", f.q);
      if (f.recent === "jit-7d") params.set("recent", RECENT_JIT_FILTER);
      const res = await fetch(`/api/admin/users/list?${params.toString()}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`Could not load users (${res.status})`);
      }
      return (await res.json()) as StandardListPagePage<UserRow>;
    },
    [],
  );

  const renderRow = useCallback(
    (row: UserRow) => <UsersDesktopRow row={row} timePrefs={timePrefs} />,
    [timePrefs],
  );

  const renderCard = useCallback(
    (row: UserRow) => <UsersMobileCard row={row} timePrefs={timePrefs} />,
    [timePrefs],
  );

  const applyDraft = () => setFilters(draft);
  const clearFilters = () => {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
  };
  const filtersAreModified = Boolean(
    filters.q || filters.recent !== "all",
  );

  const filtersSlot = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        applyDraft();
      }}
      className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-3"
    >
      <input
        type="search"
        value={draft.q}
        onChange={(e) => setDraft({ ...draft, q: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            applyDraft();
          }
        }}
        placeholder="Search by name, email, or username"
        className="h-11 min-w-[220px] flex-1 rounded-md border border-border bg-input px-3 text-sm placeholder:text-muted-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 md:h-9 md:py-1.5"
      />
      <div className="flex gap-1.5">
        <FilterChip
          active={draft.recent === "all"}
          onClick={() => {
            const next: UsersFilters = { ...draft, recent: "all" };
            setDraft(next);
            setFilters(next);
          }}
        >
          All users
        </FilterChip>
        <FilterChip
          active={draft.recent === "jit-7d"}
          onClick={() => {
            const next: UsersFilters = { ...draft, recent: "jit-7d" };
            setDraft(next);
            setFilters(next);
          }}
        >
          Recently joined (7d)
        </FilterChip>
      </div>
      <button
        type="submit"
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
      >
        Apply
      </button>
      {filtersAreModified ? (
        <button
          type="button"
          onClick={clearFilters}
          className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground"
        >
          Clear
        </button>
      ) : null}
    </form>
  );

  const headerActions = (
    <Link
      href="/admin/users/help"
      className="shrink-0 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/80 whitespace-nowrap transition hover:bg-accent/40"
    >
      Permission help
    </Link>
  );

  return (
    <StandardListPage<UserRow, UsersFilters>
      entityType="user"
      queryKey={["admin-users"]}
      fetchPage={fetchPage}
      filters={memoizedFilters}
      renderRow={renderRow}
      renderCard={renderCard}
      rowEstimateSize={64}
      cardEstimateSize={140}
      emptyState={
        <StandardEmptyState
          title="No users match"
          description={
            filtersAreModified ? "Try a different filter." : undefined
          }
        />
      }
      header={{
        title: "Users",
        actions: headerActions,
      }}
      filtersSlot={filtersSlot}
    />
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const palette = active
    ? "border-foreground/30 bg-foreground text-background"
    : "border-border bg-muted/40 text-muted-foreground hover:bg-muted";
  // h-11 on mobile satisfies the 44px touch-target floor required by
  // the canonical list-page pattern. Desktop reverts to a compact h-9
  // since the row is a wrap-flex of utility filters.
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-11 items-center rounded-full border px-3 text-sm transition md:h-9 md:text-xs ${palette}`}
    >
      {children}
    </button>
  );
}

function UsersDesktopRow({
  row,
  timePrefs,
}: {
  row: UserRow;
  timePrefs: TimePrefs;
}) {
  return (
    <div
      className="flex items-start gap-4 border-b border-border bg-card px-4 py-3 text-sm transition hover:bg-accent/20"
      data-row-flash="new"
    >
      <Link
        href={`/admin/users/${row.id}`}
        aria-label={row.displayName}
        className="shrink-0"
      >
        <UserAvatar
          user={{
            id: row.id,
            displayName: row.displayName,
            photoUrl: row.photoUrl,
          }}
          size="sm"
        />
      </Link>
      <div className="min-w-0 flex-1">
        <Link
          href={`/admin/users/${row.id}`}
          className="block font-medium text-foreground hover:underline"
        >
          {row.displayName}
        </Link>
        <span className="text-xs text-muted-foreground/80">{row.username}</span>
      </div>
      <div className="hidden w-56 shrink-0 truncate text-foreground/80 md:block">
        {row.email}
      </div>
      <div className="hidden w-32 shrink-0 md:block">
        <div className="flex flex-wrap gap-1.5">
          {row.isAdmin ? (
            <Pill tone="admin">Admin</Pill>
          ) : (
            <Pill tone="muted">User</Pill>
          )}
          {row.isBreakglass ? <Pill tone="warn">Breakglass</Pill> : null}
        </div>
      </div>
      <div className="hidden w-24 shrink-0 lg:block">
        {row.isActive ? (
          <Pill tone="ok">Active</Pill>
        ) : (
          <Pill tone="off">Disabled</Pill>
        )}
      </div>
      <div className="hidden w-32 shrink-0 text-foreground/80 lg:block">
        <SourceLabel
          jit={row.jitProvisioned}
          jitAt={row.jitProvisionedAt}
        />
      </div>
      <div className="hidden w-16 shrink-0 text-right tabular-nums text-foreground/80 xl:block">
        {row.leadCount}
      </div>
      <div className="hidden w-32 shrink-0 text-muted-foreground xl:block">
        <UserTimeClient value={row.lastLoginAt} prefs={timePrefs} />
      </div>
    </div>
  );
}

function UsersMobileCard({
  row,
  timePrefs,
}: {
  row: UserRow;
  timePrefs: TimePrefs;
}) {
  return (
    <Link
      href={`/admin/users/${row.id}`}
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
      data-row-flash="new"
    >
      <div className="flex items-start gap-3">
        <UserAvatar
          user={{
            id: row.id,
            displayName: row.displayName,
            photoUrl: row.photoUrl,
          }}
          size="sm"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground">
            {row.displayName}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {row.email}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {row.isAdmin ? <Pill tone="admin">Admin</Pill> : null}
        {row.isBreakglass ? <Pill tone="warn">Breakglass</Pill> : null}
        {row.isActive ? (
          <Pill tone="ok">Active</Pill>
        ) : (
          <Pill tone="off">Disabled</Pill>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          <UserTimeClient value={row.lastLoginAt} prefs={timePrefs} />
        </span>
      </div>
    </Link>
  );
}

function SourceLabel({
  jit,
  jitAt,
}: {
  jit: boolean;
  jitAt: string | null;
}) {
  if (!jit) {
    return <span className="text-muted-foreground">Manual</span>;
  }
  const stamp = jitAt ? jitAt.slice(0, 10) : "—";
  return <span>JIT ({stamp})</span>;
}

function Pill({
  tone,
  children,
}: {
  tone: "ok" | "off" | "admin" | "warn" | "muted";
  children: React.ReactNode;
}) {
  const palette = {
    ok: "border-[var(--status-won-fg)]/30 bg-[var(--status-won-bg)] text-[var(--status-won-fg)]",
    off: "border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]",
    admin:
      "border-[var(--status-new-fg)]/30 bg-[var(--status-new-bg)] text-[var(--status-new-fg)]",
    warn: "border-[var(--priority-medium-fg)]/30 bg-[var(--priority-medium-bg)] text-[var(--priority-medium-fg)]",
    muted: "border-border bg-muted/40 text-muted-foreground",
  }[tone];
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${palette}`}
    >
      {children}
    </span>
  );
}
