import "server-only";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

/**
 * single OpenAPI registry. Every /api/v1 route file imports
 * this module's `registry` and calls `registerPath(...)` to add itself
 * to the spec. `buildOpenApiSpec()` collects everything and emits an
 * OpenAPI 3.1 document.
 *
 * The registry singleton persists across requests in the same Lambda;
 * registrations are idempotent so module re-evaluation under HMR
 * doesn't double-register. Register at module top-level (file is
 * imported once when the route handler is loaded).
 */

extendZodWithOpenApi(z);

export { z as openapiZ };

export const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "BearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "API Key",
  description:
    "Bearer token. Obtain from /admin/api-keys (admin access required). " +
    "Format: `Authorization: Bearer mwg_live_xxxxxxxxxxxxxxxx`",
});

export function buildOpenApiSpec() {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "MWG CRM API",
      version: "1.0.0",
      description:
        "Public REST API for Morgan White Group CRM. All endpoints " +
        "require Bearer-token authentication. Tokens are issued from " +
        "/admin/api-keys by an MWG administrator.",
      contact: {
        name: "MWG IT",
        email: "crm-support@morganwhite.com",
      },
    },
    servers: [
      {
        url: "https://mwg-crm.vercel.app/api/v1",
        description: "Production",
      },
    ],
    security: [{ BearerAuth: [] }],
  });
}
