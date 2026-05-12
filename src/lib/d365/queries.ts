import "server-only";

import type { D365Client } from "./client";
import type {
  D365Account,
  D365Annotation,
  D365Appointment,
  D365Contact,
  D365Email,
  D365EntityType,
  D365Lead,
  D365Opportunity,
  D365PhoneCall,
  D365Task,
} from "./types";
import { D365_ENTITY_PK, D365_ENTITY_SET } from "./types";

/**
 * Phase 23 — per-entity OData query builders.
 *
 * Each builder enforces:
 *
 *  - explicit `$select` allowlist (NEVER `*` — we keep payload size
 *    bounded and avoid surprise picklists landing in raw_payload)
 *  - `$filter` for incremental pulls (`modifiedon ge X` AND active
 *    `statecode` where applicable)
 *  - `$orderby modifiedon asc` for stable cursoring
 *  - page size 100 (matches `D365_IMPORT_BATCH_SIZE`)
 *  - $expand only on Lead/Contact/Account/Opportunity (activity
 *    entities don't expand further per D365 metadata)
 *
 * When `nextLink` is supplied, we delegate to `client.followNextLink`.
 * The OData server bakes all $select/$filter/$top/$orderby into the
 * server-generated link, so we don't re-apply them.
 *
 * When `ids` is supplied we build an `in (...)` filter for forced
 * re-fetch (used by retry-style resume after `dedup_overwrite`).
 */

/* -------------------------------------------------------------------------- *
 *                              Common types                                  *
 * -------------------------------------------------------------------------- */

export interface FetchPageResult<T> {
  records: T[];
  nextLink?: string;
  totalCount?: number;
}

export interface BaseFetchOpts {
  /** Inclusive `modifiedon ge` cutoff for incremental pulls. */
  modifiedSince?: Date;
  /** Page size (defaults to 100). */
  top?: number;
  /** Server-generated next-link from a prior page. */
  nextLink?: string;
  /** Forced re-fetch by primary-key IDs (max ~100 per page). */
  ids?: string[];
  /** When true, $expand the entity's parent / child links. Only valid
   *  for the four primary entities; ignored for activities. */
  expand?: boolean;
  /** Optional caller-provided abort signal. */
  signal?: AbortSignal;
}

const DEFAULT_PAGE_SIZE = 100;

/* -------------------------------------------------------------------------- *
 *                             Field allowlists                               *
 * -------------------------------------------------------------------------- */

const LEAD_SELECT = [
  "leadid",
  "firstname",
  "lastname",
  "fullname",
  "emailaddress1",
  "emailaddress2",
  "emailaddress3",
  "telephone1",
  "telephone2",
  "mobilephone",
  "jobtitle",
  "companyname",
  "websiteurl",
  "industrycode",
  "leadsourcecode",
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
];

const APPOINTMENT_SELECT = [
  ...ACTIVITY_BASE_SELECT,
  "location",
  "isalldayevent",
];

const EMAIL_SELECT = [
  ...ACTIVITY_BASE_SELECT,
  "sender",
  "description_html",
  "directioncode",
];

/* -------------------------------------------------------------------------- *
 *                              Filter builders                               *
 * -------------------------------------------------------------------------- */

/**
 * Quote a string literal for an OData `$filter` clause. D365 escapes
 * single quotes by doubling them.
 */
function odataQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Format a Date for OData `modifiedon ge ...` comparisons. */
function odataDate(d: Date): string {
  // OData wants ISO 8601 with Z; the column is timezone-aware on D365.
  return d.toISOString();
}

interface BuildFilterArgs {
  modifiedSince?: Date;
  /** PK column name to use with `id in (...)` clauses. */
  pkColumn?: string;
  /** Specific IDs to force-fetch. */
  ids?: string[];
  /**
   * Restrict to active rows. When omitted no statecode clause is
   * applied — useful for activities where statecode==1 means
   * completed (still wanted) vs statecode==2 cancelled.
   */
  activeStatecodeOnly?: boolean;
}

function buildFilter(args: BuildFilterArgs): string | undefined {
  const parts: string[] = [];
  if (args.modifiedSince) {
    parts.push(`modifiedon ge ${odataDate(args.modifiedSince)}`);
  }
  if (args.activeStatecodeOnly) {
    parts.push("statecode eq 0");
  }
  if (args.ids?.length && args.pkColumn) {
    // OData supports `<col> in ('a','b','c')`. Defensive cap at 100
    // since Dynamics will reject filters > ~32k chars.
    const quoted = args.ids.slice(0, 100).map(odataQuote).join(",");
    parts.push(`${args.pkColumn} in (${quoted})`);
  }
  if (!parts.length) return undefined;
  return parts.join(" and ");
}

/* -------------------------------------------------------------------------- *
 *                             Generic page fetch                             *
 * -------------------------------------------------------------------------- */

