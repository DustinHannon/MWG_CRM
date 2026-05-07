// Phase 6E — orchestrator. Takes a raw cell map for a single row and
// produces a fully parsed `ParsedRow` ready for the commit pipeline:
// validated lead patch, expanded activity[]/opportunity[] arrays, plus
// per-row warnings/errors.
//
// This module is pure (no DB) — user resolution + dedup-key
// computation happen later in commit.ts where lead ids exist.

import { z } from "zod";
import { detectD365 } from "./d365-detect";
import {
  parseAllActivityColumns,
  parseActivityColumn,
  type ParseWarning,
  type ParsedActivity,
} from "./activity-parser";
import {
  D365_STATUS_TO_LEAD_STATUS,
  mapLeadStatus,
  mapOpportunityStage,
  type LeadStatusEnum,
} from "./stage-mapping";
import {
  normaliseEmail,
  normalisePhone,
  normaliseUrl,
  parseBoolish,
  parseCurrencyish,
  parseIntInRange,
  parseIsoDate,
  trimToNull,
} from "./normalize";
import { type ImportRowInput, importRowSchema } from "./row-schema";
import {
  LEAD_RATINGS,
  LEAD_SOURCES,
  LEAD_STATUSES,
} from "@/lib/lead-constants";

export interface ParsedOpportunity {
  name: string;
  stage: string;
  probability: number | null;
  amount: number | null;
  ownerEmail: string | null;
  ownerName: string | null;
  description: string | null;
}

export interface ParsedRow {
  rowNumber: number;
  ok: true;
  /** The lead patch ready for INSERT/UPDATE. snake_case matching the DB column names is NOT required — Drizzle handles the mapping; we use camelCase here because that's what the schema expects. */
  leadPatch: ImportRowInput & {
    estimatedValue: number | null;
    estimatedCloseDate: Date | null;
    lastActivityAt: Date | null;
  };
  activities: ParsedActivity[];
  opportunities: ParsedOpportunity[];
  warnings: string[];
  ownerEmailLower: string | null;
}

export interface FailedRow {
  rowNumber: number;
  ok: false;
  errors: string[];
}

export type ParseResult = ParsedRow | FailedRow;

const VALID_STATUSES = new Set(LEAD_STATUSES);
const VALID_RATINGS = new Set(LEAD_RATINGS);
const VALID_SOURCES = new Set(LEAD_SOURCES);

interface ParseRowArgs {
  rowNumber: number;
  raw: Record<string, string | undefined>;
  smartDetect: boolean;
}

