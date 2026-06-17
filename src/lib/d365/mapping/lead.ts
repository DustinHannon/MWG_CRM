import "server-only";
import type { InferInsertModel } from "drizzle-orm";
import { leadCreateSchema } from "@/lib/leads";
import type { leads } from "@/db/schema/leads";
import type { D365Lead } from "../types";
import { assessLeadQuality } from "../quality";
import {
  type MapResult,
  type ValidationWarning,
  extractCustomFields,
  parseHttpUrl,
  parseODataDate,
  parseString,
  picklistMapper,
  softValidate,
} from "./parsers";
import {
  mapAttachedChildren,
  type ChildOwnerResolver,
  type D365Children,
} from "./children";

/**
 * D365 `lead` → mwg-crm `leads` insert payload.
 *
 * Recency preservation (NON-NEGOTIABLE per brief §0): `createdAt` /
 * `updatedAt` come from D365 `createdon` / `modifiedon`. NEVER use
 * `new Date()` or `defaultNow()` for imported records.
 *
 * Soft validation: the existing `leadCreateSchema` is run as a
 * non-fatal check — Zod failures become `validationWarnings` rather
 * than throwing. The reviewer can edit the mappedPayload in the
 * admin UI before commit, and the schema's strict version
 * still gates manual creates.
 */

export type NewLead = InferInsertModel<typeof leads>;

export interface LeadMapContext {
  /**
   * mwg-crm `users.id` resolved from the D365 `_ownerid_value` GUID
   * via `resolveD365Owner`. The mapper itself does not call into the
   * network.
   */
  resolvedOwnerId: string;
  /**
   * mwg-crm `users.id` resolved from the D365 `_createdby_value` /
   * `_modifiedby_value` so the imported record's created_by / updated_by
   * reflects the employee who actually created / last-touched it in D365,
   * not the current owner. Falls back to `resolvedOwnerId` when unresolved.
   */
  resolvedCreatedById?: string | null;
  resolvedUpdatedById?: string | null;
  /**
   * Nested raw child arrays (task / phonecall / appointment / email /
   * annotation) grouped under `rawPayload.children` by `pull-batch`.
   * The lead mapper runs each child mapper over these and returns them
   * in `result.attached`. Absent for a childless root.
   */
  children?: D365Children;
  /**
   * Optional resolver mapping a child's enriched owner email to a local
   * `users.id`. When omitted (or null) children ride on
   * `resolvedOwnerId`.
   */
  resolveChildOwnerId?: ChildOwnerResolver;
}

/* -------------------------------------------------------------------------- *
 * Picklist tables *
 * -------------------------------------------------------------------------- */

/**
 * D365 `leadqualitycode` (rating) → mwg-crm `lead_rating` enum.
 *
 * Default D365 option-set values from the SDK metadata documentation
 * (Microsoft.Crm.Sdk.Messages — Lead.LeadQualityCode):
 * 1 = Hot, 2 = Warm, 3 = Cold.
 */
const RATING_MAP = picklistMapper<"hot" | "warm" | "cold">(
  { 1: "hot", 2: "warm", 3: "cold" },
  "rating",
  "warm",
);

/**
 * D365 `leadsourcecode` (source) → mwg-crm `lead_source` enum.
 *
 * Per brief §"Picklist maps" — legacy D365 default option-set values:
 * 1=Advertisement, 2=Employee Referral, 3=External Referral,
 * 4=Partner, 5=Public Relations, 6=Seminar, 7=Trade Show,
 * 8=Word of Mouth, 9=Other.
 *
 * mwg-crm `lead_source` enum values (see lead-constants.ts):
 * web | referral | event | cold_call | partner | marketing | import | other.
 *
 * Mapping decisions (defaulted with warning where source is ambiguous):
 * 1 Advertisement → marketing
 * 2 Employee Referral → referral
 * 3 External Referral → referral
 * 4 Partner → partner
 * 5 Public Relations → marketing
 * 6 Seminar → event
 * 7 Trade Show → event
 * 8 Word of Mouth → referral
 * 9 Other → other
 */
