/**
 * Phase 29 §7 — Thin POST client for the MWG CRM receiving endpoints.
 *
 * One key, three endpoints:
 *   /admin/migrations/clickdimensions/templates       — per-template upsert
 *   /admin/migrations/clickdimensions/run-started     — audit on launch
 *   /admin/migrations/clickdimensions/run-summary     — audit on completion
 *   /admin/migrations/clickdimensions/session-expired — audit on auth loss
 *
 * Uses undici's fetch so the node version doesn't matter.
 */

import { fetch } from "undici";
import type { ExtractedTemplate, ScriptConfig } from "./types.js";

async function postJson(
  cfg: ScriptConfig,
  pathSuffix: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const url = `${cfg.mwgApiBase.replace(/\/$/, "")}/admin/migrations/clickdimensions/${pathSuffix}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.mwgApiKey}`,
    },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  const text = await res.text();
  try {
    data = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

export async function postTemplate(
  cfg: ScriptConfig,
  tpl: ExtractedTemplate,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  return postJson(cfg, "templates", {
    cdTemplateId: tpl.cdTemplateId,
    cdTemplateName: tpl.cdTemplateName,
    cdSubject: tpl.cdSubject ?? null,
    cdCategory: tpl.cdCategory ?? null,
    cdOwner: tpl.cdOwner ?? null,
    cdCreatedAt: tpl.cdCreatedAt ?? null,
    cdModifiedAt: tpl.cdModifiedAt ?? null,
    editorType: tpl.editorType,
    rawHtml: tpl.rawHtml,
    status: tpl.status,
    errorReason: tpl.errorReason ?? null,
  });
}

export async function postRunStarted(
  cfg: ScriptConfig,
  payload: {
    runId: string;
    totalCandidateCount?: number;
    limit?: number;
    hostname?: string;
  },
): Promise<{ ok: boolean; status: number }> {
  const res = await postJson(cfg, "run-started", payload);
  return { ok: res.ok, status: res.status };
}

export async function postRunSummary(
  cfg: ScriptConfig,
  payload: {
    runId: string;
    total: number;
    success: number;
    failed: number;
    skipped?: number;
    durationMs: number;
    reason?:
      | "completed"
      | "limit_reached"
      | "session_expired"
      | "aborted";
  },
): Promise<{ ok: boolean; status: number }> {
  const res = await postJson(cfg, "run-summary", payload);
  return { ok: res.ok, status: res.status };
}

export async function postSessionExpired(
  cfg: ScriptConfig,
  payload: {
    runId: string;
    processedBeforeExpiry?: number;
    detectedAtUrl?: string;
  },
): Promise<{ ok: boolean; status: number }> {
  const res = await postJson(cfg, "session-expired", payload);
  return { ok: res.ok, status: res.status };
}
