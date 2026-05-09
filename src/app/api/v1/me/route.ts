import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys } from "@/db/schema/api-keys";
import { users } from "@/db/schema/users";
import { withApi } from "@/lib/api/handler";
import { registry } from "@/lib/openapi/registry";
import { ALL_SCOPES } from "@/lib/api/scopes";
import { MeSchema } from "@/lib/api/v1/meta-schemas";
import { ErrorBodySchema } from "@/lib/api/v1/schemas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registry.registerPath({
  method: "get",
  path: "/me",
  summary: "Inspect the current key",
  description:
    "Returns the API key that authenticated this request, the user " +
    "who created it, and the catalogue of valid scope names. Any valid " +
    "key may call this endpoint regardless of scopes.",
  tags: ["Meta"],
  security: [{ BearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: MeSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

export const GET = withApi(
  { scope: null, action: "me.get" },
  async (_req, { key }) => {
    const [keyRow] = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.keyPrefix,
        scopes: apiKeys.scopes,
        rateLimitPerMinute: apiKeys.rateLimitPerMinute,
        expiresAt: apiKeys.expiresAt,
        lastUsedAt: apiKeys.lastUsedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.id, key.id))
      .limit(1);
    const [creatorRow] = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        isAdmin: users.isAdmin,
      })
      .from(users)
      .where(eq(users.id, key.createdById))
      .limit(1);

    return Response.json({
      api_key: {
        id: keyRow.id,
        name: keyRow.name,
        prefix: keyRow.prefix,
        scopes: keyRow.scopes,
        rate_limit_per_minute: keyRow.rateLimitPerMinute,
        expires_at: keyRow.expiresAt ? keyRow.expiresAt.toISOString() : null,
        last_used_at: keyRow.lastUsedAt ? keyRow.lastUsedAt.toISOString() : null,
      },
      creator: creatorRow
        ? {
            id: creatorRow.id,
            email: creatorRow.email,
            display_name: creatorRow.displayName,
            is_admin: creatorRow.isAdmin,
          }
        : null,
      available_scopes: [...ALL_SCOPES],
    });
  },
);