interface FetchSpec {
  entitySet: string;
  pkColumn: string;
  select: string[];
  expand?: string;
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
    // When we're force-fetching by id, drop the statecode gate so
    // archived rows can still be re-pulled for review.
    activeStatecodeOnly: !opts.ids && spec.activeStatecodeOnly,
  });

  const page = await client.fetchPage<T>(spec.entitySet, {
    select: spec.select,
    filter,
    expand: spec.expand,
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
 *                          Per-entity public API                             *
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
      expand: opts.expand
        ? "lead_tasks($select=activityid,subject,modifiedon),lead_phonecalls($select=activityid,subject,modifiedon),lead_appointments($select=activityid,subject,modifiedon),lead_emails($select=activityid,subject,modifiedon),Lead_Annotation($select=annotationid,subject,modifiedon)"
        : undefined,
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
      expand: opts.expand
        ? "Contact_Tasks($select=activityid,subject,modifiedon),Contact_Phonecalls($select=activityid,subject,modifiedon),Contact_Appointments($select=activityid,subject,modifiedon),Contact_Emails($select=activityid,subject,modifiedon),Contact_Annotation($select=annotationid,subject,modifiedon)"
        : undefined,
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
      expand: opts.expand
        ? "Account_Tasks($select=activityid,subject,modifiedon),Account_Phonecalls($select=activityid,subject,modifiedon),Account_Appointments($select=activityid,subject,modifiedon),Account_Emails($select=activityid,subject,modifiedon),Account_Annotation($select=annotationid,subject,modifiedon)"
        : undefined,
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
      expand: opts.expand
        ? "Opportunity_Tasks($select=activityid,subject,modifiedon),Opportunity_Phonecalls($select=activityid,subject,modifiedon),Opportunity_Appointments($select=activityid,subject,modifiedon),Opportunity_Emails($select=activityid,subject,modifiedon),Opportunity_Annotation($select=annotationid,subject,modifiedon)"
        : undefined,
      // Opportunities have closed states (won=2/lost=3); we do NOT
      // want to silently exclude those — let the mapper decide.
      activeStatecodeOnly: false,
    },
    opts,
  );
}

export type AnnotationFetchOpts = BaseFetchOpts;

export function fetchAnnotations(
  client: D365Client,
  opts: AnnotationFetchOpts = {},
): Promise<FetchPageResult<D365Annotation>> {
  return fetchByQuery<D365Annotation>(
    client,
    {
      entitySet: D365_ENTITY_SET.annotation,
      pkColumn: D365_ENTITY_PK.annotation,
      select: ANNOTATION_SELECT,
      // Annotations don't expand to a polymorphic parent in OData; we
      // resolve the parent reference (`_objectid_value`) at map time.
      expand: undefined,
      activeStatecodeOnly: false,
    },
    opts,
  );
}

export type TaskFetchOpts = BaseFetchOpts;

export function fetchTasks(
  client: D365Client,
  opts: TaskFetchOpts = {},
): Promise<FetchPageResult<D365Task>> {
  return fetchByQuery<D365Task>(
    client,
    {
      entitySet: D365_ENTITY_SET.task,
      pkColumn: D365_ENTITY_PK.task,
      select: TASK_SELECT,
      // Activity entities are not $expand-able per the brief.
      expand: undefined,
      activeStatecodeOnly: false,
    },
    opts,
  );
}

export type PhoneCallFetchOpts = BaseFetchOpts;

export function fetchPhoneCalls(
  client: D365Client,
  opts: PhoneCallFetchOpts = {},
): Promise<FetchPageResult<D365PhoneCall>> {
  return fetchByQuery<D365PhoneCall>(
    client,
    {
      entitySet: D365_ENTITY_SET.phonecall,
      pkColumn: D365_ENTITY_PK.phonecall,
      select: PHONECALL_SELECT,
      expand: undefined,
      activeStatecodeOnly: false,
    },
    opts,
  );
}

export type AppointmentFetchOpts = BaseFetchOpts;

export function fetchAppointments(
  client: D365Client,
  opts: AppointmentFetchOpts = {},
): Promise<FetchPageResult<D365Appointment>> {
  return fetchByQuery<D365Appointment>(
    client,
    {
      entitySet: D365_ENTITY_SET.appointment,
      pkColumn: D365_ENTITY_PK.appointment,
      select: APPOINTMENT_SELECT,
      expand: undefined,
      activeStatecodeOnly: false,
    },
    opts,
  );
}

export type EmailFetchOpts = BaseFetchOpts;

export function fetchEmails(
  client: D365Client,
  opts: EmailFetchOpts = {},
): Promise<FetchPageResult<D365Email>> {
  return fetchByQuery<D365Email>(
    client,
    {
      entitySet: D365_ENTITY_SET.email,
      pkColumn: D365_ENTITY_PK.email,
      select: EMAIL_SELECT,
      expand: undefined,
      activeStatecodeOnly: false,
    },
    opts,
  );
}

/* -------------------------------------------------------------------------- *
 *                       Entity-type dispatch helper                          *
 * -------------------------------------------------------------------------- */

/**
 * Single dispatch point used by the orchestrator (`pull-batch.ts`).
 * Picks the correct typed builder based on `entityType`.
 */
export function fetchByEntityType(
  client: D365Client,
  entityType: D365EntityType,
  opts: BaseFetchOpts,
): Promise<FetchPageResult<unknown>> {
  switch (entityType) {
    case "lead":
      return fetchLeads(client, opts);
    case "contact":
      return fetchContacts(client, opts);
    case "account":
      return fetchAccounts(client, opts);
    case "opportunity":
      return fetchOpportunities(client, opts);
    case "annotation":
      return fetchAnnotations(client, opts);
    case "task":
      return fetchTasks(client, opts);
    case "phonecall":
      return fetchPhoneCalls(client, opts);
    case "appointment":
      return fetchAppointments(client, opts);
    case "email":
      return fetchEmails(client, opts);
    default: {
      const _exhaustive: never = entityType;
      void _exhaustive;
      // invariant: TypeScript exhaustive-check above guarantees
      // this branch is unreachable. A new D365EntityType added
      // without a query builder lands here.
      throw new Error(`Unsupported D365 entity type: ${String(entityType)}`);
    }
  }
}
