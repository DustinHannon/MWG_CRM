import "server-only";

import type { D365Client } from "./client";
import type {
  D365Account,
  D365Annotation,
  D365Appointment,
  D365Contact,
  D365Email,
  D365Lead,
  D365Opportunity,
  D365PhoneCall,
  D365Task,
  D365RootType,
  AnnotationRootType,
} from "./types";
import {
  D365_ENTITY_PK,
  D365_ENTITY_SET,
  D365_ROOT_TYPES,
  isD365RootType,
} from "./types";

/**
 * per-entity OData query builders for the root-aggregate import.
 *
 * The unit of work is one ROOT entity (lead | contact | account |
 * opportunity) with its full child graph (task / phonecall / appointment
 * / email / annotation). Roots are fetched with the per-root fetchers
 * below; children are fetched separately and stitched to their parent in
 * code by `pull-batch.ts`.
 *
 * Each root builder enforces:
 *
 * explicit `$select` allowlist (NEVER `*` — we keep payload size
 * bounded and avoid surprise picklists landing in raw_payload). The
 * allowlists are WIDENED to cover every native field the mappers read
 * plus the org's real business custom fields with a destination;
 * everything else still flows through `extractCustomFields`.
 * `$filter` for incremental pulls (`modifiedon ge X` AND active
 * `statecode` where applicable)
 * `$orderby modifiedon asc` for stable cursoring
 * page size 100 (matches `D365_IMPORT_BATCH_SIZE`)
 *
 * D365 mechanics that are NON-NEGOTIABLE here (verified live):
 *
 * NO `$expand` for activities — collection nav names are
 * case-sensitive and the result set is capped and does not page.
 * NO OData `in` operator — Dataverse rejects it with
 * `501 The query node In is not supported`. Forced re-fetch by id
 * and child fetch both use `or`-chains instead.
 * Children are fetched by an `or`-chain on the parent reference
 * (`_regardingobjectid_value` for activities, `_objectid_value` +
 * `objecttypecode` for notes, `_originatingleadid_value` for the
 * lead→opportunity graft). GUID literals for lookup `_value` filters
 * are UNQUOTED.
 *
 * When `nextLink` is supplied to a single-page fetch, we delegate to
 * `client.followNextLink`. The OData server bakes all
 * $select/$filter/$top/$orderby into the server-generated link, so we
 * don't re-apply them. The child-fetch helpers drain `@odata.nextLink`
 * internally until the collection is exhausted.
 */

/* -------------------------------------------------------------------------- *
 * Common types *
 * -------------------------------------------------------------------------- */

export interface FetchPageResult<T> {
  records: T[];
  nextLink?: string;
  totalCount?: number;
}

/**
 * Result of a child-collection fetch. The helper drains the collection
 * fully via `@odata.nextLink`, so there is no cursor to hand back.
 * `truncated` is true ONLY when a hard safety cap was hit before the
 * collection was exhausted — the caller MUST treat that as a halt
 * condition (never silently lose call history).
 */
export interface ChildFetchResult<T> {
  records: T[];
  truncated: boolean;
}

export interface BaseFetchOpts {
  /** Inclusive `modifiedon ge` cutoff for incremental pulls. */
  modifiedSince?: Date;
  /** Page size (defaults to 100). */
  top?: number;
  /** Server-generated next-link from a prior page. */
  nextLink?: string;
  /**
   * Forced re-fetch by primary-key IDs (used by retry-style resume after
   * `dedup_overwrite`). Built as an `or`-chain on the PK column — the
   * `in` operator is unsupported by Dataverse.
   */
  ids?: string[];
  /**
   * Operator-selected statecode restriction (from the run scope's
   * "Active records only" toggle). When provided, drives the statecode
   * `$filter` clause and OVERRIDES the per-entity `activeStatecodeOnly`
   * default. When omitted, the per-entity default applies. Ignored when
   * `ids` is supplied (forced re-fetch drops the statecode gate so
   * archived rows can be re-pulled). */
  statecode?: number[];
  /** Optional caller-provided abort signal. */
  signal?: AbortSignal;
}

/** Options for a child-collection fetch (task / phonecall / … / annotation). */
export interface ChildFetchOpts {
  /** Page size per OData request (defaults to 100). */
  pageSize?: number;
  /**
   * Hard safety cap on the total number of child records returned across
   * all pages of a single helper call. If the collection would exceed
   * this, the helper stops and reports `truncated: true` so the caller
   * can halt rather than silently drop records. Defaults to
   * `CHILD_FETCH_HARD_CAP`.
   */
  hardCap?: number;
  /** Optional caller-provided abort signal. */
  signal?: AbortSignal;
}

