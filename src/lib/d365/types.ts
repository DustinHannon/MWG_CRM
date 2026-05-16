// NOTE: NO `import "server-only"` here. types.ts contains pure type
// declarations + plain string-literal constants (D365_ENTITY_TYPES) that
// are erased at build time. Client components (e.g. the new-run modal)
// import the entity-type union for typed radio options. The actual
// server-only surface lives in client.ts / queries.ts / pull-batch.ts.

/**
 * TypeScript shapes for the D365 9.2 OData entities we
 * pull during import.
 *
 * These describe the WIRE-LEVEL JSON returned by the Dynamics OData
 * endpoint, NOT the local mwg-crm schema. Field naming follows D365
 * conventions verbatim (lowercase logical names, `_lookup_value`
 * navigation expansions, `statecode`/`statuscode` for lifecycle, etc.)
 * so the raw payload stored in `import_records.raw_payload` round-trips
 * faithfully.
 *
 * Each type intentionally extends an open `Record<string, unknown>`
 * via `[key: string]: unknown` so:
 * custom prefixed columns (`new_*`, `cr*_*`, `mwg_*`) flow through
 * without extending the surface
 * `@odata.etag` and other annotation keys (`*@OData.Community.Display.V1.FormattedValue`)
 * pass through without lying about the type
 * mapper code is not blocked by missing field types while the schema
 * is still being discovered in production
 *
 * Conventions:
 * all GUID fields are typed as `string` (D365 returns lowercase
 * UUIDs like `"e1c8f2b4-..."`)
 * all dates are `string` (ISO 8601 with offset, e.g.
 * `"2026-05-09T12:34:56Z"`)
 * `_xxx_value` columns are FK-by-id navigation projections; they
 * appear when you don't $expand the linked entity
 * `statecode` / `statuscode` are integer enums (numeric codes
 * map per-entity in the Dynamics options registry)
 */

/* -------------------------------------------------------------------------- *
 * Common shapes *
 * -------------------------------------------------------------------------- */

/** A GUID returned by D365 OData (lowercase, dash-formatted). */
export type D365Guid = string;

/** ISO-8601 date-time string. */
export type D365DateTime = string;

/** Common annotation keys present on every record. */
export interface D365EntityBase {
  "@odata.etag"?: string;
  createdon?: D365DateTime;
  modifiedon?: D365DateTime;
  _createdby_value?: D365Guid | null;
  _modifiedby_value?: D365Guid | null;
  _ownerid_value?: D365Guid | null;
  /** Forward-compat: every D365 entity has a numeric state/status. */
  statecode?: number | null;
  statuscode?: number | null;
}

/* -------------------------------------------------------------------------- *
 * Lead *
 * -------------------------------------------------------------------------- */

export interface D365Lead extends D365EntityBase {
  leadid: D365Guid;
  firstname?: string | null;
  lastname?: string | null;
  fullname?: string | null;
  emailaddress1?: string | null;
  emailaddress2?: string | null;
  emailaddress3?: string | null;
  telephone1?: string | null;
  telephone2?: string | null;
  mobilephone?: string | null;
  jobtitle?: string | null;
  companyname?: string | null;
  websiteurl?: string | null;
  industrycode?: number | null;
  leadsourcecode?: number | null;
  subject?: string | null;
  description?: string | null;
  donotemail?: boolean | null;
  donotphone?: boolean | null;
  donotpostalmail?: boolean | null;
  donotbulkemail?: boolean | null;
  donotfax?: boolean | null;
  donotsendmm?: boolean | null;
  address1_line1?: string | null;
  address1_line2?: string | null;
  address1_line3?: string | null;
  address1_city?: string | null;
  address1_stateorprovince?: string | null;
  address1_postalcode?: string | null;
  address1_country?: string | null;
  address1_telephone1?: string | null;
  /** When statecode==1 (qualified) D365 stamps the qualifying user. */
  _qualifyingopportunityid_value?: D365Guid | null;
  // Open for custom fields (`new_*`, etc.).
  [key: string]: unknown;
}

