/**
 * Phase 29 §7 — Local progress file for the extraction script.
 *
 * Persists already-processed cd_template_ids so a mid-run crash or
 * session-expiry re-launch picks up where it left off. The server-side
 * idempotency on `cd_template_id` is the canonical source of truth —
 * this file is purely a client-side optimization to avoid re-fetching
 * pages we already pushed.
 */

import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import type { PersistedState, TemplateStatus } from "./types.js";

export async function loadState(
  path: string,
): Promise<PersistedState | null> {
  try {
    const buf = await fs.readFile(path, "utf-8");
    const parsed = JSON.parse(buf) as PersistedState;
    if (
      typeof parsed.runId !== "string" ||
      typeof parsed.startedAtIso !== "string" ||
      typeof parsed.processed !== "object" ||
      parsed.processed === null
    ) {
      return null;
    }
    return parsed;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function newState(): PersistedState {
  return {
    runId: `cd-${crypto.randomUUID()}`,
    startedAtIso: new Date().toISOString(),
    processed: {},
  };
}

export async function saveState(
  path: string,
  state: PersistedState,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
  await fs.rename(tmp, path);
}

export function markProcessed(
  state: PersistedState,
  cdTemplateId: string,
  status: TemplateStatus,
): void {
  state.processed[cdTemplateId] = status;
}

export function isProcessed(
  state: PersistedState,
  cdTemplateId: string,
): boolean {
  return state.processed[cdTemplateId] !== undefined;
}
