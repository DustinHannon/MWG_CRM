/**
 * Phase 23 — D365 import test fixture builders.
 *
 * Local-only (file lives under `tests/` which is gitignored). Used by
 * `d365-import.spec.ts` to:
 *
 *  1. Synthesize realistic D365 OData payloads for each entity type
 *     without hitting the live tenant. The mock objects round-trip
 *     through the storage path (`import_records.raw_payload`) so the
 *     mappers built by Sub-agent B can be exercised end-to-end with
 *     deterministic input.
 *
 *  2. Stand up a tiny Node http server that intercepts `D365_BASE_URL`
 *     calls so adversarial / halt-condition cases can simulate
 *     `503 unreachable`, `unmapped picklist`, etc. without real
 *     credentials.
 *
 *  3. Insert an `import_records` row directly when a test needs to
 *     seed a malformed / pre-conflicted record into a batch.
 *
 * All fixtures stamp the `[E2E-${E2E_RUN_ID}]` sentinel into a
 * recognizable text field (subject / description / fullname) so the
 * cleanup pass can scrub stragglers via ILIKE pattern.
 *
 * Imports avoid `server-only` modules so this file works inside the
 * Playwright worker process.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { E2E_RUN_ID, tagName } from "../fixtures/run-id";

// ────────────────────────────────────────────────────────────────────────────
// Types — re-declared lightly so the spec doesn't need server-only imports.
// Source of truth lives at src/lib/d365/types.ts.
// ────────────────────────────────────────────────────────────────────────────

export interface MockD365EntityBase {
  "@odata.etag"?: string;
  createdon?: string;
  modifiedon?: string;
  _createdby_value?: string | null;
  _modifiedby_value?: string | null;
  _ownerid_value?: string | null;
  statecode?: number | null;
  statuscode?: number | null;
}

export interface MockD365Lead extends MockD365EntityBase {
  leadid: string;
  firstname?: string | null;
  lastname?: string | null;
  fullname?: string | null;
  emailaddress1?: string | null;
  telephone1?: string | null;
  jobtitle?: string | null;
  companyname?: string | null;
  subject?: string | null;
  description?: string | null;
  leadsourcecode?: number | null;
  industrycode?: number | null;
  donotemail?: boolean | null;
  donotphone?: boolean | null;
  address1_city?: string | null;
  address1_stateorprovince?: string | null;
  address1_postalcode?: string | null;
  [key: string]: unknown;
}

export interface MockD365Annotation extends MockD365EntityBase {
  annotationid: string;
  subject?: string | null;
  notetext?: string | null;
  objecttypecode?: string | null;
  _objectid_value?: string | null;
  [key: string]: unknown;
}

export interface MockD365SystemUser {
  "@odata.etag"?: string;
  systemuserid: string;
  domainname?: string | null;
  fullname?: string | null;
  internalemailaddress?: string | null;
  isdisabled?: boolean | null;
  applicationid?: string | null;
  [key: string]: unknown;
}

// ────────────────────────────────────────────────────────────────────────────
// Builders.
// ────────────────────────────────────────────────────────────────────────────

/** Lowercase D365-style GUID. */
export function fakeGuid(): string {
  return randomUUID().toLowerCase();
}

let leadCounter = 0;

/**
 * Synthesize a D365Lead-shaped object with the [E2E-${runId}] sentinel
 * baked into firstname so cleanup can scrub.
 *
 * Defaults reflect a "happy path" lead — pickable owner, no DNC flags,
 * statecode=0 (open), statuscode=1 (new).
 */
export function createMockD365Lead(
  overrides: Partial<MockD365Lead> = {},
): MockD365Lead {
  leadCounter += 1;
  const id = ++leadCounter;
  const ts = new Date().toISOString();
  return {
    leadid: fakeGuid(),
    firstname: tagName(`Phase23Lead`),
    lastname: `D365${id}`,
    fullname: tagName(`Phase23Lead D365${id}`),
    emailaddress1: `e2e-d365-lead-${E2E_RUN_ID}-${id}@example.com`,
    telephone1: "+1-555-0123",
    jobtitle: "QA Tester",
    companyname: tagName(`AcmeCo-${id}`),
    subject: "D365 import smoke",
    description: tagName("Imported via Phase 23 fixture"),
    leadsourcecode: 1, // "Advertisement"
    industrycode: 33, // "Technology"
    donotemail: false,
    donotphone: false,
    address1_city: "Jackson",
    address1_stateorprovince: "MS",
    address1_postalcode: "39201",
    statecode: 0,
    statuscode: 1,
    createdon: ts,
    modifiedon: ts,
    "@odata.etag": `W/"${id * 1000}"`,
    _ownerid_value: fakeGuid(),
    _createdby_value: fakeGuid(),
    _modifiedby_value: fakeGuid(),
    ...overrides,
  };
}

let noteCounter = 0;

/** Create an annotation (note) attached to a parent lead/contact. */
export function createMockD365Note(
  parentLeadId: string,
  overrides: Partial<MockD365Annotation> = {},
): MockD365Annotation {
  noteCounter += 1;
  const id = ++noteCounter;
  const ts = new Date().toISOString();
  return {
    annotationid: fakeGuid(),
    subject: tagName(`Note ${id}`),
    notetext: tagName(`Phase 23 note body ${id}`),
    objecttypecode: "lead",
    _objectid_value: parentLeadId,
    createdon: ts,
    modifiedon: ts,
    "@odata.etag": `W/"${id * 1000}"`,
    _ownerid_value: fakeGuid(),
    statecode: 0,
    ...overrides,
  };
}

