"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";

export function MicrosoftSignInButton({
  callbackUrl,
}: {
  callbackUrl?: string;
}) {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        setPending(true);
        signIn("microsoft-entra-id", {
          redirectTo: callbackUrl ?? "/dashboard",
        }).catch(() => setPending(false));
      }}
      className="w-full rounded-lg border border-white/10 bg-white/95 px-4 py-3 text-sm font-medium text-slate-900 backdrop-blur-md transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60 flex items-center justify-center gap-2"
    >
      {/* Inline Microsoft logo (4 squares, brand colors) */}
      <svg
        viewBox="0 0 21 21"
        aria-hidden
        className="h-4 w-4"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect x="1" y="1" width="9" height="9" fill="#F25022" />
        <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
        <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
        <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
      </svg>
      {pending ? "Redirecting…" : "Sign in with Microsoft"}
    </button>
  );
}