export function parseImportRow(args: ParseRowArgs): ParseResult {
  const { rowNumber, raw, smartDetect } = args;
  const warnings: string[] = [];
  const errors: string[] = [];

  // ---- Stage 1: normalise primitive fields ------------------------------
  const status = (raw.status ?? "").trim().toLowerCase();
  const rating = (raw.rating ?? "").trim().toLowerCase();
  const source = (raw.source ?? "").trim().toLowerCase();

  // Status: try direct lower match against our enum first; if blank,
  // also try a case-sensitive D365-status mapping (e.g., "Open" → "new").
  let resolvedStatus: LeadStatusEnum = "new";
  if (status.length > 0 && VALID_STATUSES.has(status as LeadStatusEnum)) {
    resolvedStatus = status as LeadStatusEnum;
  } else if (raw.status && raw.status.trim().length > 0) {
    const d365 = mapLeadStatus(raw.status);
    if (d365.fallback) {
      warnings.push(
        `Unknown status "${raw.status.trim()}" — defaulted to "new".`,
      );
    }
    resolvedStatus = d365.status;
  }

  const resolvedRating: (typeof LEAD_RATINGS)[number] =
    VALID_RATINGS.has(rating as (typeof LEAD_RATINGS)[number])
      ? (rating as (typeof LEAD_RATINGS)[number])
      : "warm";
  const resolvedSource: (typeof LEAD_SOURCES)[number] =
    VALID_SOURCES.has(source as (typeof LEAD_SOURCES)[number])
      ? (source as (typeof LEAD_SOURCES)[number])
      : "import";

  // Description / Subject / smart-detect.
  let subject = trimToNull(raw.subject, 1000);
  let description = trimToNull(raw.description, 20_000);
  let detectedActivities: ParsedActivity[] = [];
  let detectedOpps: ParsedOpportunity[] = [];

  if (smartDetect && description) {
    const detected = detectD365(description);
    for (const w of detected.warnings) warnings.push(formatParseWarning(w));
    if (detected.topic && !subject) {
      subject = detected.topic.slice(0, 1000);
    }
    if (detected.description !== undefined) {
      description = detected.description.slice(0, 20_000);
    } else if (detected.topic || detected.activities.length > 0 || detected.opportunities.length > 0) {
      // Non-trivial detection happened; clear the description so we
      // don't leave the D365 dump in the description column.
      description = null;
    }
    detectedActivities = detected.activities;
    detectedOpps = detected.opportunities.map(toFullOpp);
  }

  // Activities from the dedicated columns. Dedicated columns take
  // precedence over smart-detect when both are populated.
  const dedicatedParse = parseAllActivityColumns({
    notes: raw.notes,
    phoneCalls: raw.phoneCalls,
    meetings: raw.meetings,
    emails: raw.emails,
  });
  for (const w of dedicatedParse.warnings) warnings.push(formatParseWarning(w));

  const activities: ParsedActivity[] =
    dedicatedParse.activities.length > 0
      ? dedicatedParse.activities
      : detectedActivities;
  // Combine: dedicated FIRST (prefer when both populated), then smart-detect
  // appends only if dedicated was empty. (We picked one or the other above.)

  // Opportunities — dedicated columns vs smart-detect.
  const dedicatedOpp = buildOppFromColumns(raw, warnings);
  const opportunities: ParsedOpportunity[] = dedicatedOpp
    ? [dedicatedOpp]
    : detectedOpps;

  // ---- Stage 2: build the lead patch -----------------------------------
  const estValue = parseCurrencyish(raw.estimatedValue);
  const estCloseDate = parseIsoDate(raw.estimatedCloseDate);
  const lastActivityCol = parseIsoDate(raw.lastActivityAt);

  // Compute lastActivityAt: max of imported counting activities, or
  // the manual override column if provided AND later than computed.
  let computedLastActivity: Date | null = null;
  for (const a of activities) {
    if (!computedLastActivity || a.occurredAt > computedLastActivity) {
      computedLastActivity = a.occurredAt;
    }
  }
  const finalLastActivity =
    lastActivityCol && (!computedLastActivity || lastActivityCol > computedLastActivity)
      ? lastActivityCol
      : computedLastActivity;

  const candidate: Record<string, unknown> = {
    firstName: trimToNull(raw.firstName, 100),
    lastName: trimToNull(raw.lastName, 100),
    email: normaliseEmail(raw.email),
    phone: normalisePhone(raw.phone),
    mobilePhone: normalisePhone(raw.mobilePhone),
    jobTitle: trimToNull(raw.jobTitle, 200),
    companyName: trimToNull(raw.companyName, 200),
    industry: trimToNull(raw.industry, 100),
    website: normaliseUrl(raw.website),
    linkedinUrl: normaliseUrl(raw.linkedinUrl),
    street1: trimToNull(raw.street1, 200),
    street2: trimToNull(raw.street2, 200),
    city: trimToNull(raw.city, 100),
    state: trimToNull(raw.state, 100),
    postalCode: trimToNull(raw.postalCode, 20),
    country: trimToNull(raw.country, 100),
    status: resolvedStatus,
    rating: resolvedRating,
    source: resolvedSource,
    estimatedValue: estValue,
    estimatedCloseDate: estCloseDate,
    subject,
    description,
    notes: raw.notes ?? null,
    phoneCalls: raw.phoneCalls ?? null,
    meetings: raw.meetings ?? null,
    emails: raw.emails ?? null,
    lastActivityAt: finalLastActivity,
    oppName: trimToNull(raw.oppName, 200),
    oppStage: trimToNull(raw.oppStage, 50),
    oppProbability: parseIntInRange(raw.oppProbability, 0, 100),
    oppAmount: parseCurrencyish(raw.oppAmount),
    oppOwnerEmail: normaliseEmail(raw.oppOwnerEmail),
    tags: trimToNull(raw.tags, 500),
    doNotContact: parseBoolish(raw.doNotContact),
    doNotEmail: parseBoolish(raw.doNotEmail),
    doNotCall: parseBoolish(raw.doNotCall),
    ownerEmail: normaliseEmail(raw.ownerEmail),
    externalId: trimToNull(raw.externalId, 120),
  };

  // ---- Stage 3: validate -----------------------------------------------
  const result = importRowSchema.safeParse(candidate);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(
        `${issue.path.join(".")}: ${issue.message}`,
      );
    }
  }

  // Either firstName OR email must be present — otherwise the record
  // is unidentifiable. Brief specifies row 23 of test file ("missing
  // First Name AND Email") as the canonical hard-fail case.
  if (!candidate.firstName && !candidate.email) {
    errors.push("Row has neither First Name nor Email — cannot identify the lead.");
  }

  if (errors.length > 0) {
    return { rowNumber, ok: false, errors };
  }

  return {
    rowNumber,
    ok: true,
    leadPatch: result.data as ParsedRow["leadPatch"],
    activities,
    opportunities,
    warnings,
    ownerEmailLower: normaliseEmail(raw.ownerEmail),
  };
}

