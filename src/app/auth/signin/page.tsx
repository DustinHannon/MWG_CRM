import { ensureBreakglass } from "@/lib/breakglass";
import { SigninForm } from "./signin-form";

export const dynamic = "force-dynamic";

export default async function SigninPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  // Guarantees the breakglass account is seeded the very first time anyone
  // hits the deployed app. Idempotent under concurrent cold starts.
  await ensureBreakglass();

  const { callbackUrl } = await searchParams;

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
        <SigninForm callbackUrl={callbackUrl} />
      </div>
    </div>
  );
}
