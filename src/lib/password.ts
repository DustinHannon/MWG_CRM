import "server-only";
import { hash, verify } from "@node-rs/argon2";

/**
 * argon2id parameters tuned for ~100ms on a typical Vercel Fluid Compute
 * worker. Verifying takes the same time. These can be raised later as
 * hardware improves; argon2 supports rolling upgrades automatically because
 * each hash carries its own parameters.
 *
 * argon2id is @node-rs/argon2's default algorithm — we don't set
 * `algorithm` explicitly because the exported `Algorithm` enum is a
 * const enum and `isolatedModules: true` rejects it.
 */
const PARAMS = {
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, PARAMS);
}

/**
 * Returns true on match, false otherwise. Never throws on mismatch — only
 * throws if the stored hash is malformed.
 */
export async function verifyPassword(
  plaintext: string,
  stored: string,
): Promise<boolean> {
  try {
    return await verify(stored, plaintext);
  } catch {
    return false;
  }
}
