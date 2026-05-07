// One-shot helper: generate a fresh breakglass password, hash with argon2id
// using the same params as src/lib/password.ts, and print the password +
// hash. Operator copies the hash into a Supabase UPDATE statement.
//
// Usage: node scripts/rotate-breakglass-local.mjs
import { hash } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";

const PARAMS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

const plaintext = randomBytes(24).toString("base64url");
const passwordHash = await hash(plaintext, PARAMS);

process.stdout.write(`PLAINTEXT=${plaintext}\nHASH=${passwordHash}\n`);
