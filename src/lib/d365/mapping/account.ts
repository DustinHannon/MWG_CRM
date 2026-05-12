import "server-only";
import type { InferInsertModel } from "drizzle-orm";
import type { crmAccounts } from "@/db/schema/crm-records";
import type { D365Account } from "../types";
import {
  type AttachedActivity,
  type MapResult,
  type ValidationWarning,
  extractCustomFields,
  parseODataDate,
  parseString,
} from "./parsers";

export type NewAccount = InferInsertModel<typeof crmAccounts>;

export interface AccountMapContext {
  resolvedOwnerId: string;
}

const NATIVE_ACCOUNT_FIELDS: ReadonlySet<string> = new Set([
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
  "_primarycontactid_value",
  "_parentaccountid_value",
  "_ownerid_value",
  "_createdby_value",
  "_modifiedby_value",
  "createdon",
  "modifiedon",
  "statecode",
  "statuscode",
]);

const ACCOUNT_INDUSTRY_LABELS: Record<number, string> = {
  1: "Accounting",
  2: "Agriculture",
  3: "Broadcasting / Publishing",
  4: "Brokers",
  5: "Building Supply Retail",
  6: "Business Services",
  7: "Consulting",
  8: "Consumer Services",
  9: "Design / Creative",
  10: "Distribution",
  11: "Healthcare",
  12: "Manufacturing",
  13: "Food / Beverage",
  14: "Entertainment",
  15: "Equipment Rental / Leasing",
  16: "Financial",
  17: "Food / Tobacco",
  18: "Capital-Intensive Processing",
  19: "Repair / Services",
  20: "Insurance",
  21: "Legal Services",
  22: "Retail",
  23: "Outbound Consumer Service",
  24: "Petrochemical",
  25: "Service Retail",
  26: "SIG Affiliations",
  27: "Social Services",
  28: "Trade Contractors",
  29: "Realty",
  30: "Transportation",
  31: "Utilities",
  32: "Vehicle Retail",
  33: "Wholesale",
};

export function mapD365Account(
  raw: D365Account,
  ctx: AccountMapContext,
): MapResult<NewAccount> {
  const warnings: ValidationWarning[] = [];

  const createdAt = parseODataDate(raw.createdon);
  const updatedAt = parseODataDate(raw.modifiedon ?? raw.createdon);

  let name = parseString(raw.name);
  if (!name) {
    name = "Unknown Account";
    warnings.push({
      field: "name",
      code: "missing_required",
      message: "D365 account has no name; defaulted to 'Unknown Account'.",
    });
  }

  let industry: string | null = null;
  if (raw.industrycode != null) {
    const label = ACCOUNT_INDUSTRY_LABELS[raw.industrycode];
    if (label) {
      industry = label;
    } else {
      industry = `industrycode:${raw.industrycode}`;
      warnings.push({
        field: "industry",
        code: "unmapped_picklist",
        message: `D365 account industrycode ${raw.industrycode} is not mapped — stored as raw code.`,
      });
    }
  }

  const customFields = extractCustomFields(
    raw as unknown as Record<string, unknown>,
    NATIVE_ACCOUNT_FIELDS,
  );
  const metadata = Object.keys(customFields).length > 0 ? customFields : null;

  const d365StateCode =
    typeof raw.statecode === "number" ? raw.statecode : null;
  const d365StatusCode =
    typeof raw.statuscode === "number" ? raw.statuscode : null;
  // D365 account statecode=1 means Inactive. Mirror as is_deleted at
  // import time but preserve the raw code on the row for forensics.
  const isInactive = d365StateCode === 1;

  const numberOfEmployees =
    typeof (raw as Record<string, unknown>).numberofemployees === "number"
      ? ((raw as Record<string, unknown>).numberofemployees as number)
      : null;
  const annualRevenue = ((): string | null => {
    const v = (raw as Record<string, unknown>).revenue;
    if (v == null) return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n.toFixed(2) : null;
  })();

  const mapped: NewAccount = {
    name,
    industry,
    website: parseString(raw.websiteurl),
    phone: parseString(raw.telephone1),
    email: parseString(raw.emailaddress1),
    accountNumber: parseString(
      (raw as Record<string, unknown>).accountnumber,
    ),
    numberOfEmployees,
    annualRevenue,
    street1: parseString(raw.address1_line1),
    street2: parseString(raw.address1_line2),
    city: parseString(raw.address1_city),
    state: parseString(raw.address1_stateorprovince),
    postalCode: parseString(raw.address1_postalcode),
    country: parseString(raw.address1_country),
    description: parseString(raw.description),
    d365StateCode,
    d365StatusCode,
    // FK to local rows is left null; the orchestrator resolves these
    // by sourceId lookup in a post-pass once parents are committed.
    parentAccountId: null,
    primaryContactId: null,
    isDeleted: isInactive,
    deletedAt: isInactive ? updatedAt : null,
    deleteReason: isInactive ? "d365_inactive" : null,
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
