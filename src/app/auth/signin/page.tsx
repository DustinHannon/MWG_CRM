import { ensureBreakglass } from "@/lib/breakglass";
import { entraConfigured } from "@/lib/env";
import { SigninForm } from "./signin-form";

export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  domain_not_allowed:
    "Your email domain isn't allowed to sign in. Contact IT.",
  signin_failed:
    "Sign-in failed. Please try again, or use the breakglass account.",
  missing_token:
    "Microsoft didn't grant the required permissions. Re-try and consent to all scopes.",
  // Auth.js standard error codes:
  Configuration:
    "Auth is not fully configured yet — try the breakglass account.",
  AccessDenied: "Access denied.",
  Verification: "Verification link expired. Try signing in again.",
};

export default async function SigninPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  await ensureBreakglass();

  const { callbackUrl, error } = await searchParams;
  const topError =
    error && error in ERROR_MESSAGES ? ERROR_MESSAGES[error] : null;

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-slate-950 px-4">
      <div className="absolute inset-0 -z-10 overflow-hidden">
        <div className="pointer-events-none absolute -top-32 -right-24 h-96 w-96 rounded-full bg-blue-500/20 blur-3xl" />
        <div className="pointer-events-none absolute bottom-[-15%] left-[-10%] h-[28rem] w-[28rem] rounded-full bg-indigo-500/15 blur-3xl" />
      </div>
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur-2xl shadow-[0_8px_32px_rgba(10,35,66,0.2)]">
        <div className="mb-8 text-center">
          <p className="text-xs uppercase tracking-[0.3em] text-white/40">
            Morgan White Group
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-white">MWG CRM</h1>
          <p className="mt-2 text-sm text-white/50">
            Sign in to continue
          </p>
        </div>
        <SigninForm
          callbackUrl={callbackUrl}
          entraEnabled={entraConfigured}
          topError={topError}
        />
      </div>
    </div>
  );
}
