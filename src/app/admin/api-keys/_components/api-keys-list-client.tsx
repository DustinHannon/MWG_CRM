// consistency-exempt: list-page-pattern: admin-utility-table —
// fixed-width row cells (w-32 prefix, w-48 scopes, w-20 rate-limit,
// w-32 dates, w-24 status, w-32 actions) preserved because columns
// have intrinsically non-uniform widths; no columnHeaderSlot. Per-row
// Revoke + Delete affordances plus Generate-key modal trio are
// page-specific carveouts. Admin operational page — no saved views,
// no MODIFIED badge, no bulk selection.
"use client";

import Link from "next/link";
import { useCallback, useMemo, useState, useTransition } from "react";
import {
  StandardEmptyState,
  StandardListPage,
  type StandardListPagePage,
} from "@/components/standard";
import { useShowPicker } from "@/hooks/use-show-picker";
import { ALL_SCOPES, ENTITIES, SCOPE_PRESETS } from "@/lib/api/scopes";
import {
  deleteApiKeyAction,
  generateApiKeyAction,
  revokeApiKeyAction,
} from "../actions";

export interface ApiKeyRow {
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

type Status = "active" | "revoked" | "expired";

function statusOf(row: ApiKeyRow): Status {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
    return "expired";
  }
  return "active";
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

interface ApiKeysFilters {
  q: string;
  status: "all" | "active" | "revoked" | "expired";
}

const EMPTY_FILTERS: ApiKeysFilters = { q: "", status: "all" };

export function ApiKeysListClient() {
  const [filters, setFilters] = useState<ApiKeysFilters>(EMPTY_FILTERS);
  const [draft, setDraft] = useState<ApiKeysFilters>(EMPTY_FILTERS);

  const [generateOpen, setGenerateOpen] = useState(false);
  const [plaintext, setPlaintext] = useState<{
    plaintext: string;
    prefix: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ApiKeyRow | null>(null);
  // Bumps after every successful generate / revoke / delete. Folded into
  // the TanStack queryKey so the list refetches — router.refresh() alone
  // doesn't invalidate the client-cached useInfiniteQuery state.
  const [reloadKey, setReloadKey] = useState(0);
  const bumpReload = useCallback(() => setReloadKey((k) => k + 1), []);

  const memoizedFilters = useMemo<ApiKeysFilters>(() => filters, [filters]);

  const fetchPage = useCallback(
    async (
      cursor: string | null,
      f: ApiKeysFilters,
    ): Promise<StandardListPagePage<ApiKeyRow>> => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (f.q) params.set("q", f.q);
      if (f.status !== "all") params.set("status", f.status);
      const res = await fetch(`/api/admin/api-keys/list?${params.toString()}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`Could not load API keys (${res.status})`);
      }
      return (await res.json()) as StandardListPagePage<ApiKeyRow>;
    },
    [],
  );

  const renderRow = useCallback(
    (row: ApiKeyRow) => (
      <ApiKeyDesktopRow
        row={row}
        onDelete={() => setDeleteTarget(row)}
        onRevoked={bumpReload}
      />
    ),
    [bumpReload],
  );

  const renderCard = useCallback(
    (row: ApiKeyRow) => (
      <ApiKeyMobileCard
        row={row}
        onDelete={() => setDeleteTarget(row)}
        onRevoked={bumpReload}
      />
    ),
    [bumpReload],
  );

  const applyDraft = () => setFilters(draft);
  const clearFilters = () => {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
  };
  const filtersAreModified = Boolean(filters.q || filters.status !== "all");

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
        placeholder="Search name, description, or prefix"
        className="h-11 min-w-[220px] flex-1 rounded-md border border-border bg-input px-3 text-sm placeholder:text-muted-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 md:h-9 md:py-1.5"
      />
      <select
        value={draft.status}
        onChange={(e) => {
          const next = {
            ...draft,
            status: e.target.value as ApiKeysFilters["status"],
          };
          setDraft(next);
          setFilters(next);
        }}
        className="rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      >
        <option value="all">All statuses</option>
        <option value="active">Active</option>
        <option value="revoked">Revoked</option>
        <option value="expired">Expired</option>
      </select>
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
    <button
      type="button"
      onClick={() => setGenerateOpen(true)}
      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90"
    >
      Generate key
    </button>
  );

  return (
    <>
      <StandardListPage<ApiKeyRow, ApiKeysFilters>
        queryKey={["admin-api-keys", reloadKey]}
        fetchPage={fetchPage}
        filters={memoizedFilters}
        renderRow={renderRow}
        renderCard={renderCard}
        rowEstimateSize={72}
        cardEstimateSize={160}
        emptyState={
          <StandardEmptyState
            title="No API keys yet"
            description="Generate one to give an external integration scoped access."
          />
        }
        header={{
          title: "API keys",
          description:
            "Bearer tokens for external integrations. Tokens act with org-wide visibility regardless of which user generated them.",
          actions: headerActions,
        }}
        filtersSlot={filtersSlot}
      />

      {generateOpen ? (
        <GenerateModal
          onClose={() => setGenerateOpen(false)}
          onGenerated={(plain, prefix) => {
            setGenerateOpen(false);
            setPlaintext({ plaintext: plain, prefix });
          }}
        />
      ) : null}

      {plaintext ? (
        <PlaintextModal
          plaintext={plaintext.plaintext}
          prefix={plaintext.prefix}
          onClose={() => {
            setPlaintext(null);
            bumpReload();
          }}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteModal
          row={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={bumpReload}
        />
      ) : null}
    </>
  );
}

function ApiKeyDesktopRow({
  row,
  onDelete,
  onRevoked,
}: {
  row: ApiKeyRow;
  onDelete: () => void;
  onRevoked: () => void;
}) {
  const status = statusOf(row);
  return (
    <div
      className="flex items-start gap-4 border-b border-border bg-card px-4 py-3 text-sm transition hover:bg-accent/20"
      data-row-flash="new"
    >
      <div className="min-w-0 flex-1">
        <div className="font-medium text-foreground">{row.name}</div>
        {row.description ? (
          <div className="text-xs text-muted-foreground">
            {row.description}
          </div>
        ) : null}
      </div>
      <div className="hidden w-32 shrink-0 md:block">
        <Link
          href={`/admin/api-usage?api_key_id=${row.id}`}
          className="font-mono text-xs text-foreground/80 hover:underline"
          title="View usage for this key"
        >
          {row.prefix}…
        </Link>
      </div>
      <div className="hidden w-48 shrink-0 lg:block">
        <div className="flex flex-wrap gap-1">
          {row.scopes.slice(0, 4).map((s) => (
            <span
              key={s}
              className="inline-block rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
            >
              {s}
            </span>
          ))}
          {row.scopes.length > 4 ? (
            <span className="text-[10px] text-muted-foreground">
              +{row.scopes.length - 4}
            </span>
          ) : null}
        </div>
      </div>
      <div className="hidden w-20 shrink-0 text-right tabular-nums text-foreground/80 lg:block">
        {row.rateLimitPerMinute}/min
      </div>
      <div className="hidden w-32 shrink-0 text-xs text-foreground/80 xl:block">
        <div>Expires: {fmtDateTime(row.expiresAt)}</div>
        <div>Last used: {fmtDateTime(row.lastUsedAt)}</div>
      </div>
      <div className="w-24 shrink-0">
        <StatusPill status={status} />
      </div>
      <div className="w-32 shrink-0 text-right">
        <div className="flex justify-end gap-1.5">
          {status === "active" ? (
            <RevokeButton
              keyId={row.id}
              keyName={row.name}
              onRevoked={onRevoked}
            />
          ) : null}
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md border border-border/80 bg-input/40 px-2 py-1 text-[11px] uppercase tracking-wide text-foreground/80 hover:bg-destructive/20 hover:text-destructive-foreground"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function ApiKeyMobileCard({
  row,
  onDelete,
  onRevoked,
}: {
  row: ApiKeyRow;
  onDelete: () => void;
  onRevoked: () => void;
}) {
  const status = statusOf(row);
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
      data-row-flash="new"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground">
            {row.name}
          </div>
          <Link
            href={`/admin/api-usage?api_key_id=${row.id}`}
            className="font-mono text-xs text-foreground/80 hover:underline"
          >
            {row.prefix}…
          </Link>
        </div>
        <StatusPill status={status} />
      </div>
      <div className="flex flex-wrap gap-1">
        {row.scopes.map((s) => (
          <span
            key={s}
            className="inline-block rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
          >
            {s}
          </span>
        ))}
      </div>
      <div className="flex justify-end gap-1.5">
        {status === "active" ? (
          <RevokeButton
            keyId={row.id}
            keyName={row.name}
            onRevoked={onRevoked}
          />
        ) : null}
        <button
          type="button"
          onClick={onDelete}
          className="rounded-md border border-border/80 bg-input/40 px-2 py-1 text-[11px] uppercase tracking-wide text-foreground/80 hover:bg-destructive/20 hover:text-destructive-foreground"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: Status }) {
  const palette = {
    active:
      "border-[var(--status-won-fg)]/30 bg-[var(--status-won-bg)] text-[var(--status-won-fg)]",
    revoked:
      "border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]",
    expired:
      "border-[var(--priority-medium-fg)]/30 bg-[var(--priority-medium-bg)] text-[var(--priority-medium-fg)]",
  }[status];
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${palette}`}
    >
      {status}
    </span>
  );
}

function RevokeButton({
  keyId,
  keyName,
  onRevoked,
}: {
  keyId: string;
  keyName: string;
  onRevoked: () => void;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (
          !confirm(`Revoke "${keyName}"? It will stop authenticating immediately.`)
        ) {
          return;
        }
        startTransition(async () => {
          const res = await revokeApiKeyAction(keyId);
          if (!res.ok) {
            alert(res.error);
            return;
          }
          onRevoked();
        });
      }}
      className="rounded-md border border-border/80 bg-input/40 px-2 py-1 text-[11px] uppercase tracking-wide text-foreground/80 hover:bg-accent/40 disabled:opacity-50"
    >
      {pending ? "Revoking…" : "Revoke"}
    </button>
  );
}