const DEFAULT_PAGE_SIZE = 100;

/**
 * Maximum GUIDs to put in a single `or`-chain `$filter`. Dataverse
 * rejects filters longer than ~32k chars; each `_x_value eq <guid>` term
 * is ~60 chars including the ` or ` joiner, so 200 terms (~12k chars)
 * stays well under the limit with headroom for the rest of the clause.
 * Root batches are 100, so a single chunk covers a normal batch; the
 * chunking is defensive for callers that pass larger id sets.
 */
const OR_CHAIN_CHUNK_SIZE = 200;

/**
 * Safety cap on total child records drained per helper call. The biggest
 * known fan-out is phonecalls (≈38.6k org-wide across ≈118k leads, i.e.
 * a fraction per root); a 100-root batch is nowhere near this, so hitting
 * the cap signals a pathological parent and the caller halts.
 */
const CHILD_FETCH_HARD_CAP = 50_000;

/* -------------------------------------------------------------------------- *
 * Field allowlists *
 * -------------------------------------------------------------------------- */

/**
 * Root field allowlists.
 *
 * Each list = every native field the corresponding mapper reads PLUS the
 * org's real business custom fields (insurance `new_*` / agent-hierarchy
 * `ali_*`) that have a destination or are load-bearing downstream.
 * Custom fields not listed here still flow through `extractCustomFields`
 * (they match the `new_*` / `cr<hex>_*` / `mwg_*` prefix); listing the
 * key ones explicitly guarantees they are requested on the wire even if
 * the prefix scan ever changes, and documents intent.
 */

const LEAD_SELECT = [
  "leadid",
  "firstname",
  "lastname",
  "fullname",
  "salutation",
  "emailaddress1",
  "emailaddress2",
  "emailaddress3",
  "telephone1",
  "telephone2",
  "mobilephone",
  "jobtitle",
  "companyname",
  "websiteurl",
  "linkedinprofile",
  "industrycode",
  "leadsourcecode",
  "leadqualitycode",
  "subject",
  "description",
  "donotemail",
  "donotphone",
  "donotpostalmail",
  "donotbulkemail",
  "donotfax",
  "donotsendmm",
  "address1_line1",
  "address1_line2",
  "address1_line3",
  "address1_city",
  "address1_stateorprovince",
  "address1_postalcode",
  "address1_country",
  "address1_telephone1",
  "estimatedamount",
  "estimatedclosedate",
  "statecode",
  "statuscode",
  "createdon",
  "modifiedon",
  "_createdby_value",
  "_modifiedby_value",
  "_ownerid_value",
  "_qualifyingopportunityid_value",
];

const CONTACT_SELECT = [
  "contactid",
  "firstname",
  "lastname",
  "fullname",
  "salutation",
  "emailaddress1",
  "emailaddress2",
  "emailaddress3",
  "telephone1",
  "telephone2",
  "mobilephone",
  "jobtitle",
  "description",
  "donotemail",
  "donotphone",
  "donotpostalmail",
  "donotbulkemail",
  "donotfax",
  "donotsendmm",
  "address1_line1",
  "address1_line2",
  "address1_city",
  "address1_stateorprovince",
  "address1_postalcode",
  "address1_country",
  "birthdate",
  "statecode",
  "statuscode",
  "createdon",
  "modifiedon",
  "_createdby_value",
  "_modifiedby_value",
  "_ownerid_value",
  "_parentcustomerid_value",
  "_accountid_value",
];

const ACCOUNT_SELECT = [
  "accountid",
  "name",
  "accountnumber",
  "emailaddress1",
  "telephone1",
  "websiteurl",
  "industrycode",
  "description",
  "numberofemployees",
  "revenue",
  "address1_line1",
  "address1_line2",
  "address1_city",
  "address1_stateorprovince",
  "address1_postalcode",
  "address1_country",
  "statecode",
  "statuscode",
  "createdon",
  "modifiedon",
  "_createdby_value",
  "_modifiedby_value",
  "_ownerid_value",
  "_primarycontactid_value",
  "_parentaccountid_value",
];

