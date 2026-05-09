"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ALL_SCOPES, ENTITIES, SCOPE_PRESETS } from "@/lib/api/scopes";
import {
  deleteApiKeyAction,
  generateApiKeyAction,
  revokeApiKeyAction,
} from "../actions";
import type { SerializedKeyRow } from "../page";

type Status = "active" | "revoked" | "expired";

function statusOf(row: SerializedKeyRow): Status {
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

export function ApiKeysAdminClient({ rows }: { rows: SerializedKeyRow[] }) {
  const [generateOpen, setGenerateOpen] = useState(false);
  const [plaintext, setPlaintext] = useState<{
    plaintext: string;
    prefix: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SerializedKeyRow | null>(
    null,
  );

  return (
    <div>
      <div className="flex items-center justify-between gap-3 px-5 py-4">
        <p className="text-sm text-muted-foreground">
          {rows.length} {rows.length === 1 ? "key" : "keys"} total.
        </p>
        <button
          type="button"
          onClick={() => setGenerateOpen(true)}
          className="rounded-md border border-glass-border bg-input/60 px-3 py-1.5 text-xs font-medium uppercase tracking-wide hover:bg-accent/40"
        >
          Generate Key
        </button>
      </div>

      <div className="border-t border-border/60">
        <table className="data-table min-w-full divide-y divide-border/60">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-5 py-3 font-medium">Name</th>
              <th className="px-5 py-3 font-medium">Prefix</th>
              <th className="px-5 py-3 font-medium">Scopes</th>
              <th className="px-5 py-3 font-medium text-right">Rate / min</th>
              <th className="px-5 py-3 font-medium">Expires</th>
              <th className="px-5 py-3 font-medium">Last used</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-5 py-8 text-center text-sm text-muted-foreground"
                >
                  No keys yet. Generate one to get started.
                </td>
              </tr>
            ) : null}
            {rows.map((row) => {
              const status = statusOf(row);
              return (
                <tr key={row.id} className="text-sm">
                  <td className="px-5 py-3">
                    <div className="font-medium text-foreground">{row.name}</div>
                    {row.description ? (
                      <div className="text-xs text-muted-foreground">
                        {row.description}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-5 py-3">
                    <Link
                      href={`/admin/api-usage?key_id=${row.id}`}
                      className="font-mono text-xs text-foreground/80 hover:underline"
                      title="View usage for this key"
                    >
                      {row.prefix}…
                    </Link>
                  </td>
                  <td className="px-5 py-3">
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
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums text-foreground/80">
                    {row.rateLimitPerMinute}
                  </td>
                  <td className="px-5 py-3 text-foreground/80">
                    {fmtDateTime(row.expiresAt)}
                  </td>
                  <td className="px-5 py-3 text-foreground/80">
                    <div>{fmtDateTime(row.lastUsedAt)}</div>
                    {row.lastUsedIp ? (
                      <div className="text-xs text-muted-foreground font-mono">
                        {row.lastUsedIp}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-5 py-3">
                    <StatusPill status={status} />
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex justify-end gap-1.5">
                      {status === "active" ? (
                        <RevokeButton keyId={row.id} keyName={row.name} />
                      ) : null}
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(row)}
                        className="rounded-md border border-border/80 bg-input/40 px-2 py-1 text-[11px] uppercase tracking-wide text-foreground/80 hover:bg-destructive/20 hover:text-destructive-foreground"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

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
          onClose={() => setPlaintext(null)}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteModal
          row={deleteTarget}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}
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

function RevokeButton({ keyId, keyName }: { keyId: string; keyName: string }) {
  const router = useRouter();
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
            alert(res.message);
            return;
          }
          router.refresh();
        });
      }}
      className="rounded-md border border-border/80 bg-input/40 px-2 py-1 text-[11px] uppercase tracking-wide text-foreground/80 hover:bg-amber-500/20 disabled:opacity-50"
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
  const [expiry, setExpiry] = useState<"never" | "30d" | "90d" | "1y" | "custom">("never");
  const [customExpires, setCustomExpires] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

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
        setError(res.message);
        return;
      }
      onGenerated(res.plaintext, res.prefix);
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
                  <label key={s} className="flex items-center gap-2 py-0.5 text-xs">
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
  const router = useRouter();
  const [copied, setCopied] = useState(false);

  return (
    <ModalShell
      title="API key generated"
      onClose={() => {
        onClose();
        router.refresh();
      }}
    >
      <div className="grid gap-4">
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
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
            onClick={() => {
              onClose();
              router.refresh();
            }}
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
}: {
  row: SerializedKeyRow;
  onClose: () => void;
}) {
  const router = useRouter();
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
                  setError(res.message);
                  return;
                }
                onClose();
                router.refresh();
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
