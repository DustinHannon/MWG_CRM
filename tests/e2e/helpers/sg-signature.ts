/**
 * Phase 22 — SendGrid ECDSA signature helper for adversarial webhook tests.
 *
 * Generates a fresh test-only ECDSA P-256 keypair PER PROCESS so the
 * signing key never lands on disk. Tests that need the receiver to
 * actually accept a forged-but-valid signature would need the live
 * SENDGRID_WEBHOOK_PUBLIC_KEY to match — which we cannot supply from a
 * test. So all webhook tests target REJECT paths (bad sig, replay,
 * oversize, dupe, rate-limit). Acceptance is exercised by SendGrid
 * itself in production.
 */
import { createPrivateKey, createSign, generateKeyPairSync } from "node:crypto";

export interface SgKeypair {
  privateKeyPem: string;
  publicKeyPem: string;
}

let cached: SgKeypair | null = null;

export function getTestKeypair(): SgKeypair {
  if (cached) return cached;
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  cached = { privateKeyPem: privateKey, publicKeyPem: publicKey };
  return cached;
}

/**
 * Produce a signature header value for `${timestamp}${rawBody}` per
 * SendGrid's signed event webhook spec. Matches @sendgrid/eventwebhook
 * verification format (DER ECDSA over SHA-256, base64).
 */
export function signSendGridEvent(
  rawBody: string,
  timestamp: string,
  privateKeyPem: string,
): string {
  const key = createPrivateKey({ key: privateKeyPem, format: "pem" });
  const signer = createSign("sha256");
  signer.update(timestamp + rawBody);
  signer.end();
  return signer.sign(key).toString("base64");
}
