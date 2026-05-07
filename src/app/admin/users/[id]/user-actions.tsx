"use client";

import { useState, useTransition } from "react";
import {
  forceReauth,
  rotateBreakglassPassword,
  updateActiveFlag,
  updateAdminFlag,
  updatePermission,
} from "./actions";

interface PermissionItem {
  key: string;
  label: string;
  hint: string;
  value: boolean;
}

export function UserActions({
  userId,
  isAdmin,
  isActive,
  isBreakglass,
  isSelf,
  permissions,
}: {
  userId: string;
  isAdmin: boolean;
  isActive: boolean;
  isBreakglass: boolean;
  isSelf: boolean;
  permissions: PermissionItem[];
}) {
  const [isPending, startTransition] = useTransition();
  const [rotated, setRotated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function call(action: (fd: FormData) => Promise<unknown>, fd: FormData) {
    setError(null);
    startTransition(async () => {
      try {
        await action(fd);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Action failed.");
      }
    });
  }

  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-2">
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl">
        <h2 className="text-sm font-medium uppercase tracking-wide text-white/60">
          Status
        </h2>

        <div className="mt-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Administrator</p>
            <p className="text-xs text-white/50">
              Bypasses every per-feature permission below.
              {isBreakglass ? " Breakglass is always admin." : ""}
            </p>
          </div>
          <Toggle
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
            <p className="text-xs text-white/50">
              Inactive users are signed out and cannot sign in.
              {isBreakglass ? " Breakglass cannot be deactivated." : ""}
            </p>
          </div>
          <Toggle
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
            className="rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white/80 transition hover:bg-white/10 disabled:opacity-50"
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
                    setRotated(r.password ?? "");
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Rotation failed.");
                  }
                });
              }}
              className="rounded-md border border-amber-300/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100 transition hover:bg-amber-500/20 disabled:opacity-50"
            >
              Rotate breakglass password
            </button>
          ) : null}
        </div>

        {error ? (
          <div
            role="alert"
            className="mt-4 rounded-md border border-rose-300/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100"
          >
            {error}
          </div>
        ) : null}

        {rotated !== null ? (
          <div className="mt-4 rounded-md border border-amber-300/30 bg-amber-500/15 p-4 text-sm">
            <p className="font-medium text-amber-50">
              New breakglass password (shown once):
            </p>
            <code className="mt-2 block break-all rounded bg-black/30 px-3 py-2 font-mono text-xs text-white">
              {rotated}
            </code>
            <p className="mt-2 text-xs text-amber-100/80">
              Store it in your password manager now. We won&apos;t show it again.
            </p>
          </div>
        ) : null}
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl">
        <h2 className="text-sm font-medium uppercase tracking-wide text-white/60">
          Permissions
        </h2>
        <p className="mt-1 text-xs text-white/40">
          Admins bypass these. Changes save instantly.
        </p>
        <div className="mt-4 flex flex-col divide-y divide-white/10">
          {permissions.map((p) => (
            <div
              key={p.key}
              className="flex items-center justify-between gap-4 py-3"
            >
              <div>
                <p className="text-sm font-medium">{p.label}</p>
                <p className="text-xs text-white/40">{p.hint}</p>
              </div>
              <Toggle
                disabled={isPending}
                value={p.value}
                onChange={(v) => {
                  const fd = new FormData();
                  fd.set("userId", userId);
                  fd.set("key", p.key);
                  fd.set("value", String(v));
                  call(updatePermission, fd);
                }}
              />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Toggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${
        value ? "bg-emerald-500/80" : "bg-white/10"
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
