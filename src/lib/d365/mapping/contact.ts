import "server-only";
import type { InferInsertModel } from "drizzle-orm";
import type { contacts } from "@/db/schema/crm-records";
import type { D365Contact } from "../types";
import {
  type AttachedActivity,
  type MapResult,
  type ValidationWarning,
  extractCustomFields,
  parseODataDate,
  parseString,
} from "./parsers";

export type NewContact = InferInsertModel<typeof contacts>;

export interface ContactMapContext {
  resolvedOwnerId: string;
  /**
   * Optional — distinct resolved users for `_createdby_value` and
   * `_modifiedby_value`. When the orchestrator can't resolve them to a
   * local users row it falls back to `resolvedOwnerId` so audit
   * attribution stays consistent.
   */
  resolvedCreatedById?: string | null;
  resolvedUpdatedById?: string | null;
  /**
   * Optional — when the contact's `_parentcustomerid_value` /
   * `_accountid_value` resolves to a local crm_accounts row at orchestrator
   * time, that local UUID lands on `contacts.account_id`. Mapper returns
   * null when unresolved; commit code may patch later.
   */
  resolvedAccountId?: string | null;
}

const NATIVE_CONTACT_FIELDS: ReadonlySet<string> = new Set([
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
  "donotbulkemail",
  "donotphone",
  "donotpostalmail",
  "donotfax",
  "donotsendmm",
  "address1_line1",
  "address1_line2",
  "address1_city",
  "address1_stateorprovince",
  "address1_postalcode",
  "address1_country",
  "_parentcustomerid_value",
  "_accountid_value",
  "_ownerid_value",
  "_createdby_value",
  "_modifiedby_value",
  "createdon",
  "modifiedon",
  "statecode",
  "statuscode",
  "birthdate",
]);

export function mapD365Contact(
  raw: D365Contact,
  ctx: ContactMapContext,
): MapResult<NewContact> {
  const warnings: ValidationWarning[] = [];

  const createdAt = parseODataDate(raw.createdon);
  const updatedAt = parseODataDate(raw.modifiedon ?? raw.createdon);

  let firstName = parseString(raw.firstname);
  if (!firstName) {
    firstName = "Unknown";
    warnings.push({
      field: "firstName",
      code: "missing_required",
      message: "D365 contact has no firstname; defaulted to 'Unknown'.",
    });
  }

  const doNotEmail = !!raw.donotemail;
  const doNotCall = !!raw.donotphone;
  const doNotMail = !!raw.donotpostalmail;
  // doNotContact remains the OR-pair of email+call so existing UI badges
  // continue to read "do not contact" the same way; mail-only suppression
  // surfaces via doNotMail.
  const doNotContact = doNotEmail && doNotCall;

  // statecode/statuscode mirror: D365 statecode=1 means Inactive. We
  // soft-delete inactive contacts at import time so they don't appear in
  // default lists, but preserve the raw codes on the row for forensics
  // and so a future re-activation flow can find them.
  const d365StateCode =
    typeof raw.statecode === "number" ? raw.statecode : null;
  const d365StatusCode =
    typeof raw.statuscode === "number" ? raw.statuscode : null;
  const isInactive = d365StateCode === 1;

  const customFields = extractCustomFields(
    raw as unknown as Record<string, unknown>,
    NATIVE_CONTACT_FIELDS,
  );
  const metadata = Object.keys(customFields).length > 0 ? customFields : null;

  const createdById = ctx.resolvedCreatedById ?? ctx.resolvedOwnerId;
  const updatedById = ctx.resolvedUpdatedById ?? ctx.resolvedOwnerId;

  // Stash the raw D365 GUID for the parent account on the mapped
  // payload as a `_`-prefixed virtual. commit-batch resolves it to a
  // local crm_accounts.id via external_ids before the contact insert
  // and strips the virtual via the underscore filter.
  const accountSourceId =
    parseString(raw._parentcustomerid_value) ?? parseString(raw._accountid_value);

  const mapped: NewContact = {
    accountId: ctx.resolvedAccountId ?? null,
    firstName,
    lastName: parseString(raw.lastname),
    jobTitle: parseString(raw.jobtitle),
    email:
      parseString(raw.emailaddress1) ??
      parseString(raw.emailaddress2) ??
      parseString(raw.emailaddress3),
    phone: parseString(raw.telephone1) ?? parseString(raw.telephone2),
    mobilePhone: parseString(raw.mobilephone),
    description: parseString(raw.description),
    doNotContact,
    doNotEmail,
    doNotCall,
    doNotMail,
    street1: parseString(raw.address1_line1),
    street2: parseString(raw.address1_line2),
    city: parseString(raw.address1_city),
    state: parseString(raw.address1_stateorprovince),
    postalCode: parseString(raw.address1_postalcode),
    country: parseString(raw.address1_country),
    // birthdate is a DATE column; D365 emits ISO with a midnight or
    // 05:00Z stamp. Store the YYYY-MM-DD prefix; drizzle's `date` column
    // accepts a string.
    birthdate: parseISODateOnly(raw.birthdate),
    d365StateCode,
    d365StatusCode,
    isDeleted: isInactive,
    deletedAt: isInactive ? updatedAt : null,
    deleteReason: isInactive ? "d365_inactive" : null,
    ownerId: ctx.resolvedOwnerId,
    createdById,
    updatedById,
    createdAt,
    updatedAt,
    metadata,
  };

  // Attach the parent-account virtual so commit-batch can resolve it.
  if (accountSourceId) {
    (mapped as Record<string, unknown>)._accountSourceId = accountSourceId;
  }

  const attached: AttachedActivity[] = [];
  return { mapped, attached, customFields, warnings };
}

function parseISODateOnly(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0) return null;
  // D365 birthdate is typically "1958-04-16T05:00:00Z" or
  // "1958-04-16" — split on T and keep the date prefix. Validate the
  // YYYY-MM-DD shape so a malformed string drops instead of crashing.
  const datePart = v.split("T", 1)[0];
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : null;
}