/* -------------------------------------------------------------------------- *
 * Contact *
 * -------------------------------------------------------------------------- */

export interface D365Contact extends D365EntityBase {
  contactid: D365Guid;
  firstname?: string | null;
  lastname?: string | null;
  fullname?: string | null;
  emailaddress1?: string | null;
  emailaddress2?: string | null;
  emailaddress3?: string | null;
  telephone1?: string | null;
  telephone2?: string | null;
  mobilephone?: string | null;
  jobtitle?: string | null;
  description?: string | null;
  donotemail?: boolean | null;
  donotphone?: boolean | null;
  donotpostalmail?: boolean | null;
  address1_line1?: string | null;
  address1_line2?: string | null;
  address1_city?: string | null;
  address1_stateorprovince?: string | null;
  address1_postalcode?: string | null;
  address1_country?: string | null;
  _parentcustomerid_value?: D365Guid | null;
  _accountid_value?: D365Guid | null;
  birthdate?: string | null;
  [key: string]: unknown;
}

/* -------------------------------------------------------------------------- *
 * Account *
 * -------------------------------------------------------------------------- */

export interface D365Account extends D365EntityBase {
  accountid: D365Guid;
  name?: string | null;
  accountnumber?: string | null;
  emailaddress1?: string | null;
  telephone1?: string | null;
  websiteurl?: string | null;
  industrycode?: number | null;
  description?: string | null;
  numberofemployees?: number | null;
  revenue?: number | null;
  address1_line1?: string | null;
  address1_line2?: string | null;
  address1_city?: string | null;
  address1_stateorprovince?: string | null;
  address1_postalcode?: string | null;
  address1_country?: string | null;
  _primarycontactid_value?: D365Guid | null;
  _parentaccountid_value?: D365Guid | null;
  [key: string]: unknown;
}

/* -------------------------------------------------------------------------- *
 * Opportunity *
 * -------------------------------------------------------------------------- */

export interface D365Opportunity extends D365EntityBase {
  opportunityid: D365Guid;
  name?: string | null;
  description?: string | null;
  estimatedvalue?: number | null;
  estimatedclosedate?: D365DateTime | null;
  actualvalue?: number | null;
  actualclosedate?: D365DateTime | null;
  closeprobability?: number | null;
  stepname?: string | null;
  /** D365 status codes for opportunity (1 = open, 2 = won, 3 = lost). */
  _customerid_value?: D365Guid | null;
  _parentaccountid_value?: D365Guid | null;
  _parentcontactid_value?: D365Guid | null;
  _originatingleadid_value?: D365Guid | null;
  [key: string]: unknown;
}

/* -------------------------------------------------------------------------- *
 * Annotation (note) *
 * -------------------------------------------------------------------------- */

export interface D365Annotation extends D365EntityBase {
  annotationid: D365Guid;
  subject?: string | null;
  notetext?: string | null;
  filename?: string | null;
  documentbody?: string | null;
  mimetype?: string | null;
  isdocument?: boolean | null;
  /** "objecttypecode" is the table the note is attached to: lead, contact, account, opportunity. */
  objecttypecode?: string | null;
  _objectid_value?: D365Guid | null;
  [key: string]: unknown;
}

/* -------------------------------------------------------------------------- *
 * Activities *
 * -------------------------------------------------------------------------- */

interface D365ActivityBase extends D365EntityBase {
  activityid: D365Guid;
  subject?: string | null;
  description?: string | null;
  scheduledstart?: D365DateTime | null;
  scheduledend?: D365DateTime | null;
  actualstart?: D365DateTime | null;
  actualend?: D365DateTime | null;
  /** "regardingobjectid" is the parent record (lead/contact/account/opportunity). */
  _regardingobjectid_value?: D365Guid | null;
  /**
   * "regardingobjectidtypecode" / "regardingobjectid_<entity>_<entity>"
   * navigation isn't expanded by default; we stash the parent's
   * objecttypecode separately when we discover it.
   */
  prioritycode?: number | null;
}

