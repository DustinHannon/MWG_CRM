import "server-only";
import type { InferInsertModel } from "drizzle-orm";
import type { opportunities } from "@/db/schema/crm-records";
import type { D365Opportunity } from "../types";
import {
  type AttachedActivity,
  type MapResult,
  type ValidationWarning,
  extractCustomFields,
  parseODataDate,
  parseOptionalDate,
  parseString,
  picklistMapper,
} from "./parsers";

export type NewOpportunity = InferInsertModel<typeof opportunities>;

export interface OpportunityMapContext {
  resolvedOwnerId: string;
  resolvedAccountId?: string | null;
  resolvedPrimaryContactId?: string | null;
  resolvedSourceLeadId?: string | null;
}

const NATIVE_OPPORTUNITY_FIELDS: ReadonlySet<string> = new Set([
  "opportunityid",
  "name",
  "description",
  "estimatedvalue",
  "estimatedclosedate",
  "actualvalue",
  "actualclosedate",
  "closeprobability",
  "stepname",
  "_customerid_value",
  "_parentaccountid_value",
  "_parentcontactid_value",
  "_originatingleadid_value",
  "_ownerid_value",
  "_createdby_value",
  "_modifiedby_value",
  "createdon",
  "modifiedon",
  "statecode",
  "statuscode",
  "salesstagecode",
]);

/**
 * D365 opportunity `salesstagecode` (Sales Stage) → mwg-crm
 * `opportunity_stage` enum.
 *
 * Default D365 sales-process stages aren't a fixed numeric option-set
 * the way leads are; many tenants override. The legacy default stage
 * picklist (Microsoft.Crm.Sdk.Messages — Opportunity.SalesStage):
 * 0=Qualify, 1=Develop, 2=Propose, 3=Close.
 *
 * mwg-crm `opportunity_stage`: prospecting | qualification | proposal
 * | negotiation | closed_won | closed_lost.
 */
const SALES_STAGE_MAP = picklistMapper<
  | "prospecting"
  | "qualification"
  | "proposal"
  | "negotiation"
  | "closed_won"
  | "closed_lost"
>(
  {
    0: "qualification",
    1: "prospecting",
    2: "proposal",
    3: "negotiation",
  },
  "stage",
  "prospecting",
);

export function mapD365Opportunity(
  raw: D365Opportunity,
  ctx: OpportunityMapContext,
): MapResult<NewOpportunity> {
  const warnings: ValidationWarning[] = [];

  const createdAt = parseODataDate(raw.createdon);
  const updatedAt = parseODataDate(raw.modifiedon ?? raw.createdon);

  let name = parseString(raw.name);
  if (!name) {
    name = "Untitled Opportunity";
    warnings.push({
      field: "name",
      code: "missing_required",
      message:
        "D365 opportunity has no name; defaulted to 'Untitled Opportunity'.",
    });
  }

  // Stage: pick from salesstagecode first, then collapse to terminal
  // states based on statecode (1 = Won, 2 = Lost per default
  // metadata).
  const stageResult = SALES_STAGE_MAP(
    typeof (raw as Record<string, unknown>)["salesstagecode"] === "number"
      ? ((raw as Record<string, unknown>)["salesstagecode"] as number)
      : null,
  );
  if (stageResult.warning) warnings.push(stageResult.warning);
  let stage = stageResult.value;
  if (raw.statecode === 1) stage = "closed_won";
  else if (raw.statecode === 2) stage = "closed_lost";

  const closedAt =
    raw.statecode === 1 || raw.statecode === 2
      ? parseOptionalDate(raw.actualclosedate ?? raw.modifiedon ?? null)
      : null;

  const customFields = extractCustomFields(
    raw as unknown as Record<string, unknown>,
    NATIVE_OPPORTUNITY_FIELDS,
  );
  const metadata = Object.keys(customFields).length > 0 ? customFields : null;

  const amount: string | null = ((): string | null => {
    const v = raw.estimatedvalue;
    if (v == null) return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n.toFixed(2) : null;
  })();

  const expectedCloseDate: string | null = ((): string | null => {
    const v = raw.estimatedclosedate;
    if (typeof v !== "string" || v === "") return null;
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  })();

  const probability: number | null = ((): number | null => {
    const v = raw.closeprobability;
    if (v == null) return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  })();

  const mapped: NewOpportunity = {
    accountId: ctx.resolvedAccountId ?? null,
    primaryContactId: ctx.resolvedPrimaryContactId ?? null,
    name,
    stage,
    amount,
    probability,
    expectedCloseDate,
    description: parseString(raw.description),
    ownerId: ctx.resolvedOwnerId,
    createdById: ctx.resolvedOwnerId,
    updatedById: ctx.resolvedOwnerId,
    sourceLeadId: ctx.resolvedSourceLeadId ?? null,
    createdAt,
    updatedAt,
    closedAt,
    metadata,
  };

  const attached: AttachedActivity[] = [];
  return { mapped, attached, customFields, warnings };
}
