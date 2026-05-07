// Phase 6E — sha256 dedup key for imported activities. Lets re-imports
// be idempotent: the same lead_id + kind + occurred_at + body-prefix
// hashes to the same key, so a second pass over the same file skips
// the activity instead of duplicating it.
//
// Manually-created activities have NULL import_dedup_key and are never
// matched against imports.

import { createHash } from "node:crypto";

const BODY_HASH_LENGTH = 200;

export function computeImportDedupKey(args: {
  leadId: string;
  kind: "call" | "meeting" | "note" | "email";
  occurredAt: Date;
  body: string;
}): string {
  const bodyPrefix = (args.body ?? "").slice(0, BODY_HASH_LENGTH);
  const payload = [
    args.leadId,
    args.kind,
    args.occurredAt.toISOString(),
    bodyPrefix,
  ].join(":");
  return createHash("sha256").update(payload).digest("hex");
}
