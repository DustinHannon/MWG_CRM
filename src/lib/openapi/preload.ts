import "server-only";

/**
 * Phase 13 — eager registration. Each /api/v1 route file calls
 * `registry.registerPath(...)` at module top level. Next.js loads
 * route handlers on demand, which means the OpenAPI registry only
 * sees a route after it's been hit. To make /api/openapi.json show
 * the complete spec from the first request, we side-import every
 * route module here so the registrations happen at deploy time.
 *
 * Side-effect imports only — these modules are never used by name.
 * Order does not matter; `registerPath` keys by `path + method`.
 *
 * Phase 13B foundation: only the leads-list route is imported here.
 * Phase 13C Sub-A appends imports as it adds CRUD endpoints across
 * the other entities.
 */

// Shared schemas first so route schemas can reference them by ref.
import "@/lib/api/v1/schemas";
import "@/lib/api/v1/lead-schemas";

// Routes (each module registers its own paths at top level).
import "@/app/api/v1/leads/route";

export {};
