import "server-only";

/**
 * eager registration. Each /api/v1 route file calls
 * `registry.registerPath(...)` at module top level. Next.js loads
 * route handlers on demand, which means the OpenAPI registry only
 * sees a route after it's been hit. To make /api/openapi.json show
 * the complete spec from the first request, we side-import every
 * route module here so the registrations happen at deploy time.
 *
 * Side-effect imports only — these modules are never used by name.
 * Order does not matter; `registerPath` keys by `path + method`.
 */

// Shared schemas first so route schemas can reference them by ref.
import "@/lib/api/v1/schemas";
import "@/lib/api/v1/lead-schemas";
import "@/lib/api/v1/account-schemas";
import "@/lib/api/v1/contact-schemas";
import "@/lib/api/v1/opportunity-schemas";
import "@/lib/api/v1/task-schemas";
import "@/lib/api/v1/activity-schemas";
import "@/lib/api/v1/meta-schemas";

// Routes (each module registers its own paths at top level).
import "@/app/api/v1/leads/route";
import "@/app/api/v1/leads/[id]/route";
import "@/app/api/v1/accounts/route";
import "@/app/api/v1/accounts/[id]/route";
import "@/app/api/v1/contacts/route";
import "@/app/api/v1/contacts/[id]/route";
import "@/app/api/v1/opportunities/route";
import "@/app/api/v1/opportunities/[id]/route";
import "@/app/api/v1/tasks/route";
import "@/app/api/v1/tasks/[id]/route";
import "@/app/api/v1/activities/route";
import "@/app/api/v1/activities/[id]/route";
import "@/app/api/v1/me/route";
import "@/app/api/v1/users/route";
import "@/app/api/v1/users/[id]/route";

export {};