const SOURCE_MAP = picklistMapper<
  | "web"
  | "referral"
  | "event"
  | "cold_call"
  | "partner"
  | "marketing"
  | "import"
  | "other"
>(
  {
    1: "marketing",
    2: "referral",
    3: "referral",
    4: "partner",
    5: "marketing",
    6: "event",
    7: "event",
    8: "referral",
    9: "other",
  },
  "source",
  "import",
);

/**
 * D365 lead `statuscode` (Status Reason) → mwg-crm `lead_status` enum.
 *
 * The MWG-MWGCRM org replaced the stock Open status reasons with a CUSTOM
 * option set, so the values are org-specific (100000xxx), not the stock
 * 1=New / 2=Contacted. The mapping below is the org's ACTUAL Status Reason
 * option set, read live from D365 EntityDefinitions metadata on 2026-06-16
 * (`statuscode` StatusAttributeMetadata, value | parent-state | label). Each
 * entry is annotated with its D365 label and parent statecode.
 *
 * mwg-crm `lead_status` enum values: new | attempting_contact | contacted |
 * scheduled_follow_up | recapture_termed | qualified | unqualified | converted
 * | lost. The three D365-mirrored Open statuses map 1:1 so an imported lead
 * shows its real D365 working status rather than a collapsed approximation.
 * (`converted` is reserved for an actual mwg-crm conversion and is never
 * produced by the import; "Open" maps to `new` — the same concept.)
 *
 * A KNOWN statuscode here is authoritative — e.g. "Attempting Contact" maps to
 * `attempting_contact` even though the lead's statecode is still Open. Only an
 * unrecognized / null statuscode falls back to the coarse statecode in the
 * mapper below.
 */
const STATUS_MAP = picklistMapper<
  | "new"
  | "attempting_contact"
  | "contacted"
  | "scheduled_follow_up"
  | "recapture_termed"
  | "qualified"
  | "unqualified"
  | "converted"
  | "lost"
>(
  {
    // ---- statecode 0 (Open) ----
    100000029: "new", // "Open"
    100000016: "attempting_contact", // "Attempting Contact"
    100000035: "scheduled_follow_up", // "Scheduled Follow-Up"
    100000043: "recapture_termed", // "Recapture Termed"
    // ---- statecode 1 (Qualified) ----
    3: "qualified", // "Qualified"
    // ---- statecode 2 (Disqualified) ----
    100000015: "lost", // "No Response"
    100000013: "lost", // "Not Interested"
    100000000: "lost", // "Already Has Coverage"
    100000017: "lost", // "Looking For Dental"
    100000011: "unqualified", // "Bogus Information"
    100000006: "lost", // "Working with Another Agent"
    100000009: "unqualified", // "Ineligible"
    100000030: "lost", // "Deceased"
    100000002: "lost", // "Other"
    100000037: "unqualified", // "Disqualified By Admin"
  },
  "status",
  "new",
);

/**
 * D365 `industrycode` → mwg-crm `industry` (free-text). The local
 * column is a TEXT field (no enum) so we surface the legacy default
 * label; unmapped values fall through to the numeric code as a
 * string + warning so reviewers can backfill.
 */
const INDUSTRY_LABELS: Record<number, string> = {
  1: "Accounting",
  2: "Agriculture and Non-petrol Natural Resource Extraction",
  3: "Broadcasting Printing and Publishing",
  4: "Brokers",
  5: "Building Supply Retail",
  6: "Business Services",
  7: "Consulting",
  8: "Consumer Services",
  9: "Design, Direction and Creative Management",
  10: "Distributors, Dispatchers and Processors",
  11: "Doctor's Offices and Clinics",
  12: "Durable Manufacturing",
  13: "Eating and Drinking Places",
  14: "Entertainment Retail",
  15: "Equipment Rental and Leasing",
  16: "Financial",
  17: "Food and Tobacco Processing",
  18: "Inbound Capital Intensive Processing",
  19: "Inbound Repair and Services",
  20: "Insurance",
  21: "Legal Services",
  22: "Non-Durable Merchandise Retail",
  23: "Outbound Consumer Service",
  24: "Petrochemical Extraction and Distribution",
  25: "Service Retail",
  26: "SIG Affiliations",
  27: "Social Services",
  28: "Special Outbound Trade Contractors",
  29: "Specialty Realty",
  30: "Transportation",
  31: "Utility Creation and Distribution",
  32: "Vehicle Retail",
  33: "Wholesale",
};

