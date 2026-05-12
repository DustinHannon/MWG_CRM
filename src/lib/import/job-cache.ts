// in-process cache for the parsed rows between
// preview and commit. The user clicks Commit on the same instance
// that handled the preview within the cache TTL; if it expired or
// the request hits a different region, we surface a friendly
// "preview expired, please re-upload."
//
// This is intentionally simple. A future revision can move it to
// the Vercel Runtime Cache (per-region key/value), but the in-memory
// version is correct for the single-region deploy and avoids extra
// roundtrips on the hot path.

import "server-only";
import type { ParseResult } from "./parse-row";

interface CachedJob {
  jobId: string;
  userId: string;
  fileName: string;
  smartDetect: boolean;
  parseRows: ParseResult[];
  unknownHeaders: string[];
  missingRequiredHeaders: string[];
  expiresAt: number;
}

const TTL_MS = 15 * 60 * 1000;
const CACHE = new Map<string, CachedJob>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [key, value] of CACHE) {
    if (value.expiresAt <= now) CACHE.delete(key);
  }
}

export function putJob(job: Omit<CachedJob, "expiresAt">): void {
  purgeExpired();
  CACHE.set(job.jobId, { ...job, expiresAt: Date.now() + TTL_MS });
}

export function getJob(jobId: string, userId: string): CachedJob | null {
  purgeExpired();
  const job = CACHE.get(jobId);
  if (!job) return null;
  if (job.userId !== userId) return null;
  return job;
}

export function deleteJob(jobId: string): void {
  CACHE.delete(jobId);
}