const OPPORTUNITY_SELECT = [
  "opportunityid",
  "name",
  "description",
  "estimatedvalue",
  "estimatedclosedate",
  "actualvalue",
  "actualclosedate",
  "closeprobability",
  "stepname",
  "salesstagecode",
  "statecode",
  "statuscode",
  "createdon",
  "modifiedon",
  "_createdby_value",
  "_modifiedby_value",
  "_ownerid_value",
  "_customerid_value",
  "_parentaccountid_value",
  "_parentcontactid_value",
  "_originatingleadid_value",
];

const ANNOTATION_SELECT = [
  "annotationid",
  "subject",
  "notetext",
  "filename",
  "documentbody",
  "mimetype",
  "isdocument",
  "objecttypecode",
  "_objectid_value",
  "createdon",
  "modifiedon",
  "_createdby_value",
  "_modifiedby_value",
  "_ownerid_value",
];

const ACTIVITY_BASE_SELECT = [
  "activityid",
  "subject",
  "description",
  "scheduledstart",
  "scheduledend",
  "actualstart",
  "actualend",
  "_regardingobjectid_value",
  "prioritycode",
  "statecode",
  "statuscode",
  "createdon",
  "modifiedon",
  "_createdby_value",
  "_modifiedby_value",
  "_ownerid_value",
];

const TASK_SELECT = [...ACTIVITY_BASE_SELECT, "percentcomplete", "category"];

const PHONECALL_SELECT = [
  ...ACTIVITY_BASE_SELECT,
  "phonenumber",
  "directioncode",
  "actualdurationminutes",
];

const APPOINTMENT_SELECT = [
  ...ACTIVITY_BASE_SELECT,
  "location",
  "isalldayevent",
  "scheduleddurationminutes",
  "actualdurationminutes",
];

const EMAIL_SELECT = [
  ...ACTIVITY_BASE_SELECT,
  "sender",
  "description_html",
  "directioncode",
  "messageid",
];

/* -------------------------------------------------------------------------- *
 * Filter builders *
 * -------------------------------------------------------------------------- */

/** Format a Date for OData `modifiedon ge ...` comparisons. */
function odataDate(d: Date): string {
  // OData wants ISO 8601 with Z; the column is timezone-aware on D365.
  return d.toISOString();
}

/**
 * Quote a string literal for an OData `$filter` clause (e.g. an
 * `objecttypecode` text value). D365 escapes single quotes by doubling
 * them. NOTE: lookup `_value` GUID filters are UNQUOTED — do not use
 * this for those.
 */
function odataQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build an `or`-chain `$filter` clause over one column for a set of
 * values, e.g. `(_regardingobjectid_value eq G1 or _regardingobjectid_value eq G2)`.
 * Used everywhere Dataverse's unsupported `in` operator would otherwise
 * be the natural choice. `format` controls per-value rendering: GUID
 * lookup `_value` filters pass values UNQUOTED; text columns quote.
 */
function buildOrChain(
  column: string,
  values: readonly string[],
  format: (v: string) => string,
): string {
  const terms = values.map((v) => `${column} eq ${format(v)}`);
  const clause = terms.join(" or ");
  return terms.length > 1 ? `(${clause})` : clause;
}

/** Render a GUID literal for a lookup `_value` filter — UNQUOTED. */
function guidLiteral(v: string): string {
  return v;
}

