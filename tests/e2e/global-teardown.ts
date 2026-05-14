import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Phase 12 — runs after the entire suite completes. Invokes the
 * cleanup script as a separate process so its `import "server-only"`
 * dependencies (Drizzle + postgres) load against the real DB
 * connection without colliding with Playwright's worker scope.
 */
export default async function globalTeardown() {
  if (process.env.E2E_SKIP_CLEANUP === "true") {
    console.log("[cleanup] skipped (E2E_SKIP_CLEANUP=true)");
    return;
  }
  const script = path.join(__dirname, "cleanup.ts");
  const result = spawnSync(
    "pnpm",
    ["tsx", script],
    {
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    },
  );
  if (result.status !== 0) {
    console.warn(
      `[cleanup] script exited with ${result.status}; check production for stragglers tagged with the current E2E_RUN_ID`,
    );
  }
}
