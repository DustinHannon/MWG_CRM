"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
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

/**
 * Single source of truth for the desktop table columns. Drives both the
 * `columnHeaderSlot` header cells and the row cells so the two tiers can
 * never drift out of alignment (canonical list pattern, STANDARDS §17).
 */
const USER_COLUMNS = [
  { key: "user", label: "User" },
  { key: "email", label: "Email" },
  { key: "role", label: "Role" },
  { key: "status", label: "Status" },
  { key: "source", label: "Source" },
  { key: "leads", label: "Leads" },
  { key: "lastLogin", label: "Last login" },
] as const;

type UserColumnKey = (typeof USER_COLUMNS)[number]["key"];

/**
 * Shared header/row min-width: cols × 140px flex-basis. Matches the
 * canonical leads geometry minus leads' `+40` — that constant reserves
 * leads' trailing `w-10` row-actions gutter, which /admin/users has on
 * neither tier (rows link to the detail page; no per-row action menu).
 * Header and row reference this same constant so they stay aligned.
 */
const COL_MIN_WIDTH = USER_COLUMNS.length * 140;

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
      signal?: AbortSignal,
    ): Promise<StandardListPagePage<UserRow>> => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (f.q) params.set("q", f.q);
      if (f.recent === "jit-7d") params.set("recent", RECENT_JIT_FILTER);
      const res = await fetch(`/api/admin/users/list?${params.toString()}`, {
        headers: { Accept: "application/json" },
        signal,
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

  // Desktop column-header tier. Mirrors UsersDesktopRow's box model
  // exactly — same USER_COLUMNS map, same `min-w-0 flex-1 px-5` cell
  // with `flexBasis:140px`, same COL_MIN_WIDTH — so header cells stay
  // pixel-aligned with row cells at every viewport width. Static
  // labels: /admin/users is a non-P0 operational entity with no
  // saved-views or sort allowlist, so no DnD/click-sort (STANDARDS
  // §17: sortable headers are P0-only). Leads wraps its header in a
  // `<table>` only to host dnd-kit sortable `<th>`; with static labels
  // matching the row's flex box model is the robust choice (an
  // auto-layout table would size headers to label text, not to the
  // 140px row cells, and drift out of alignment).
  const columnHeaderSlot = (
    <div
      className="flex items-stretch text-[11px] uppercase tracking-wide text-muted-foreground"
      style={{ minWidth: `${COL_MIN_WIDTH}px` }}
    >
      {USER_COLUMNS.map((c) => (
        <div
          key={c.key}
          className="min-w-0 flex-1 truncate px-5 py-3 font-medium select-none"
          style={{ flexBasis: "140px" }}
        >
          {c.label}
        </div>
      ))}
    </div>
  );

  const headerActions = (
    <div className="flex shrink-0 items-center gap-2">
      <Link
        href="/admin/users/sync"
        className="shrink-0 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/80 whitespace-nowrap transition hover:bg-accent/40"
      >
        Sync from Entra
      </Link>
      <Link
        href="/admin/users/help"
        className="shrink-0 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/80 whitespace-nowrap transition hover:bg-accent/40"
      >
        Permission help
      </Link>
    </div>
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
      columnHeaderSlot={columnHeaderSlot}
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

/**
 * Renders one desktop table cell's content for the given column. Kept
 * beside `USER_COLUMNS` so the header and body stay in lockstep.
 */
function renderUserCell(
  row: UserRow,
  key: UserColumnKey,
  timePrefs: TimePrefs,
): ReactNode {
  switch (key) {
    case "user":
      return (
        <div className="flex min-w-0 items-center gap-2">
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
          <div className="min-w-0">
            <Link
              href={`/admin/users/${row.id}`}
              className="block truncate font-medium text-foreground hover:underline"
            >
              {row.displayName}
            </Link>
            <span className="block truncate text-xs text-muted-foreground/80">
              {row.username}
            </span>
          </div>
        </div>
      );
    case "email":
      return <span className="text-foreground/80">{row.email}</span>;
    case "role":
      return (
        <div className="flex flex-wrap gap-1.5">
          {row.isAdmin ? (
            <Pill tone="admin">Admin</Pill>
          ) : (
            <Pill tone="muted">User</Pill>
          )}
          {row.isBreakglass ? <Pill tone="warn">Breakglass</Pill> : null}
        </div>
      );
    case "status":
      return row.isActive ? (
        <Pill tone="ok">Active</Pill>
      ) : (
        <Pill tone="off">Disabled</Pill>
      );
    case "source":
      return (
        <span className="text-foreground/80">
          <SourceLabel jit={row.jitProvisioned} jitAt={row.jitProvisionedAt} />
        </span>
      );
    case "leads":
      return (
        <span className="block text-right tabular-nums text-foreground/80">
          {row.leadCount}
        </span>
      );
    case "lastLogin":
      return (
        <span className="text-muted-foreground">
          <UserTimeClient value={row.lastLoginAt} prefs={timePrefs} />
        </span>
      );
    default: {
      // Exhaustiveness guard: adding a column to USER_COLUMNS without a
      // matching case here is a compile error, not a silently empty cell.
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
}

function UsersDesktopRow({
  row,
  timePrefs,
}: {
  row: UserRow;
  timePrefs: TimePrefs;
}) {
  // Match the column-header tier's min-width so the row stays aligned
  // with header cells when the table is wider than the viewport (the
  // shell's outer wrapper provides horizontal scroll under that
  // condition) — canonical list pattern (STANDARDS §17).
  return (
    <div
      className="group flex items-stretch border-b border-border/60 bg-card text-sm transition hover:bg-muted/40"
      data-row-flash="new"
      style={{ minWidth: `${COL_MIN_WIDTH}px` }}
    >
      {USER_COLUMNS.map((c) => (
        <div
          key={c.key}
          data-label={c.label}
          className="min-w-0 flex-1 truncate px-5 py-3"
          style={{ flexBasis: "140px" }}
        >
          {renderUserCell(row, c.key, timePrefs)}
        </div>
      ))}
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
      className="flex items-center gap-3 rounded-md border border-border bg-card p-3"
      data-row-flash="new"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
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
      </div>
      <ChevronRight
        className="size-4 shrink-0 self-center text-muted-foreground"
        aria-hidden="true"
      />
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
