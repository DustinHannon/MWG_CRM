import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";
import { openapiZ as z, registry } from "@/lib/openapi/registry";
import { UserSummarySchema } from "@/lib/api/v1/meta-schemas";
import { ErrorBodySchema } from "@/lib/api/v1/schemas";
import { serializeUserSummary } from "@/lib/api/v1/serializers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const IdParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ example: "00000000-0000-0000-0000-000000000111" }),
});

registry.registerPath({
  method: "get",
  path: "/users/{id}",
  summary: "Get user by id",
  description: "Returns a single CRM user. Requires the `admin` scope.",
  tags: ["Users"],
  security: [{ BearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: UserSummarySchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

export const GET = withApi<{ id: string }>(
  { scope: "admin", action: "users.get" },
  async (_req, { params }) => {
    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.id, params.id))
      .limit(1);
    if (!row) return errorResponse(404, "NOT_FOUND", "User not found");
    return Response.json(serializeUserSummary(row));
  },
);
