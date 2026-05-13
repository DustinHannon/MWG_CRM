"use client";

import { useState, useTransition } from "react";
import {
  forceReauth,
  rotateBreakglassPassword,
  updateActiveFlag,
  updateAdminFlag,
} from "./actions";

/**
 * Status/lifecycle controls for the admin user-detail page: admin
 * toggle, active toggle, force re-auth, breakglass password rotation.
 * Permission editing has moved to <PermissionsEditor> on the page.
 */
export function UserActions({
  userId,
  isAdmin,
  isActive,
  isBreakglass,
  isSelf,
}: {
  userId: string;
  isAdmin: boolean;
  isActive: boolean;
  isBreakglass: boolean;
  isSelf: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [rotated, setRotated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function call(
    action: (
      fd: FormData,
    ) => Promise<{ ok: true } | { ok: false; error: string }>,
    fd: FormData,
  ) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await action(fd);
        if (!res.ok) setError(res.error);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Action failed.");
      }
    });
  }

  return (
    <section className="mt-8 rounded-2xl border border-border bg-muted/40 p-6 backdrop-blur-xl">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        Status
      </h2>

      <div className="mt-4 flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Administrator</p>
          <p className="text-xs text-muted-foreground">
            Bypasses every per-feature permission below.
            {isBreakglass ? " Breakglass is always admin." : ""}
          </p>
        </div>
        <Toggle
          label="Administrator"
          disabled={isBreakglass || isSelf || isPending}
          value={isAdmin}
          onChange={(v) => {
            const fd = new FormData();
            fd.set("userId", userId);
            fd.set("value", String(v));
            call(updateAdminFlag, fd);
          }}
        />
      </div>

      <div className="mt-5 flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Active</p>
          <p className="text-xs text-muted-foreground">
            Inactive users are signed out and cannot sign in.
            {isBreakglass ? " Breakglass cannot be deactivated." : ""}
          </p>
        </div>
        <Toggle
          label="Active"
          disabled={isBreakglass || isSelf || isPending}
          value={isActive}
          onChange={(v) => {
            const fd = new FormData();
            fd.set("userId", userId);
            fd.set("value", String(v));
            call(updateActiveFlag, fd);
          }}
        />
      </div>

      <div className="mt-6 flex flex-col gap-3">
        <button
          type="button"
          disabled={isPending}
          onClick={() => {
            const fd = new FormData();
            fd.set("userId", userId);
            call(forceReauth, fd);
          }}
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground/90 transition hover:bg-muted disabled:opacity-50"
        >
          Force re-auth
        </button>
        {isBreakglass ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              setError(null);
              setRotated(null);
              startTransition(async () => {
                try {
                  const r = await rotateBreakglassPassword();
                  if (!r.ok) {
                    setError(r.error ?? "Rotation failed.");
                    return;
                  }
                  setRotated(r.data.password);
                } catch (e) {
                  setError(
                    e instanceof Error ? e.message : "Rotation failed.",
                  );
                }
              });
            }}
            className="rounded-md border border-[var(--priority-medium-fg)]/30 bg-[var(--priority-medium-bg)] px-3 py-2 text-sm text-[var(--priority-medium-fg)] transition hover:bg-[var(--priority-medium-bg)]/80 disabled:opacity-50"
          >
            Rotate breakglass password
          </button>
        ) : null}
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-4 rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-2 text-sm text-[var(--status-lost-fg)]"
        >
          {error}
        </div>
      ) : null}

      {rotated !== null ? (
        <div className="mt-4 rounded-md border border-[var(--priority-medium-fg)]/30 bg-[var(--priority-medium-bg)] p-4 text-sm">
          <p className="font-medium text-[var(--priority-medium-fg)]">
            New breakglass password (shown once):
          </p>
          <code className="mt-2 block break-all rounded bg-black/30 px-3 py-2 font-mono text-xs text-foreground">
            {rotated}
          </code>
          <p className="mt-2 text-xs text-[var(--priority-medium-fg)]/80">
            Store it in your password manager now. We won&apos;t show it
            again.
          </p>
        </div>
      ) : null}
    </section>
  );
}

function Toggle({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${
        value ? "bg-[var(--status-won-fg)]" : "bg-muted"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
          value ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