/** Split an id set into chunks small enough for a single `or`-chain. */
function chunkIds(ids: readonly string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

interface BuildFilterArgs {
  modifiedSince?: Date;
  /** PK column name to use with the forced-id `or`-chain clause. */
  pkColumn?: string;
  /** Specific IDs to force-fetch (rendered as an `or`-chain, not `in`). */
  ids?: string[];
  /**
   * Operator-selected statecode codes from the run scope. Presence is
   * authoritative and OVERRIDES the per-entity `activeStatecodeOnly`
   * default:
   *   - one code  → `statecode eq N`
   *   - many codes → an `or`-chain `(statecode eq a or statecode eq b)`
   *   - empty array (`[]`) → explicit "all states": NO statecode clause
   * When `undefined` (key absent), the per-entity `activeStatecodeOnly`
   * default applies.
   */
  statecode?: number[];
  /**
   * Per-entity default: restrict to active rows when no explicit
   * `statecode` is supplied. When both are omitted no statecode clause
   * is applied — useful for activities where statecode==1 means
   * completed (still wanted) vs statecode==2 cancelled.
   */
  activeStatecodeOnly?: boolean;
}

function buildFilter(args: BuildFilterArgs): string | undefined {
  const parts: string[] = [];
  if (args.modifiedSince) {
    parts.push(`modifiedon ge ${odataDate(args.modifiedSince)}`);
  }
  // Operator-selected statecode (run scope) is authoritative when the
  // key is present — it overrides the per-entity default. An empty
  // array means "all states" (no clause). Only fall back to the
  // per-entity `activeStatecodeOnly` default when no statecode key was
  // supplied at all.
  if (args.statecode !== undefined) {
    const codes = args.statecode.filter((c) => Number.isInteger(c));
    if (codes.length === 1) {
      parts.push(`statecode eq ${codes[0]}`);
    } else if (codes.length > 1) {
      // Dataverse rejects `in` — express multi-code as an `or`-chain.
      parts.push(buildOrChain("statecode", codes.map(String), (c) => c));
    }
    // codes.length === 0 → explicit all-states, emit no clause.
  } else if (args.activeStatecodeOnly) {
    parts.push("statecode eq 0");
  }
  if (args.ids?.length && args.pkColumn) {
    // Forced re-fetch by id. The `in` operator is unsupported by
    // Dataverse (501), so build an `or`-chain on the PK column. PK
    // columns are GUID-typed; lookup-style GUID literals are UNQUOTED.
    // Defensive cap mirrors the chunk size so the clause stays well
    // under Dynamics' ~32k filter-length limit.
    const capped = args.ids.slice(0, OR_CHAIN_CHUNK_SIZE);
    parts.push(buildOrChain(args.pkColumn, capped, guidLiteral));
  }
  if (!parts.length) return undefined;
  return parts.join(" and ");
}

/* -------------------------------------------------------------------------- *
 * Generic single-page root fetch *
 * -------------------------------------------------------------------------- */

interface FetchSpec {
  entitySet: string;
  pkColumn: string;
  select: string[];
  /** When true and `ids` is not provided, restrict to active records. */
  activeStatecodeOnly: boolean;
}

async function fetchByQuery<T>(
  client: D365Client,
  spec: FetchSpec,
  opts: BaseFetchOpts,
): Promise<FetchPageResult<T>> {
  // Page 2+: trust the server-generated next link verbatim.
  if (opts.nextLink) {
    const page = await client.followNextLink<T>(opts.nextLink, opts.signal);
    return {
      records: page.value,
      nextLink: page.nextLink,
      totalCount: page.count,
    };
  }

  const filter = buildFilter({
    modifiedSince: opts.modifiedSince,
    pkColumn: spec.pkColumn,
    ids: opts.ids,
    // When we're force-fetching by id, drop the statecode gate entirely
    // so archived rows can still be re-pulled for review. Otherwise the
    // operator-selected statecode (run scope) overrides the per-entity
    // default; if the operator didn't select any, fall back to the
    // per-entity `activeStatecodeOnly` default.
    statecode: opts.ids ? undefined : opts.statecode,
    activeStatecodeOnly: !opts.ids && spec.activeStatecodeOnly,
  });

  const page = await client.fetchPage<T>(spec.entitySet, {
    select: spec.select,
    filter,
    top: opts.top ?? DEFAULT_PAGE_SIZE,
    pageSize: opts.top ?? DEFAULT_PAGE_SIZE,
    orderby: "modifiedon asc",
    count: false,
    signal: opts.signal,
  });

  return {
    records: page.value,
    nextLink: page.nextLink,
    totalCount: page.count,
  };
}

/* -------------------------------------------------------------------------- *
 * Generic child-collection drain *
 * -------------------------------------------------------------------------- */

/**
 * Fetch a child collection filtered by an `or`-chain over `rootIds`,
 * draining every page via `@odata.nextLink`. Chunks large id sets so each
 * `$filter` stays under Dataverse's length cap; concatenates the results.
 *
 * `truncated` is set true ONLY if the hard cap is hit before the
 * collection is exhausted — the caller treats that as a halt condition.
 * Normal exhaustion returns `truncated: false`.
 *
 * `extraFilter` is `and`-ed onto each chunk's `or`-chain (used by
 * annotations for `objecttypecode eq '<root>'`).
 */
async function drainChildCollection<T>(
  client: D365Client,
  args: {
    entitySet: string;
    select: string[];
    filterColumn: string;
    rootIds: readonly string[];
    extraFilter?: string;
  },
  opts: ChildFetchOpts,
): Promise<ChildFetchResult<T>> {
  const ids = args.rootIds.filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return { records: [], truncated: false };

  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const hardCap = opts.hardCap ?? CHILD_FETCH_HARD_CAP;
  const records: T[] = [];

  for (const chunk of chunkIds(ids, OR_CHAIN_CHUNK_SIZE)) {
    const orChain = buildOrChain(args.filterColumn, chunk, guidLiteral);
    const filter = args.extraFilter
      ? `${orChain} and ${args.extraFilter}`
      : orChain;

    // First page of this chunk.
    let page = await client.fetchPage<T>(args.entitySet, {
      select: args.select,
      filter,
      orderby: "modifiedon asc",
      top: pageSize,
      pageSize,
      count: false,
      signal: opts.signal,
    });

    for (;;) {
      for (const rec of page.value) {
        records.push(rec);
        if (records.length >= hardCap) {
          // Stop immediately — never drop records silently. The caller
          // halts on `truncated: true`.
          return { records, truncated: true };
        }
      }
      if (!page.nextLink) break;
      page = await client.followNextLink<T>(page.nextLink, opts.signal);
    }
  }

  return { records, truncated: false };
}

/* -------------------------------------------------------------------------- *
 * Per-root single-page fetchers *
 * -------------------------------------------------------------------------- */

export type LeadFetchOpts = BaseFetchOpts;

export function fetchLeads(
  client: D365Client,
  opts: LeadFetchOpts = {},
): Promise<FetchPageResult<D365Lead>> {
  return fetchByQuery<D365Lead>(
    client,
    {
      entitySet: D365_ENTITY_SET.lead,
      pkColumn: D365_ENTITY_PK.lead,
      select: LEAD_SELECT,
      activeStatecodeOnly: true,
    },
    opts,
  );
}

export type ContactFetchOpts = BaseFetchOpts;

export function fetchContacts(
  client: D365Client,
  opts: ContactFetchOpts = {},
): Promise<FetchPageResult<D365Contact>> {
  return fetchByQuery<D365Contact>(
    client,
    {
      entitySet: D365_ENTITY_SET.contact,
      pkColumn: D365_ENTITY_PK.contact,
      select: CONTACT_SELECT,
      activeStatecodeOnly: true,
    },
    opts,
  );
}

export type AccountFetchOpts = BaseFetchOpts;

export function fetchAccounts(
  client: D365Client,
  opts: AccountFetchOpts = {},
): Promise<FetchPageResult<D365Account>> {
  return fetchByQuery<D365Account>(
    client,
    {
      entitySet: D365_ENTITY_SET.account,
      pkColumn: D365_ENTITY_PK.account,
      select: ACCOUNT_SELECT,
      activeStatecodeOnly: true,
    },
    opts,
  );
}

export type OpportunityFetchOpts = BaseFetchOpts;

export function fetchOpportunities(
  client: D365Client,
  opts: OpportunityFetchOpts = {},
): Promise<FetchPageResult<D365Opportunity>> {
  return fetchByQuery<D365Opportunity>(
    client,
    {
      entitySet: D365_ENTITY_SET.opportunity,
      pkColumn: D365_ENTITY_PK.opportunity,
      select: OPPORTUNITY_SELECT,
      // Opportunities have closed states (won=2/lost=3); we do NOT
      // want to silently exclude those — let the mapper decide.
      activeStatecodeOnly: false,
    },
    opts,
  );
}

/* -------------------------------------------------------------------------- *
 * Child-graph fetchers (or-chain on the parent reference) *
 * -------------------------------------------------------------------------- */

/**
 * The polymorphic activity → parent reference. Tasks, phonecalls,
 * appointments, and emails all attach to a root via this lookup.
 */
const ACTIVITY_PARENT_REF = "_regardingobjectid_value";

/** The note → parent reference. Annotations attach via this lookup. */
const ANNOTATION_PARENT_REF = "_objectid_value";

/**
 * Fetch every D365 `task` regarding one of `rootIds`, draining all
 * pages. Filter: `(_regardingobjectid_value eq G1 or … )` (GUIDs
 * unquoted). Because the roots are all one known type, the parent type
 * is implied by the caller — no `lookuplogicalname` needed for the root
 * path. Tasks land in the local `tasks` table at commit.
 */
export function fetchTasksForRoots(
  client: D365Client,
  rootIds: string[],
  opts: ChildFetchOpts = {},
): Promise<ChildFetchResult<D365Task>> {
  return drainChildCollection<D365Task>(
    client,
    {
      entitySet: D365_ENTITY_SET.task,
      select: TASK_SELECT,
      filterColumn: ACTIVITY_PARENT_REF,
      rootIds,
    },
    opts,
  );
}

/** Fetch every `phonecall` regarding one of `rootIds`, draining all pages. */
export function fetchPhonecallsForRoots(
  client: D365Client,
  rootIds: string[],
  opts: ChildFetchOpts = {},
): Promise<ChildFetchResult<D365PhoneCall>> {
  return drainChildCollection<D365PhoneCall>(
    client,
    {
      entitySet: D365_ENTITY_SET.phonecall,
      select: PHONECALL_SELECT,
      filterColumn: ACTIVITY_PARENT_REF,
      rootIds,
    },
    opts,
  );
}

/** Fetch every `appointment` regarding one of `rootIds`, draining all pages. */
export function fetchAppointmentsForRoots(
  client: D365Client,
  rootIds: string[],
  opts: ChildFetchOpts = {},
): Promise<ChildFetchResult<D365Appointment>> {
  return drainChildCollection<D365Appointment>(
    client,
    {
      entitySet: D365_ENTITY_SET.appointment,
      select: APPOINTMENT_SELECT,
      filterColumn: ACTIVITY_PARENT_REF,
      rootIds,
    },
    opts,
  );
}

/** Fetch every `email` regarding one of `rootIds`, draining all pages. */
export function fetchEmailsForRoots(
  client: D365Client,
  rootIds: string[],
  opts: ChildFetchOpts = {},
): Promise<ChildFetchResult<D365Email>> {
  return drainChildCollection<D365Email>(
    client,
    {
      entitySet: D365_ENTITY_SET.email,
      select: EMAIL_SELECT,
      filterColumn: ACTIVITY_PARENT_REF,
      rootIds,
    },
    opts,
  );
}

/**
 * Fetch every `annotation` (note) attached to one of `rootIds` for a
 * given root type, draining all pages. Filter:
 * `(_objectid_value eq G1 or …) and objecttypecode eq '<rootType>'`.
 * `_objectid_value` GUIDs are UNQUOTED; `objecttypecode` is a text value
 * and IS quoted.
 *
 * The `objecttypecode` filter already pins the parent type, and the root
 * is stitched under a known type via `parentContext` — so the polymorphic
 * `_objectid_value@…lookuplogicalname` disambiguator is not needed and we
 * do NOT request OData annotations for it.
 */
export function fetchAnnotationsForRoots(
  client: D365Client,
  rootIds: string[],
  rootType: AnnotationRootType,
  opts: ChildFetchOpts = {},
): Promise<ChildFetchResult<D365Annotation>> {
  return drainChildCollection<D365Annotation>(
    client,
    {
      entitySet: D365_ENTITY_SET.annotation,
      select: ANNOTATION_SELECT,
      filterColumn: ANNOTATION_PARENT_REF,
      rootIds,
      extraFilter: `objecttypecode eq ${odataQuote(rootType)}`,
    },
    opts,
  );
}

/* -------------------------------------------------------------------------- *
 * Root-type dispatch helper *
 * -------------------------------------------------------------------------- */

// D365RootType, AnnotationRootType, D365_ROOT_TYPES, and isD365RootType are
// defined in ./types (client-safe — no `server-only`) so the import wizard
// client component can import the root-type list. Re-exported here for
// server-side callers that import the query surface.
export type { D365RootType, AnnotationRootType };
export { D365_ROOT_TYPES, isD365RootType };

/**
 * Single dispatch point used by the orchestrator (`pull-batch.ts`) to
 * fetch one page of a ROOT type. Children are NEVER pulled standalone —
 * they travel with their root via the `*ForRoots` helpers above — so this
 * dispatch only accepts the four root types and rejects child types.
 */
export function fetchRootByType(
  client: D365Client,
  rootType: D365RootType,
  opts: BaseFetchOpts,
): Promise<FetchPageResult<unknown>> {
  switch (rootType) {
    case "lead":
      return fetchLeads(client, opts);
    case "contact":
      return fetchContacts(client, opts);
    case "account":
      return fetchAccounts(client, opts);
    case "opportunity":
      return fetchOpportunities(client, opts);
    default: {
      const _exhaustive: never = rootType;
      void _exhaustive;
      // invariant: TypeScript exhaustive-check above guarantees this is
      // unreachable. A new root type added without a fetcher lands here.
      throw new Error(`Unsupported D365 root type: ${String(rootType)}`);
    }
  }
}
