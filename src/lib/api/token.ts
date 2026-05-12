import "server-only";
import { createHash, randomBytes } from "node:crypto";

/**
 * token generation. Uses base32 (Crockford alphabet,
 * minus ambiguous I/L/O/U) over 32 chars. ~5 bits per char × 32 =
 * 160 bits of entropy, well above the 128-bit threshold for HMAC-
 * style API keys.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // 32 chars, no I/L/O/U
const TOKEN_LEN = 32;
const PREFIX = "mwg_live_";

export function generatePlaintextToken(): string {
  // randomBytes draws from the OS CSPRNG. Using floor(byte / 8) gives
  // bits 0–4 → 32-value range with the high bits left over; close
  // enough to uniform for a 32-char ID but we mod-32 to be safe.
  const buf = randomBytes(TOKEN_LEN);
  let out = "";
  for (let i = 0; i < TOKEN_LEN; i++) {
    out += ALPHABET[buf[i] % 32];
  }
  return PREFIX + out;
}

export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function tokenPrefix(plaintext: string): string {
  // First 12 chars of plaintext for display ("mwg_live_ABC"). The full
  // 9-char `mwg_live_` literal eats most of that; the visible suffix
  // is the next 3 chars. Admins use this purely as a fingerprint.
  return plaintext.slice(0, 12);
}
