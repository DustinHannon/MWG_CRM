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
  const doNotContact = doNotEmail && doNotCall;

  const customFields = extractCustomFields(
    raw as unknown as Record<string, unknown>,
    NATIVE_CONTACT_FIELDS,
  );
  const metadata = Object.keys(customFields).length > 0 ? customFields : null;

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
    ownerId: ctx.resolvedOwnerId,
    createdById: ctx.resolvedOwnerId,
    updatedById: ctx.resolvedOwnerId,
    createdAt,
    updatedAt,
    metadata,
  };

  const attached: AttachedActivity[] = [];
  return { mapped, attached, customFields, warnings };
}
