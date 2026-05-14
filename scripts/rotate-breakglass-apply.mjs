// One-shot operator helper: generate a fresh breakglass password, hash it
// with argon2id (same params as src/lib/password.ts), apply the hash to the
// singleton breakglass row, and print the plaintext for capture.
//
// Use when the breakglass credential is lost or rotation is needed and the
// user cannot reach Supabase Studio. Reads POSTGRES_URL from .env.local
// or the shell env.
//
// Usage:
//   pnpm dlx tsx --env-file .env.local scripts/rotate-breakglass-apply.mjs
//
// The plaintext is printed to stdout exactly once. Capture it from the
// terminal output; the script does NOT persist plaintext anywhere.

import { hash } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const PARAMS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

const url = process.env.POSTGRES_URL;
if (!url) {
  console.error("POSTGRES_URL not set; pass --env-file .env.local");
  process.exit(1);
}

const plaintext = randomBytes(24).toString("base64url");
const passwordHash = await hash(plaintext, PARAMS);

const client = postgres(url, {
  prepare: false,
  max: 1,
  ssl: "require",
  connection: { search_path: "public, extensions" },
});

try {
  const rows = await client`
    UPDATE users
       SET password_hash = ${passwordHash},
           session_version = session_version + 1,
           updated_at = now()
     WHERE is_breakglass = true
    RETURNING id, username, email
  `;
  if (rows.length === 0) {
    console.error("No breakglass row found (is_breakglass=true). Cannot rotate.");
    process.exitCode = 1;
  } else {
    const row = rows[0];
    console.log(`[rotated] ${row.username} (${row.email}) — id ${row.id}`);
    console.log(``);
    console.log(`PLAINTEXT=${plaintext}`);
  }
} catch (err) {
  console.error("Rotation failed:", err);
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
