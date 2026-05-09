import { count, desc } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";
import { openapiZ as z, registry } from "@/lib/openapi/registry";
import { UserListResponseSchema } from "@/lib/api/v1/meta-schemas";
import { ErrorBodySchema } from "@/lib/api/v1/schemas";
import { serializeUserSummary } from "@/lib/api/v1/serializers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UserListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).openapi({ example: 1 }),
  pageSize: z.coerce
    .number()
    .int()
    .min(10)
    .max(200)
    .default(50)
    .openapi({ example: 50 }),
});

registry.registerPath({
  method: "get",
  path: "/users",
  summary: "List users",
  description:
    "Returns a paginated list of CRM users. Requires the `admin` scope.",
  tags: ["Users"],
  security: [{ BearerAuth: [] }],
  request: { query: UserListQuerySchema },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: UserListResponseSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

export const GET = withApi(
  { scope: "admin", action: "users.list" },
  async (req) => {
    const url = new URL(req.url);
    const parsed = UserListQuerySchema.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );
    if (!parsed.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid query parameters", {
        details: parsed.error.errors.map((e) => ({
          field: e.path.join("."),
          issue: e.message,
        })),
      });
    }
    const offset = (parsed.data.page - 1) * parsed.data.pageSize;
    const [rows, totalRow] = await Promise.all([
      db.select().from(users).orderBy(desc(users.createdAt)).limit(parsed.data.pageSize).offset(offset),
      db.select({ n: count() }).from(users),
    ]);
    return Response.json({
      data: rows.map((r) => serializeUserSummary(r)),
      meta: {
        page: parsed.data.page,
        page_size: parsed.data.pageSize,
        total: totalRow[0]?.n ?? 0,
        total_pages: Math.max(
          1,
          Math.ceil((totalRow[0]?.n ?? 0) / parsed.data.pageSize),
        ),
      },
    });
  },
);
