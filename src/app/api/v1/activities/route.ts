import {
  createActivityForApi,
  getActivityForApi,
  listActivitiesForApi,
  verifyActivityParent,
  type ParentKind,
} from "@/lib/activities";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";
import { registry } from "@/lib/openapi/registry";
import {
  ActivityCreateSchema,
  ActivityListQuerySchema,
  ActivityListResponseSchema,
  ActivitySchema,
} from "@/lib/api/v1/activity-schemas";
import { ErrorBodySchema } from "@/lib/api/v1/schemas";
import { serializeActivity } from "@/lib/api/v1/serializers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ACTIVITY_DESCRIPTION =
  "API keys see all org-owned activities regardless of which user " +
  "generated the key.";

registry.registerPath({
  method: "get",
  path: "/activities",
  summary: "List activities",
  description: "Returns a paginated list of activities. " + ACTIVITY_DESCRIPTION,
  tags: ["Activities"],
  security: [{ BearerAuth: [] }],
  request: { query: ActivityListQuerySchema },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ActivityListResponseSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/activities",
  summary: "Create activity",
  description:
    "Creates a new activity (note/call/meeting/email/task). Exactly ONE " +
    "parent FK (`lead_id`, `account_id`, `contact_id`, or `opportunity_id`) " +
    "must be supplied. The parent must exist and not be archived — " +
    "otherwise the request returns 422 with a `parent_archived` or " +
    "`parent_missing` issue detail.",
  tags: ["Activities"],
  security: [{ BearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: ActivityCreateSchema } } },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: ActivitySchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

export const GET = withApi(
  { scope: "read:activities", action: "activities.list" },
  async (req, { key }) => {
    const url = new URL(req.url);
    const parsed = ActivityListQuerySchema.safeParse(
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
    const result = await listActivitiesForApi({
      leadId: parsed.data.lead_id,
      accountId: parsed.data.account_id,
      contactId: parsed.data.contact_id,
      opportunityId: parsed.data.opportunity_id,
      kind: parsed.data.kind,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      ownerScope: { actorId: key.createdById, canViewAll: true },
    });
    return Response.json({
      data: result.rows.map((r) => serializeActivity(r)),
      meta: {
        page: result.page,
        page_size: result.pageSize,
        total: result.total,
        total_pages: Math.max(1, Math.ceil(result.total / result.pageSize)),
      },
    });
  },
);

export const POST = withApi(
  { scope: "write:activities", action: "activities.create" },
  async (req, { key }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Body must be valid JSON");
    }
    const parsed = ActivityCreateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid request body", {
        details: parsed.error.errors.map((e) => ({
          field: e.path.join("."),
          issue: e.message,
        })),
      });
    }
    const m = parsed.data;
    const parents: Array<{ kind: ParentKind; id: string; field: string }> = [];
    if (m.lead_id) parents.push({ kind: "lead", id: m.lead_id, field: "lead_id" });
    if (m.account_id) parents.push({ kind: "account", id: m.account_id, field: "account_id" });
    if (m.contact_id) parents.push({ kind: "contact", id: m.contact_id, field: "contact_id" });
    if (m.opportunity_id) {
      parents.push({ kind: "opportunity", id: m.opportunity_id, field: "opportunity_id" });
    }
    if (parents.length === 0) {
      return errorResponse(
        422,
        "VALIDATION_ERROR",
        "Exactly one parent FK is required (lead_id / account_id / contact_id / opportunity_id).",
        { details: [{ issue: "no_parent" }] },
      );
    }
    if (parents.length > 1) {
      return errorResponse(
        422,
        "VALIDATION_ERROR",
        "Exactly one parent FK is allowed; multiple supplied.",
        { details: parents.map((p) => ({ field: p.field, issue: "extra_parent" })) },
      );
    }
    const parent = parents[0];
    const verify = await verifyActivityParent(parent.kind, parent.id);
    if (!verify.ok) {
      return errorResponse(
        422,
        "VALIDATION_ERROR",
        verify.reason === "archived"
          ? "Parent record is archived"
          : "Parent record not found",
        {
          details: [
            {
              field: parent.field,
              issue: verify.reason === "archived" ? "parent_archived" : "parent_missing",
            },
          ],
        },
      );
    }

    const created = await createActivityForApi({
      leadId: parent.kind === "lead" ? parent.id : null,
      accountId: parent.kind === "account" ? parent.id : null,
      contactId: parent.kind === "contact" ? parent.id : null,
      opportunityId: parent.kind === "opportunity" ? parent.id : null,
      userId: key.createdById,
      kind: m.kind,
      direction: m.direction ?? null,
      subject: m.subject ?? null,
      body: m.body ?? null,
      occurredAt: m.occurred_at ? new Date(m.occurred_at) : null,
      durationMinutes: m.duration_minutes ?? null,
      outcome: m.outcome ?? null,
    });
    const fresh = await getActivityForApi(created.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    return Response.json(
      fresh ? serializeActivity(fresh) : { id: created.id },
      { status: 201 },
    );
  },
);
