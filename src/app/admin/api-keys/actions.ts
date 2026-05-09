"use server";

import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys } from "@/db/schema/api-keys";
import { writeAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth-helpers";
import {
  generatePlaintextToken,
  hashToken,
  tokenPrefix,
} from "@/lib/api/token";
import { isValidScope, type Scope } from "@/lib/api/scopes";

/**
 * Phase 13 — admin server actions for /admin/api-keys.
 *
 * Plaintext tokens are returned ONCE from `generateApiKeyAction`. They
 * are never persisted or returned again; the caller must capture the
 * value before the modal is dismissed.
 */

export interface GenerateApiKeyInput {
  name: string;
  description?: string | null;
  scopes: string[];
  rateLimitPerMinute: number;
  /** Either an explicit ISO datetime or a number of days from now. */
  expiresAt?: string | null;
  expiresInDays?: number | null;
}

export type GenerateApiKeyResult =
  | {
      ok: true;
      id: string;
      prefix: string;
      plaintext: string;
    }
  | {
      ok: false;
      message: string;
    };

export async function generateApiKeyAction(
  input: GenerateApiKeyInput,
): Promise<GenerateApiKeyResult> {
  const session = await requireAdmin();

  const name = input.name.trim();
  if (!name) {
    return { ok: false, message: "Name is required" };
  }
  if (name.length > 120) {
    return { ok: false, message: "Name must be 120 characters or fewer" };
  }
  if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
    return { ok: false, message: "At least one scope is required" };
  }
  const invalid = input.scopes.filter((s) => !isValidScope(s));
  if (invalid.length > 0) {
    return { ok: false, message: `Invalid scope(s): ${invalid.join(", ")}` };
  }
  if (
    !Number.isInteger(input.rateLimitPerMinute) ||
    input.rateLimitPerMinute < 10 ||
    input.rateLimitPerMinute > 1000
  ) {
    return {
      ok: false,
      message: "Rate limit must be an integer between 10 and 1000",
    };
  }

  let expiresAt: Date | null = null;
  if (input.expiresInDays && input.expiresInDays > 0) {
    expiresAt = new Date(
      Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000,
    );
  } else if (input.expiresAt) {
    const d = new Date(input.expiresAt);
    if (Number.isNaN(d.getTime())) {
      return { ok: false, message: "Invalid expiration date" };
    }
    if (d.getTime() <= Date.now()) {
      return { ok: false, message: "Expiration date must be in the future" };
    }
    expiresAt = d;
  }

  const plaintext = generatePlaintextToken();
  const keyHash = hashToken(plaintext);
  const keyPrefix = tokenPrefix(plaintext);

  const inserted = await db
    .insert(apiKeys)
    .values({
      name,
      description: input.description?.trim() || null,
      keyHash,
      keyPrefix,
      scopes: input.scopes as Scope[],
      rateLimitPerMinute: input.rateLimitPerMinute,
      expiresAt,
      createdById: session.id,
    })
    .returning({ id: apiKeys.id });

  await writeAudit({
    actorId: session.id,
    action: "api_key.create",
    targetType: "api_keys",
    targetId: inserted[0].id,
    after: {
      name,
      prefix: keyPrefix,
      scopes: input.scopes,
      rateLimitPerMinute: input.rateLimitPerMinute,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    },
  });

  return {
    ok: true,
    id: inserted[0].id,
    prefix: keyPrefix,
    plaintext,
  };
}

export async function revokeApiKeyAction(
  id: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const session = await requireAdmin();
  const [row] = await db
    .select({ id: apiKeys.id, name: apiKeys.name, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(eq(apiKeys.id, id))
    .limit(1);
  if (!row) return { ok: false, message: "Key not found" };
  if (row.revokedAt) {
    return { ok: false, message: "Key is already revoked" };
  }
  await db
    .update(apiKeys)
    .set({
      revokedAt: sql`now()`,
      revokedById: session.id,
      updatedAt: sql`now()`,
    })
    .where(eq(apiKeys.id, id));
  await writeAudit({
    actorId: session.id,
    action: "api_key.revoke",
    targetType: "api_keys",
    targetId: id,
    after: { name: row.name },
  });
  return { ok: true };
}

export async function deleteApiKeyAction(
  id: string,
  confirmName: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const session = await requireAdmin();
  const [row] = await db
    .select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.keyPrefix })
    .from(apiKeys)
    .where(eq(apiKeys.id, id))
    .limit(1);
  if (!row) return { ok: false, message: "Key not found" };
  if (confirmName !== row.name) {
    return { ok: false, message: "Confirmation does not match key name" };
  }
  await db.delete(apiKeys).where(eq(apiKeys.id, id));
  await writeAudit({
    actorId: session.id,
    action: "api_key.delete",
    targetType: "api_keys",
    targetId: id,
    before: { name: row.name, prefix: row.prefix },
  });
  return { ok: true };
}