export interface D365Task extends D365ActivityBase {
  /** D365 task entity has its own primary key alongside activityid. */
  /** Plain text task body. */
  /** Percent complete. */
  percentcomplete?: number | null;
  category?: string | null;
  [key: string]: unknown;
}

export interface D365PhoneCall extends D365ActivityBase {
  phonenumber?: string | null;
  /** 0=incoming, 1=outgoing per D365 metadata. */
  directioncode?: boolean | number | null;
  [key: string]: unknown;
}

export interface D365Appointment extends D365ActivityBase {
  location?: string | null;
  isalldayevent?: boolean | null;
  [key: string]: unknown;
}

export interface D365Email extends D365ActivityBase {
  /** Sender display label; recipients live on activityparty. */
  sender?: string | null;
  /** Plain-text or HTML body — D365 stores both with a flag. */
  description_html?: string | null;
  /** 0=open, 1=completed, 2=cancelled per default metadata. */
  /** "directioncode" semantics same as PhoneCall: 0=incoming, 1=outgoing. */
  directioncode?: boolean | number | null;
  [key: string]: unknown;
}

/* -------------------------------------------------------------------------- *
 * SystemUser *
 * -------------------------------------------------------------------------- */

/**
 * Used by `owner-mapping.ts` to resolve a `_ownerid_value` GUID to a
 * UPN/email we can match against the local `users` table.
 *
 * Note: `domainname` is the canonical Entra UPN for the user.
 * `internalemailaddress` is what D365 surfaces in lookups but it can
 * lag behind UPN for migrated tenants — we prefer `domainname` first.
 */
export interface D365SystemUser {
  "@odata.etag"?: string;
  systemuserid: D365Guid;
  domainname?: string | null;
  fullname?: string | null;
  internalemailaddress?: string | null;
  isdisabled?: boolean | null;
  /** Application user accounts (S2S) — usually exclude from owner pool. */
  applicationid?: D365Guid | null;
  [key: string]: unknown;
}

/* -------------------------------------------------------------------------- *
 * Discriminated entity unions *
 * -------------------------------------------------------------------------- */

/**
 * `entity_type` strings persisted on `import_runs.entityType` and
 * `import_records.sourceEntityType`. The pull pipeline is constrained
 * to these nine values; the entity mappers consume the same union.
 */
export const D365_ENTITY_TYPES = [
  "lead",
  "contact",
  "account",
  "opportunity",
  "annotation",
  "task",
  "phonecall",
  "appointment",
  "email",
] as const;

export type D365EntityType = (typeof D365_ENTITY_TYPES)[number];

/** Map from our entity-type string to the D365 OData entity-set name. */
export const D365_ENTITY_SET: Record<D365EntityType, string> = {
  lead: "leads",
  contact: "contacts",
  account: "accounts",
  opportunity: "opportunities",
  annotation: "annotations",
  task: "tasks",
  phonecall: "phonecalls",
  appointment: "appointments",
  email: "emails",
};

/** Map from our entity-type string to the D365 primary-key column name. */
export const D365_ENTITY_PK: Record<D365EntityType, string> = {
  lead: "leadid",
  contact: "contactid",
  account: "accountid",
  opportunity: "opportunityid",
  annotation: "annotationid",
  task: "activityid",
  phonecall: "activityid",
  appointment: "activityid",
  email: "activityid",
};

/** Type-level lookup from entity-type string to the wire shape. */
export type D365EntityFor<E extends D365EntityType> = E extends "lead"
  ? D365Lead
  : E extends "contact"
    ? D365Contact
    : E extends "account"
      ? D365Account
      : E extends "opportunity"
        ? D365Opportunity
        : E extends "annotation"
          ? D365Annotation
          : E extends "task"
            ? D365Task
            : E extends "phonecall"
              ? D365PhoneCall
              : E extends "appointment"
                ? D365Appointment
                : E extends "email"
                  ? D365Email
                  : never;

/** Activities (per D365 metadata) cannot be $expanded further. */
export const D365_EXPANDABLE_ENTITIES: ReadonlyArray<D365EntityType> = [
  "lead",
  "contact",
  "account",
  "opportunity",
];