/** Create a D365 systemuser shape — used for owner-resolution tests. */
export function createMockD365Owner(
  email: string,
  overrides: Partial<MockD365SystemUser> = {},
): MockD365SystemUser {
  return {
    systemuserid: fakeGuid(),
    domainname: email,
    internalemailaddress: email,
    fullname: email.split("@")[0]!,
    isdisabled: false,
    applicationid: null,
    "@odata.etag": `W/"${randomUUID()}"`,
    ...overrides,
  };
}

/**
 * Create a lead with a vintage `createdon` / `modifiedon` for the
 * recency-preservation suite. Year is interpreted as a calendar year.
 */
export function createMockD365LeadWithVintage(
  year: number,
  overrides: Partial<MockD365Lead> = {},
): MockD365Lead {
  const createdAt = new Date(Date.UTC(year, 5, 15, 12, 0, 0)).toISOString();
  return createMockD365Lead({
    createdon: createdAt,
    modifiedon: createdAt,
    ...overrides,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Mock D365 OData server.
//
// Sub-agent A's `D365Client` reads `D365_BASE_URL` from env. For a few
// adversarial / halt-condition tests we need to swap that out for a
// localhost intercept that returns canned errors. Tests pass
// `process.env.D365_BASE_URL = server.url` before invoking the
// pull-batch action and restore on teardown.
// ────────────────────────────────────────────────────────────────────────────

export interface MockD365ServerHandle {
  url: string;
  /** Total requests received. Useful for advisory-lock / dedup tests. */
  requestCount: number;
  /** Last request path & query (for assertion). */
  lastRequest: { path: string; query: string } | null;
  close(): Promise<void>;
}

export type MockD365Handler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> | void;

/**
 * Stand up a localhost http server, run `body(server)`, and tear down.
 * The handler may be sequenced (e.g. fail 3 times, then 200) by the
 * caller using a counter closure.
 */
export async function withMockedD365Server<T>(
  handler: MockD365Handler,
  body: (handle: MockD365ServerHandle) => Promise<T>,
): Promise<T> {
  const handle: MockD365ServerHandle = {
    url: "",
    requestCount: 0,
    lastRequest: null,
    close: async () => {},
  };

  const server: Server = createServer(async (req, res) => {
    handle.requestCount += 1;
    const url = new URL(req.url ?? "/", "http://localhost");
    handle.lastRequest = { path: url.pathname, query: url.search };
    try {
      await handler(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: String(err) } }));
      }
    }
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Mock D365 server failed to bind");
  }
  handle.url = `http://127.0.0.1:${addr.port}`;
  handle.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

  try {
    return await body(handle);
  } finally {
    await handle.close();
  }
}

/** Convenience: handler that 503s the first `n` calls then 200s. */
export function failNTimesThen200(
  n: number,
  okBody: unknown,
): MockD365Handler {
  let calls = 0;
  return (_req, res) => {
    calls += 1;
    if (calls <= n) {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ error: { message: "Service Unavailable (mock)" } }),
      );
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(okBody));
  };
}

/** Always-503 handler used by H-1 halt test. */
export function alwaysServiceUnavailable(): MockD365Handler {
  return (_req, res) => {
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: "Service Unavailable" } }));
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Direct-DB seed helpers.
//
// These bypass the public API to plant a malformed record inside an
// existing batch. Used for halt-condition tests that need a
// pre-existing dirty payload before the mapper runs.
//
// We import the Drizzle client lazily so this file can be parsed by
// Playwright workers that aren't running these tests (they don't need
// DB connectivity).
// ────────────────────────────────────────────────────────────────────────────

export interface InjectImportRecordOptions {
  batchId: string;
  sourceEntityType: string;
  sourceId?: string;
  rawPayload: unknown;
  mappedPayload?: unknown;
  validationWarnings?: unknown;
  status?:
    | "pending"
    | "mapped"
    | "review"
    | "approved"
    | "rejected"
    | "committed"
    | "skipped"
    | "failed";
  conflictResolution?:
    | "none"
    | "dedup_skip"
    | "dedup_merge"
    | "dedup_overwrite"
    | "manual_resolved";
  conflictWith?: string;
}

/**
 * Insert an `import_records` row directly. The caller owns the batch
 * lifecycle — this only writes a single record for a test pre-condition.
 *
 * Lazy-imports the Drizzle DB to avoid loading `server-only` at
 * module-evaluation time inside the Playwright worker.
 */
export async function injectImportRecord(
  opts: InjectImportRecordOptions,
): Promise<{ id: string }> {
  const { db } = require("../../../src/db") as typeof import("../../../src/db");
  const { importRecords } = require(
    "../../../src/db/schema/d365-imports",
  ) as typeof import("../../../src/db/schema/d365-imports");

  const sourceId = opts.sourceId ?? fakeGuid();
  const inserted = await db
    .insert(importRecords)
    .values({
      batchId: opts.batchId,
      sourceEntityType: opts.sourceEntityType,
      sourceId,
      rawPayload: opts.rawPayload as object,
      mappedPayload: (opts.mappedPayload ?? null) as object | null,
      validationWarnings: (opts.validationWarnings ?? null) as object | null,
      status: opts.status ?? "pending",
      conflictResolution: opts.conflictResolution,
      conflictWith: opts.conflictWith,
    })
    .returning({ id: importRecords.id });
  return inserted[0]!;
}

/**
 * Compose a 100-record batch payload as an OData page response. The
 * mock D365 server returns this shape from `/leads`, etc.
 */
export function asODataPage<T>(value: T[], nextLink?: string): unknown {
  return {
    "@odata.context": "https://example.crm.dynamics.com/api/data/v9.2/$metadata#leads",
    value,
    ...(nextLink ? { "@odata.nextLink": nextLink } : {}),
  };
}