/* -------------------------------------------------------------------------- *
 * Native field allowlist *
 * -------------------------------------------------------------------------- */

/**
 * Native D365 fields the mapper consumes directly. Anything outside
 * this set (and not an OData annotation or `_*_value` lookup) is
 * routed to `metadata`.
 */
const NATIVE_LEAD_FIELDS: ReadonlySet<string> = new Set([
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
  "industrycode",
  "leadsourcecode",
  "leadqualitycode",
  "subject",
  "description",
  "donotemail",
  "donotbulkemail",
  "donotphone",
  "donotpostalmail",
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
  "createdon",
  "modifiedon",
  "statecode",
  "statuscode",
  "_ownerid_value",
  "_createdby_value",
  "_modifiedby_value",
  "_qualifyingopportunityid_value",
  "cdi_linkedin",
]);

/* -------------------------------------------------------------------------- *
 * Mapper *
 * -------------------------------------------------------------------------- */

export function mapD365Lead(
  raw: D365Lead,
  ctx: LeadMapContext,
): MapResult<NewLead> {
  const warnings: ValidationWarning[] = [];

  // Recency: throw on missing createdon (hard mapping failure).
  const createdAt = parseODataDate(raw.createdon);
  // modifiedon may legitimately equal createdon for never-touched leads.
  const updatedAt = parseODataDate(raw.modifiedon ?? raw.createdon);

  // Picklists.
  const ratingResult = RATING_MAP(
    typeof raw["leadqualitycode"] === "number"
      ? (raw["leadqualitycode"] as number)
      : null,
  );
  if (ratingResult.warning) warnings.push(ratingResult.warning);

  const sourceResult = SOURCE_MAP(raw.leadsourcecode ?? null);
  if (sourceResult.warning) warnings.push(sourceResult.warning);

  // Lead status: the org's `statuscode` (Status Reason) option set was
  // enumerated live (see STATUS_MAP above), so a KNOWN code is authoritative
  // and maps directly — e.g. "Attempting Contact" → contacted even though the
  // lead's statecode is still Open. Only an UNRECOGNIZED or null statuscode
  // falls back to the coarse `statecode` (1 = qualified, 2 = disqualified) so a
  // terminal lead still lands qualified/lost instead of the "new" default.
  // An unmapped statuscode does NOT emit the unmapped_picklist review flag
  // (it would route every such lead to manual review); the fallback resolves
  // it. The raw statuscode is preserved in `d365_status_code` / raw_payload.
  const statusResult = STATUS_MAP(raw.statuscode ?? null);
  let status = statusResult.value;
  const statuscodeUnknown =
    raw.statuscode == null || statusResult.warning != null;
  if (statuscodeUnknown) {
    if (raw.statecode === 1) status = "qualified";
    else if (raw.statecode === 2) status = "lost";
  }

  // Industry.
  let industry: string | null = null;
  if (raw.industrycode != null) {
    const label = INDUSTRY_LABELS[raw.industrycode];
    if (label) {
      industry = label;
    } else {
      industry = `industrycode:${raw.industrycode}`;
      warnings.push({
        field: "industry",
        code: "unmapped_picklist",
        message: `D365 industrycode ${raw.industrycode} is not mapped — stored as raw code.`,
      });
    }
  }

  // DNC merge: D365 has separate donotemail/donotphone/donotpostalmail
  // bool flags but no master "do not contact". Treat all-three-true as
  // doNotContact, otherwise propagate individually.
  const doNotEmail = !!raw.donotemail || !!raw.donotbulkemail;
  const doNotCall = !!raw.donotphone;
  const doNotContact = doNotEmail && doNotCall;

  // Build the insert. Keep firstName non-null per CHECK constraint —
  // D365 leads occasionally lack a first name; fall back to "Unknown"
  // and emit a warning instead of failing.
  let firstName = parseString(raw.firstname);
  if (!firstName) {
    firstName = "Unknown";
    warnings.push({
      field: "firstName",
      code: "missing_required",
      message: "D365 lead has no firstname; defaulted to 'Unknown'.",
    });
  }

  const customFields = extractCustomFields(
    raw as unknown as Record<string, unknown>,
    NATIVE_LEAD_FIELDS,
  );
  const metadata = Object.keys(customFields).length > 0 ? customFields : null;

  const mapped: NewLead = {
    ownerId: ctx.resolvedOwnerId,
    status,
    rating: ratingResult.value,
    source: sourceResult.value,
    salutation: parseString((raw as Record<string, unknown>)["salutation"]),
    firstName,
    lastName: parseString(raw.lastname),
    jobTitle: parseString(raw.jobtitle),
    companyName: parseString(raw.companyname),
    industry,
    email:
      parseString(raw.emailaddress1) ??
      parseString(raw.emailaddress2) ??
      parseString(raw.emailaddress3),
    phone: parseString(raw.telephone1) ?? parseString(raw.telephone2),
    mobilePhone: parseString(raw.mobilephone),
    // Validate scheme: only http/https survives; a javascript:/data: or
    // otherwise malformed source URL becomes null so it can never reach
    // the raw <a href> render sink on the lead detail / print pages.
    website: parseHttpUrl(raw.websiteurl),
    linkedinUrl: parseHttpUrl(
      (raw as Record<string, unknown>)["cdi_linkedin"],
    ),
    street1: parseString(raw.address1_line1),
    street2: parseString(raw.address1_line2),
    city: parseString(raw.address1_city),
    state: parseString(raw.address1_stateorprovince),
    postalCode: parseString(raw.address1_postalcode),
    country: parseString(raw.address1_country),
    description: parseString(raw.description),
    subject: parseString(raw.subject),
    doNotContact,
    doNotEmail,
    doNotCall,
    externalId: raw.leadid,
    // D365 statecode=1 means "Qualified", which maps to mwg-crm status
    // 'qualified' (see statecode override above) — NOT the distinct
    // 'converted' terminal state. Leaving convertedAt null keeps the two
    // signals consistent: an imported lead is never half-converted
    // (status='qualified' with a populated convertedAt). convertedAt is
    // stamped only on an actual mwg-crm conversion to 'converted'.
    convertedAt: null,
    lastActivityAt: null, // bumped at first counting activity, not import.
    createdVia: "imported",
    createdById: ctx.resolvedCreatedById ?? ctx.resolvedOwnerId,
    updatedById: ctx.resolvedUpdatedById ?? ctx.resolvedOwnerId,
    createdAt,
    updatedAt,
    d365StateCode:
      typeof raw.statecode === "number" ? raw.statecode : null,
    d365StatusCode:
      typeof raw.statuscode === "number" ? raw.statuscode : null,
    estimatedValue: ((): string | null => {
      const v = (raw as Record<string, unknown>)["estimatedamount"];
      if (v == null || v === "") return null;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n.toFixed(2) : null;
    })(),
    estimatedCloseDate: ((): string | null => {
      const v = (raw as Record<string, unknown>)["estimatedclosedate"];
      if (typeof v !== "string" || v === "") return null;
      // D365 dates may include a time component; trim to YYYY-MM-DD.
      const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : null;
    })(),
    metadata,
  };

  // Soft-validate against the existing creation schema. The schema
  // expects user-supplied input shape (camelCase), which matches the
  // mapped payload here. Failures convert to warnings.
  const softInputForZod: Record<string, unknown> = {
    salutation: mapped.salutation,
    firstName: mapped.firstName,
    lastName: mapped.lastName ?? "",
    jobTitle: mapped.jobTitle,
    companyName: mapped.companyName,
    industry: mapped.industry,
    email: mapped.email ?? "",
    phone: mapped.phone,
    mobilePhone: mapped.mobilePhone,
    website: mapped.website ?? "",
    linkedinUrl: mapped.linkedinUrl ?? "",
    street1: mapped.street1,
    street2: mapped.street2,
    city: mapped.city,
    state: mapped.state,
    postalCode: mapped.postalCode,
    country: mapped.country,
    description: mapped.description,
    subject: mapped.subject,
    status: mapped.status,
    rating: mapped.rating,
    source: mapped.source,
    estimatedValue: mapped.estimatedValue,
    estimatedCloseDate: mapped.estimatedCloseDate,
    doNotContact: mapped.doNotContact,
    doNotEmail: mapped.doNotEmail,
    doNotCall: mapped.doNotCall,
    ownerId: mapped.ownerId,
  };
  const zodResult = softValidate(leadCreateSchema, softInputForZod);
  warnings.push(...zodResult.warnings);

  // bad-lead quality assessment. Verdict drives
  // map-batch's auto-skip for `garbage` and surfaces warnings for
  // `suspicious`. Verdict travels on the mapped payload under
  // `_qualityVerdict` (a `_`-prefixed virtual stripped by
  // commit-batch's cleanPayload step before Drizzle insert).
  // Quality assessment uses RAW D365 values, not the mapped-and-defaulted
  // values. The mapper defaults missing firstName to "Unknown" to satisfy
  // the leads.first_name NOT NULL constraint — but `assessLeadQuality`
  // would then see "Unknown" and (correctly) flag it as a placeholder.
  // That's a false positive: a record with a real lastName + email but
  // missing firstName isn't garbage. Pass the pre-default raw value.
  const quality = assessLeadQuality({
    firstName: parseString(raw.firstname),
    lastName: parseString(raw.lastname),
    companyName: parseString(raw.companyname),
    // Assess the same email the mapper commits (emailaddress1 ?? 2 ?? 3),
    // not just emailaddress1. A junk primary with a valid secondary must
    // not verdict garbage/suspicious and auto-skip a usable lead.
    email:
      parseString(raw.emailaddress1) ??
      parseString(raw.emailaddress2) ??
      parseString(raw.emailaddress3),
    phone: parseString(raw.telephone1),
    mobilePhone: parseString(raw.mobilephone),
    jobTitle: parseString(raw.jobtitle),
    description: parseString(raw.description),
    subject: parseString(raw.subject),
    industry: mapped.industry,
    city: parseString(raw.address1_city),
    state: parseString(raw.address1_stateorprovince),
  });
  if (quality.verdict !== "clean") {
    for (const reason of quality.reasons) {
      warnings.push({
        field: "__quality__",
        code:
          quality.verdict === "garbage"
            ? "bad_lead_quality"
            : "suspicious_lead_quality",
        message: reason,
      });
    }
  }
  (mapped as Record<string, unknown>)._qualityVerdict = quality.verdict;
  (mapped as Record<string, unknown>)._qualityReasons = quality.reasons;

  // Aggregate the nested child graph (task / phonecall / appointment /
  // email / annotation) into `attached`. The ROOT — this lead — drives
  // each child's parent type/source via parentContext, so commit-batch
  // links them to this lead's in-memory UUID. Child-level mapping
  // failures degrade to warnings (mapAttachedChildren isolates them).
  const { attached, warnings: childWarnings } = mapAttachedChildren({
    children: ctx.children,
    parentContext: { parentEntityType: "lead", parentSourceId: raw.leadid },
    fallbackUserId: ctx.resolvedOwnerId,
    resolveChildOwnerId: ctx.resolveChildOwnerId,
  });
  warnings.push(...childWarnings);

  return { mapped, attached, customFields, warnings };
}
