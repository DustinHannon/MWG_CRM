import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { ValidationError } from "@/lib/errors";

/**
 * undo token. HMAC-SHA256 over the canonical
 * "<entity>:<id>:<deletedAtIso>" payload, with a 5-second expiry built
 * into the issuance window. Used by the toast Undo button to restore a
 * just-archived record. The token is tiny and round-trippable through
 * a button onClick → server action.
 *
 * Format: <base64url-payload>.<base64url-signature>
 * payload = JSON.stringify({ entity, id, deletedAt, exp })
 *
 * Why HMAC and not a DB row? The undo window is 5 seconds and the only
 * payload is "what to restore." A signed token avoids a DB roundtrip
 * for issuance/verification and self-expires.
 */

export type EntityKind =
  | "lead"
  | "account"
  | "contact"
  | "opportunity"
  | "task"
  | "activity";

export interface UndoTokenPayload {
  entity: EntityKind;
  id: string;
  deletedAt: string; // ISO
  exp: number; // ms epoch
}

const TTL_MS = 5_000;

function getSecret(): string {
  // Reuse AUTH_SECRET — it's already required, we don't add a new env var
  // surface for one feature with a 5-second blast radius.
  const s = env.AUTH_SECRET ?? process.env.AUTH_SECRET ?? "";
  // invariant: AUTH_SECRET is required by Auth.js v5 itself — the app
  // can't boot without it. Reaching here means a runtime mutation of
  // process.env after boot, which is a deployment-level bug.
  if (!s) throw new Error("AUTH_SECRET is required for undo tokens");
  return s;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function signUndoToken(args: {
  entity: EntityKind;
  id: string;
  deletedAt: Date;
}): string {
  const payload: UndoTokenPayload = {
    entity: args.entity,
    id: args.id,
    deletedAt: args.deletedAt.toISOString(),
    exp: Date.now() + TTL_MS,
  };
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = b64url(Buffer.from(payloadJson, "utf8"));
  const sig = createHmac("sha256", getSecret()).update(payloadB64).digest();
  return `${payloadB64}.${b64url(sig)}`;
}

export function verifyUndoToken(token: string): UndoTokenPayload {
  const dot = token.indexOf(".");
  if (dot === -1) throw new ValidationError("Invalid undo token");
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  const expectedSig = createHmac("sha256", getSecret()).update(payloadB64).digest();
  const givenSig = b64urlDecode(sigB64);
  if (givenSig.length !== expectedSig.length) {
    throw new ValidationError("Invalid undo token");
  }
  if (!timingSafeEqual(givenSig, expectedSig)) {
    throw new ValidationError("Invalid undo token");
  }

  let payload: UndoTokenPayload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8"));
  } catch {
    throw new ValidationError("Malformed undo token");
  }
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) {
    throw new ValidationError("Undo window expired — restore from the archive view.");
  }
  return payload;
}
