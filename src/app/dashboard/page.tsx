import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/auth/signin");
  }

  const user = session.user;

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-5xl px-6 py-12">
        <header className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-white/40">
              Morgan White Group
            </p>
            <h1 className="mt-1 text-2xl font-semibold">MWG CRM</h1>
          </div>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/auth/signin" });
            }}
          >
            <button
              type="submit"
              className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white/80 transition hover:bg-white/10"
            >
              Sign out
            </button>
          </form>
        </header>

        <section className="mt-12 rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur-xl">
          <p className="text-xs uppercase tracking-wide text-white/40">
            Signed in as
          </p>
          <p className="mt-2 text-lg font-medium">{user.name ?? user.email}</p>
          <p className="text-sm text-white/50">{user.email}</p>
          {user.isAdmin ? (
            <span className="mt-3 inline-block rounded-full border border-emerald-300/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-100">
              Administrator
            </span>
          ) : null}
          <p className="mt-6 text-sm text-white/60">
            The dashboard, leads workspace, and admin tools land here in the
            following phases. For now this is the post-sign-in landing pad
            that proves auth + DB are wired end-to-end.
          </p>
        </section>
      </div>
    </div>
  );
}
