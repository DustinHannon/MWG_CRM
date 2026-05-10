import "server-only";
import type { InferInsertModel } from "drizzle-orm";
import { leadCreateSchema } from "@/lib/leads";
import type { leads } from "@/db/schema/leads";
import type { D365Lead } from "../types";
import { assessLeadQuality } from "../quality";
import {
  type AttachedActivity,
  type MapResult,
  type ValidationWarning,
  extractCustomFields,
  parseODataDate,
  parseOptionalDate,
  parseString,
  picklistMapper,
  softValidate,
} from "./parsers";

/**
 * Phase 23 — D365 `lead` → mwg-crm `leads` insert payload.
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
   * mwg-crm `users.id` resolved by Sub-agent A from the D365
   * `_ownerid_value` GUID via `resolveD365Owner`. The mapper itself
   * does not call into the network.
   */
  resolvedOwnerId: string;
}

/* -------------------------------------------------------------------------- *
 *                           Picklist tables                                  *
 * -------------------------------------------------------------------------- */

/**
 * D365 `leadqualitycode` (rating) → mwg-crm `lead_rating` enum.
 *
 * Default D365 option-set values from the SDK metadata documentation
 * (Microsoft.Crm.Sdk.Messages — Lead.LeadQualityCode):
 *   1 = Hot, 2 = Warm, 3 = Cold.
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
 *   1=Advertisement, 2=Employee Referral, 3=External Referral,
 *   4=Partner, 5=Public Relations, 6=Seminar, 7=Trade Show,
 *   8=Word of Mouth, 9=Other.
 *
 * mwg-crm `lead_source` enum values (see lead-constants.ts):
 *   web | referral | event | cold_call | partner | marketing | import | other.
 *
 * Mapping decisions (defaulted with warning where source is ambiguous):
 *   - 1 Advertisement → marketing
 *   - 2 Employee Referral → referral
 *   - 3 External Referral → referral
 *   - 4 Partner → partner
 *   - 5 Public Relations → marketing
 *   - 6 Seminar → event
 *   - 7 Trade Show → event
 *   - 8 Word of Mouth → referral
 *   - 9 Other → other
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
 * D365 `statuscode` (lead lifecycle) → mwg-crm `lead_status` enum.
 *
 * Per brief — legacy D365 default option-set values:
 *   1=New, 2=Contacted, 3=Qualified, 4=Lost, 5=Cant_Contact,
 *   6=No_Longer_Interested, 7=Cancelled.
 *
 * mwg-crm `lead_status` enum values: new | contacted | qualified |
 * unqualified | converted | lost.
 *
 * NOTE: D365 `statecode` (state) drives `lost` vs `qualified` more
 * cleanly than `statuscode` alone. We layer that in below — this
 * map is for the inactive/disqualified status detail.
 */
const STATUS_MAP = picklistMapper<
  "new" | "contacted" | "qualified" | "unqualified" | "converted" | "lost"
>(
  {
    1: "new",
    2: "contacted",
    3: "qualified",
    4: "lost",
    5: "unqualified",
    6: "unqualified",
    7: "lost",
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
 *                          Native field allowlist                            *
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
  "linkedinprofile",
]);

/* -------------------------------------------------------------------------- *
 *                                Mapper                                      *
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

  const statusResult = STATUS_MAP(raw.statuscode ?? null);
  if (statusResult.warning) warnings.push(statusResult.warning);

  // statecode override: 1 = qualified, 2 = disqualified per default
  // metadata. Layer on top so we don't lose terminal-state semantics.
  let status = statusResult.value;
  if (raw.statecode === 1) {
    status = status === "lost" ? status : "qualified";
  } else if (raw.statecode === 2) {
    status = status === "qualified" || status === "converted" ? status : "lost";
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
    website: parseString(raw.websiteurl),
    linkedinUrl: parseString(
      (raw as Record<string, unknown>)["linkedinprofile"],
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
    convertedAt:
      raw.statecode === 1
        ? parseOptionalDate(raw.modifiedon ?? null)
        : null,
    lastActivityAt: null, // bumped at first counting activity, not import.
    createdVia: "imported",
    createdById: ctx.resolvedOwnerId,
    updatedById: ctx.resolvedOwnerId,
    createdAt,
    updatedAt,
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

  // Phase 23 — bad-lead quality assessment. Verdict drives
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
    email: parseString(raw.emailaddress1),
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

  // Attached activities are populated by the orchestrator from
  // $expand'd children; the lead mapper itself returns an empty
  // array — child mappers (annotation, task, phonecall, appointment,
  // email) produce their own AttachedActivity entries that are
  // stitched in later by `mapBatch`.
  const attached: AttachedActivity[] = [];

  return { mapped, attached, customFields, warnings };
}