function buildOppFromColumns(
  raw: Record<string, string | undefined>,
  warnings: string[],
): ParsedOpportunity | null {
  const name = trimToNull(raw.oppName, 200);
  if (!name) return null;
  // Dedicated stage column may be either an MWG enum value or a D365
  // string — try both.
  const rawStage = trimToNull(raw.oppStage, 50);
  let stage = "prospecting";
  if (rawStage) {
    const lower = rawStage.toLowerCase();
    // Accept MWG-enum-shaped values directly.
    if (
      lower === "prospecting" ||
      lower === "qualification" ||
      lower === "proposal" ||
      lower === "negotiation" ||
      lower === "closed_won" ||
      lower === "closed_lost"
    ) {
      stage = lower;
    } else {
      const d365 = mapOpportunityStage(rawStage);
      if (d365.fallback) {
        warnings.push(
          `Unknown opportunity stage "${rawStage}" — defaulted to "prospecting".`,
        );
      }
      stage = d365.stage;
    }
  }
  return {
    name,
    stage,
    probability: parseIntInRange(raw.oppProbability, 0, 100),
    amount: parseCurrencyish(raw.oppAmount),
    ownerEmail: normaliseEmail(raw.oppOwnerEmail),
    ownerName: null,
    description: null,
  };
}

function toFullOpp(o: {
  name?: string;
  status?: string;
  probability?: number;
  amount?: number;
  ownerName?: string;
  description?: string;
}): ParsedOpportunity {
  // No warnings array threaded through here — smart-detect already
  // pushed parse warnings via detectedWarnings above.
  let stage = "prospecting";
  if (o.status) {
    const m = mapOpportunityStage(o.status);
    stage = m.stage;
  }
  return {
    name: o.name ?? "Untitled opportunity",
    stage,
    probability: o.probability ?? null,
    amount: o.amount ?? null,
    ownerEmail: null,
    ownerName: o.ownerName ?? null,
    description: o.description ?? null,
  };
}

function formatParseWarning(w: ParseWarning): string {
  return w.line ? `Line ${w.line}: ${w.message}` : w.message;
}

// Suppress lint for unused imports retained for type clarity.
void z;
void parseActivityColumn;
void D365_STATUS_TO_LEAD_STATUS;
