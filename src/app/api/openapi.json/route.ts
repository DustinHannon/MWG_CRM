import { buildOpenApiSpec } from "@/lib/openapi/registry";

// Force re-evaluation per request so route registrations performed at
// module-load time (each /api/v1 route imports the registry singleton)
// reach the spec without us hand-importing every route here. In
// practice the route handlers are loaded by Next when their routes
// are first hit, so this endpoint may need a warm-up — see
// src/lib/openapi/preload.ts which is imported below to force eager
// registration.
import "@/lib/openapi/preload";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 13 — public OpenAPI 3.1 document. The Scalar docs page at
 * /apihelp fetches from this URL. No authentication required —
 * the spec describes the API contract; secrets it does not contain.
 */
export async function GET() {
  const spec = buildOpenApiSpec();
  return Response.json(spec, {
    headers: {
      // Public spec — let CDNs cache for a few minutes between deploys.
      "Cache-Control": "public, max-age=120, s-maxage=120",
    },
  });
}
