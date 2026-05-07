"use client";

import { useActionState, useState } from "react";
import { signInBreakglassAction } from "./actions";
import type { ActionResult } from "@/lib/server-action";
import { MicrosoftSignInButton } from "./microsoft-button";

const initialState: ActionResult<never> = { ok: true };

export function SigninForm({
  callbackUrl,
  entraEnabled,
  topError,
}: {
  callbackUrl?: string;
  entraEnabled: boolean;
  topError?: string | null;
}) {
  const [showBreakglass, setShowBreakglass] = useState(false);
  const [state, formAction, pending] = useActionState<
    ActionResult<never>,
    FormData
  >(async (_prev, formData) => signInBreakglassAction(formData), initialState);

  return (
    <div className="flex flex-col gap-6">
      {topError ? (
        <div
          role="alert"
          className="rounded-md border border-rose-300/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100"
        >
          {topError}
        </div>
      ) : null}

      {entraEnabled ? (
        <MicrosoftSignInButton callbackUrl={callbackUrl} />
      ) : (
        <button
          type="button"
          disabled
          className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-white/40 backdrop-blur-md transition cursor-not-allowed"
          title="Available after the Entra App Registration is configured."
        >
          Sign in with Microsoft <span className="ml-2 text-xs">(pending Entra config)</span>
        </button>
      )}

      <div className="flex items-center gap-3 text-xs text-white/40">
        <div className="h-px flex-1 bg-white/10" />
        <span>or</span>
        <div className="h-px flex-1 bg-white/10" />
      </div>

      {!showBreakglass ? (
        <button
          type="button"
          onClick={() => setShowBreakglass(true)}
          className="text-xs text-white/50 underline-offset-4 hover:text-white/80 hover:underline"
        >
          Use breakglass account
        </button>
      ) : (
        <form action={formAction} className="flex flex-col gap-3" noValidate>
          <input type="hidden" name="callbackUrl" value={callbackUrl ?? "/dashboard"} />
          <label className="text-xs uppercase tracking-wide text-white/50">
            Username
            <input
              name="username"
              autoComplete="username"
              defaultValue="breakglass"
              required
              className="mt-1 block w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-white/30 focus:outline-none focus:ring-2 focus:ring-white/20"
            />
          </label>
          <label className="text-xs uppercase tracking-wide text-white/50">
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="mt-1 block w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-white/30 focus:outline-none focus:ring-2 focus:ring-white/20"
            />
          </label>

          {!state.ok && state.error ? (
            <div
              role="alert"
              className="rounded-md border border-rose-300/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100"
            >
              {state.error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={pending}
            className="mt-1 rounded-md bg-white/90 px-4 py-2 text-sm font-medium text-slate-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "Signing in…" : "Sign in"}
          </button>

          <p className="text-xs text-white/40">
            Breakglass is only for emergencies. Use Microsoft SSO when available.
          </p>
        </form>
      )}
    </div>
  );
}
