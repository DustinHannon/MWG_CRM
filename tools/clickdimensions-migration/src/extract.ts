/**
 * Phase 29 §7 — Main extraction script.
 *
 * Reads storage.json, enumerates templates, processes them one at a
 * time (concurrency=1), POSTs each to MWG CRM, and saves resume state
 * after every row.
 *
 * Halts gracefully if redirected to a sign-in page mid-run; an
 * operator must re-auth (delete storage.json + re-run auth.ts).
 */

import "dotenv/config";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type {
  ExtractedTemplate,
  ScriptConfig,
  TemplateCandidate,
} from "./types.js";
import { detectEditorType, extractByEditorType } from "./editor-handlers/index.js";
import { enumerateTemplates } from "./enumerate.js";
import { isProcessed, loadState, markProcessed, newState, saveState } from "./state.js";
import {
  postRunStarted,
  postRunSummary,
  postSessionExpired,
  postTemplate,
} from "./api-client.js";

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const parsed = Number.parseInt(v, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadConfig(): ScriptConfig {
  const args = process.argv.slice(2);
  let limit: number | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit") {
      const n = Number.parseInt(args[i + 1] ?? "", 10);
      if (Number.isFinite(n) && n > 0) limit = n;
      i++;
    }
  }
  const cdBaseUrl =
    process.env.CD_BASE_URL ?? "https://mwgroup.crm.dynamics.com";
  const mwgApiBase =
    process.env.MWG_API_BASE ?? "https://mwg-crm.vercel.app/api/v1";
  const mwgApiKey = process.env.MWG_API_KEY ?? "";
  if (mwgApiKey.length === 0) {
    throw new Error(
      "MWG_API_KEY is not set. Generate one at /admin/api-keys with scope marketing.migrations.api.",
    );
  }
  return {
    cdBaseUrl,
    cdTemplatesUrl: process.env.CD_TEMPLATES_URL ?? null,
    mwgApiBase,
    mwgApiKey,
    concurrency: intEnv("CD_EXTRACTION_CONCURRENCY", 1),
    perTemplateTimeoutMs: intEnv("CD_EXTRACTION_TIMEOUT_MS", 60000),
    storageStatePath: process.env.STORAGE_STATE_PATH ?? "storage.json",
    extractionStatePath:
      process.env.EXTRACTION_STATE_PATH ?? "extraction-state.json",
    limit,
  };
}

async function isSignedOut(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  return (
    url.includes("login.microsoftonline.com") ||
    url.includes("/_forms/login") ||
    url.includes("login.live.com")
  );
}

async function processOne(
  cfg: ScriptConfig,
  page: Page,
  candidate: TemplateCandidate,
): Promise<ExtractedTemplate> {
  const start = Date.now();
  try {
    await page.goto(candidate.detailUrl, {
      timeout: cfg.perTemplateTimeoutMs,
      waitUntil: "domcontentloaded",
    });
  } catch (err: unknown) {
    return {
      ...candidate,
      editorType: "unknown",
      rawHtml: null,
      status: "failed",
      errorReason: `Navigation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (await isSignedOut(page)) {
    // Caller checks for failed.errorReason="session_expired" to halt.
    return {
      ...candidate,
      editorType: "unknown",
      rawHtml: null,
      status: "failed",
      errorReason: "session_expired",
    };
  }

  const editorType = await detectEditorType(page);
  let html: string | null = null;
  let errorReason: string | null = null;
  try {
    const extractPromise = extractByEditorType(page, editorType);
    const elapsed = Date.now() - start;
    const remaining = Math.max(1, cfg.perTemplateTimeoutMs - elapsed);
    html = await Promise.race<string>([
      extractPromise,
      new Promise<string>((_, rej) =>
        setTimeout(() => rej(new Error("per_template_timeout")), remaining),
      ),
    ]);
  } catch (err: unknown) {
    errorReason =
      err instanceof Error
        ? err.message
        : `Extraction failed: ${String(err)}`;
  }

  if (!html || html.trim().length === 0) {
    return {
      ...candidate,
      editorType,
      rawHtml: null,
      status: "failed",
      errorReason: errorReason ?? "no_html_captured",
    };
  }

  return {
    ...candidate,
    editorType,
    rawHtml: html,
    status: "extracted",
    errorReason: null,
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const stateExisting = await loadState(cfg.extractionStatePath);
  const state = stateExisting ?? newState();
  if (!stateExisting) {
    await saveState(cfg.extractionStatePath, state);
  }

  // Storage file must exist — otherwise we cannot reuse the auth session.
  try {
    await fs.access(cfg.storageStatePath);
  } catch {
    throw new Error(
      `Storage state file not found at ${cfg.storageStatePath}. Run "npm run auth" first.`,
    );
  }

  const browser: Browser = await chromium.launch({ headless: false });
  const ctx: BrowserContext = await browser.newContext({
    storageState: cfg.storageStatePath,
  });
  const page = await ctx.newPage();

  const startedAt = Date.now();
  let success = 0;
  let failed = 0;
  let skipped = 0;
  let total = 0;
  let endReason:
    | "completed"
    | "limit_reached"
    | "session_expired"
    | "aborted" = "completed";

  try {
    // Land on the CD templates list.
    const landUrl = cfg.cdTemplatesUrl ?? cfg.cdBaseUrl;
    await page.goto(landUrl, { waitUntil: "domcontentloaded" });
    if (await isSignedOut(page)) {
      endReason = "session_expired";
      await postSessionExpired(cfg, {
        runId: state.runId,
        processedBeforeExpiry: 0,
        detectedAtUrl: page.url(),
      });
      console.error("Session expired before enumeration. Re-run auth.ts.");
      return;
    }

    const candidates = await enumerateTemplates(page, {
      limit: cfg.limit,
      maxPages: 200,
    });
    total = candidates.length;
    console.log(`Enumerated ${candidates.length} templates.`);

    await postRunStarted(cfg, {
      runId: state.runId,
      totalCandidateCount: candidates.length,
      limit: cfg.limit ?? undefined,
      hostname: os.hostname(),
    });

    for (const cand of candidates) {
      if (isProcessed(state, cand.cdTemplateId)) {
        skipped++;
        continue;
      }

      const out = await processOne(cfg, page, cand);

      if (out.status === "failed" && out.errorReason === "session_expired") {
        endReason = "session_expired";
        await postSessionExpired(cfg, {
          runId: state.runId,
          processedBeforeExpiry: success + failed,
          detectedAtUrl: page.url(),
        });
        console.error("Session expired mid-run. Re-run auth.ts and resume.");
        break;
      }

      const res = await postTemplate(cfg, out);
      if (!res.ok) {
        failed++;
        console.error(
          `POST failed for ${cand.cdTemplateId} (HTTP ${res.status}):`,
          res.data,
        );
        markProcessed(state, cand.cdTemplateId, "failed");
      } else {
        if (out.status === "extracted") success++;
        else failed++;
        markProcessed(state, cand.cdTemplateId, out.status);
      }
      await saveState(cfg.extractionStatePath, state);

      if (cfg.limit !== null && success + failed >= cfg.limit) {
        endReason = "limit_reached";
        break;
      }
    }
  } catch (err: unknown) {
    endReason = "aborted";
    console.error(
      `Aborted: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    const durationMs = Date.now() - startedAt;
    await postRunSummary(cfg, {
      runId: state.runId,
      total,
      success,
      failed,
      skipped,
      durationMs,
      reason: endReason,
    });
    await browser.close();
    console.log(
      `Run complete: ${success}/${total} succeeded, ${failed} failed, ${skipped} pre-skipped (${endReason}).`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