interface GenerateModalProps {
  onClose: () => void;
  onGenerated: (plaintext: string, prefix: string) => void;
}

const PRESET_LABELS: Array<{ key: keyof typeof SCOPE_PRESETS; label: string }> = [
  { key: "readonly", label: "Read-only" },
  { key: "readwrite", label: "Read/write" },
  { key: "full", label: "Full" },
  { key: "admin", label: "Admin" },
];

function GenerateModal({ onClose, onGenerated }: GenerateModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [rateLimit, setRateLimit] = useState(60);
  const [expiry, setExpiry] = useState<
    "never" | "30d" | "90d" | "1y" | "custom"
  >("never");
  const [customExpires, setCustomExpires] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const customExpiresPicker = useShowPicker();

  function applyPreset(key: keyof typeof SCOPE_PRESETS) {
    setScopes([...SCOPE_PRESETS[key]] as string[]);
  }

  function toggleScope(s: string) {
    setScopes((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  }

  function submit() {
    setError(null);
    let expiresInDays: number | null = null;
    let expiresAt: string | null = null;
    if (expiry === "30d") expiresInDays = 30;
    else if (expiry === "90d") expiresInDays = 90;
    else if (expiry === "1y") expiresInDays = 365;
    else if (expiry === "custom") {
      if (!customExpires) {
        setError("Pick a custom expiration date");
        return;
      }
      expiresAt = new Date(customExpires).toISOString();
    }
    startTransition(async () => {
      const res = await generateApiKeyAction({
        name,
        description: description || null,
        scopes,
        rateLimitPerMinute: rateLimit,
        expiresInDays,
        expiresAt,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onGenerated(res.data.plaintext, res.data.prefix);
    });
  }

  return (
    <ModalShell title="Generate API key" onClose={onClose}>
      <div className="grid gap-4">
        <label className="grid gap-1 text-sm">
          <span className="font-medium">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Integrations bot"
            maxLength={120}
            className="rounded-md border border-border bg-input px-3 py-2 text-sm"
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">Description (optional)</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="rounded-md border border-border bg-input px-3 py-2 text-sm"
          />
        </label>

        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Scopes</span>
            <div className="flex gap-1">
              {PRESET_LABELS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => applyPreset(p.key)}
                  className="rounded border border-border bg-input/60 px-2 py-0.5 text-[11px] uppercase tracking-wide hover:bg-accent/40"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {ENTITIES.map((entity) => (
              <fieldset
                key={entity}
                className="rounded-md border border-border/60 p-2"
              >
                <legend className="px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {entity}
                </legend>
                {(["read", "write", "delete"] as const).map((verb) => {
                  const s = `${verb}:${entity}`;
                  return (
                    <label
                      key={s}
                      className="flex items-center gap-2 py-0.5 text-xs"
                    >
                      <input
                        type="checkbox"
                        checked={scopes.includes(s)}
                        onChange={() => toggleScope(s)}
                      />
                      <span className="font-mono">{s}</span>
                    </label>
                  );
                })}
              </fieldset>
            ))}
            <fieldset className="rounded-md border border-border/60 p-2 sm:col-span-2">
              <legend className="px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                Misc
              </legend>
              <div className="grid grid-cols-2 gap-2">
                {ALL_SCOPES.filter(
                  (s) => s === "read:users" || s === "admin",
                ).map((s) => (
                  <label
                    key={s}
                    className="flex items-center gap-2 py-0.5 text-xs"
                  >
                    <input
                      type="checkbox"
                      checked={scopes.includes(s)}
                      onChange={() => toggleScope(s)}
                    />
                    <span className="font-mono">{s}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        </div>

        <label className="grid gap-1 text-sm">
          <span className="font-medium">Rate limit (requests / minute)</span>
          <input
            type="number"
            min={10}
            max={1000}
            value={rateLimit}
            onChange={(e) => setRateLimit(Number(e.target.value))}
            className="rounded-md border border-border bg-input px-3 py-2 text-sm"
          />
        </label>

        <fieldset className="grid gap-1 text-sm">
          <legend className="font-medium">Expiration</legend>
          <div className="flex flex-wrap gap-3">
            {(
              [
                ["never", "Never"],
                ["30d", "30 days"],
                ["90d", "90 days"],
                ["1y", "1 year"],
                ["custom", "Custom"],
              ] as const
            ).map(([v, label]) => (
              <label key={v} className="flex items-center gap-2 text-xs">
                <input
                  type="radio"
                  name="expiry"
                  checked={expiry === v}
                  onChange={() => setExpiry(v)}
                />
                {label}
              </label>
            ))}
          </div>
          {expiry === "custom" ? (
            <input
              type="datetime-local"
              value={customExpires}
              onChange={(e) => setCustomExpires(e.target.value)}
              onClick={customExpiresPicker}
              className="mt-1 rounded-md border border-border bg-input px-3 py-2 text-sm"
            />
          ) : null}
        </fieldset>

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
            {error}
          </div>
        ) : null}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-input/40 px-3 py-1.5 text-xs uppercase tracking-wide hover:bg-accent/40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className="rounded-md border border-primary/60 bg-primary px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {pending ? "Generating…" : "Generate"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function PlaintextModal({
  plaintext,
  prefix,
  onClose,
}: {
  plaintext: string;
  prefix: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <ModalShell title="API key generated" onClose={onClose}>
      <div className="grid gap-4">
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          <strong>Copy this key now.</strong> You will not be able to see it
          again. Store it in a secure secret manager.
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Prefix (visible later)
          </p>
          <p className="font-mono text-sm">{prefix}…</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Token (one-time)
          </p>
          <code className="mt-1 block break-all rounded-md border border-border bg-input px-3 py-2 font-mono text-sm">
            {plaintext}
          </code>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(plaintext).catch(() => {});
              setCopied(true);
            }}
            className="mt-2 rounded-md border border-border bg-input/60 px-3 py-1.5 text-xs uppercase tracking-wide hover:bg-accent/40"
          >
            {copied ? "Copied!" : "Copy to clipboard"}
          </button>
        </div>
        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-primary/60 bg-primary px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-primary-foreground hover:bg-primary/90"
          >
            I&apos;ve stored it
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function DeleteModal({
  row,
  onClose,
  onDeleted,
}: {
  row: ApiKeyRow;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [confirm, setConfirm] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <ModalShell title={`Delete "${row.name}"`} onClose={onClose}>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Permanently deletes the key. Usage history is preserved (the
          retention cron prunes it after 730 days). Type the key&apos;s name
          to confirm.
        </p>
        <input
          type="text"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={row.name}
          className="rounded-md border border-border bg-input px-3 py-2 text-sm"
        />
        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
            {error}
          </div>
        ) : null}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-input/40 px-3 py-1.5 text-xs uppercase tracking-wide hover:bg-accent/40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending || confirm !== row.name}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const res = await deleteApiKeyAction(row.id, confirm);
                if (!res.ok) {
                  setError(res.error);
                  return;
                }
                onClose();
                onDeleted();
              });
            }}
            className="rounded-md border border-destructive/60 bg-destructive px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-destructive-foreground hover:bg-destructive/90 disabled:opacity-40"
          >
            {pending ? "Deleting…" : "Delete forever"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl border border-border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold font-display">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-input/40 px-2 py-0.5 text-xs uppercase tracking-wide hover:bg-accent/40"
          >
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
