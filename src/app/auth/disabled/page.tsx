export default function DisabledPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
      <div className="max-w-md rounded-2xl border border-white/10 bg-white/5 p-8 text-center backdrop-blur-2xl">
        <h1 className="text-xl font-semibold text-white">Account disabled</h1>
        <p className="mt-3 text-sm text-white/60">
          Your MWG CRM account has been disabled. Contact IT to restore
          access.
        </p>
      </div>
    </div>
  );
}
