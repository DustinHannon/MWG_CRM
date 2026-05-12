// Legacy D365 "Description" field smart-detect.
//
// Real production data ships with everything crammed into a single
// `Description` column: Topic, Phone Calls, Notes, Meetings, Linked
// Opportunity records, plus the literal Description text. This parser
// recognises that shape and splits it into structured pieces so the
// import pipeline can write proper subject/activities/opportunities.
//
// Smart-detect is opt-in (a checkbox on the import preview). New
// imports should use the dedicated columns from the new template
// instead. This module is the one-shot bridge for legacy data.

import {
  parseActivityColumn,
  type ParsedActivity,
  type ParseWarning,
} from "./activity-parser";

export interface ParsedOpportunity {
  name?: string;
  status?: string; // raw D365 — caller maps via stage-mapping.ts
  probability?: number;
  amount?: number;
  ownerName?: string;
  description?: string;
}

export interface DetectedSections {
  topic?: string;
  description?: string;
  activities: ParsedActivity[];
  opportunities: ParsedOpportunity[];
  warnings: ParseWarning[];
}

const SECTION_LABELS = [
  "Topic:",
  "Description:",
  "Phone Calls:",
  "Notes:",
  "Appointments:",
  "Meetings:",
  "Emails:",
  "Linked Opportunity:",
] as const;

/** Returns true if the description value looks like a D365 dump. */
export function isD365Shape(description: string | null | undefined): boolean {
  if (!description) return false;
  for (const label of SECTION_LABELS) {
    // Anchor to start-of-line; treat case-sensitively to match D365 output.
    if (
      description.startsWith(label + "\n") ||
      description.startsWith(label + " ") ||
      description === label.replace(/:$/, "") + ":" ||
      new RegExp(`(?:^|\\n)${escapeRegExp(label)}(?=\\s|$)`).test(description)
    ) {
      return true;
    }
  }
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface RawSection {
  label: (typeof SECTION_LABELS)[number];
  bodyLines: string[];
  startLine: number;
}

/**
 * Walk the description line-by-line and split it into named sections.
 * A section header is a line whose only content is one of SECTION_LABELS
 * (case-sensitive, optional trailing whitespace). Section content is
 * everything until the next section header at the same indentation
 * level, or end-of-string.
 *
 * The "Topic:" form is special — it can appear as a single line
 * "Topic: <value>" (no body); we detect that shape too.
 */
function splitSections(description: string): {
  sections: RawSection[];
  topicInline?: string;
  warnings: ParseWarning[];
} {
  const lines = description.split(/\r?\n/);
  const sections: RawSection[] = [];
  const warnings: ParseWarning[] = [];
  let topicInline: string | undefined;
  let current: RawSection | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect Topic: <inline value> on a single line.
    if (current === null && /^Topic:\s+\S/.test(trimmed)) {
      const value = trimmed.slice("Topic:".length).trim();
      topicInline = value;
      continue;
    }

    // Header detection: line is exactly a label (with optional trailing ws).
    let matched: (typeof SECTION_LABELS)[number] | null = null;
    for (const label of SECTION_LABELS) {
      if (trimmed === label) {
        matched = label;
        break;
      }
    }
    if (matched) {
      current = { label: matched, bodyLines: [], startLine: i + 1 };
      sections.push(current);
      continue;
    }

    if (current) {
      current.bodyLines.push(line);
    } else if (trimmed.length > 0) {
      // Free-floating text before any section header — treat as part
      // of the explicit Description: section if no Topic: also present
      // before. Push into a synthetic Description section.
      const synth: RawSection = {
        label: "Description:",
        bodyLines: [line],
        startLine: i + 1,
      };
      sections.push(synth);
      current = synth;
    }
  }

  return { sections, topicInline, warnings };
}

const FIELD_LINE_RE = /^([A-Za-z]+):\s*(.+)$/;

function parseLinkedOpportunityBlock(bodyLines: string[]): ParsedOpportunity {
  const opp: ParsedOpportunity = {};
  for (const raw of bodyLines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const m = FIELD_LINE_RE.exec(trimmed);
    if (!m) continue;
    const [, field, value] = m;
    switch (field.toLowerCase()) {
      case "name":
        opp.name = value.trim();
        break;
      case "status":
        opp.status = value.trim();
        break;
      case "probability": {
        const num = parseInt(value.replace(/%/g, "").trim(), 10);
        if (!Number.isNaN(num) && num >= 0 && num <= 100) {
          opp.probability = num;
        }
        break;
      }
      case "amount": {
        const num = parseFloat(value.replace(/[$,]/g, "").trim());
        if (!Number.isNaN(num)) opp.amount = num;
        break;
      }
      case "owner":
        opp.ownerName = value.trim();
        break;
      case "description":
        opp.description = value.trim();
        break;
      // Anything else — silently dropped; the field is unrecognized.
    }
  }
  return opp;
}

/**
 * Run smart-detect on a Description value. Returns a structured split
 * suitable for the import pipeline to merge into lead.subject /
 * lead.description / activities[] / opportunities[].
 *
 * Warnings include parse-level issues (unknown timezones, truncations)
 * and structural anomalies. The caller surfaces these in the preview.
 */
export function detectD365(description: string | null | undefined): DetectedSections {
  const warnings: ParseWarning[] = [];
  const result: DetectedSections = {
    activities: [],
    opportunities: [],
    warnings,
  };
  if (!description) return result;
  if (!isD365Shape(description)) {
    // Caller can decide whether to set lead.description = description
    // wholesale or skip. Return empty detected sections.
    return result;
  }

  const split = splitSections(description);
  warnings.push(...split.warnings);

  if (split.topicInline) {
    result.topic = split.topicInline;
  }

  for (const section of split.sections) {
    const body = section.bodyLines.join("\n").trim();
    switch (section.label) {
      case "Topic:": {
        // Multi-line Topic — take the joined body.
        if (body.length > 0) result.topic = body;
        break;
      }
      case "Description:": {
        result.description = body;
        break;
      }
      case "Phone Calls:": {
        const r = parseActivityColumn(body, "call");
        result.activities.push(...r.activities);
        warnings.push(...r.warnings);
        break;
      }
      case "Notes:": {
        const r = parseActivityColumn(body, "note");
        result.activities.push(...r.activities);
        warnings.push(...r.warnings);
        break;
      }
      case "Appointments:":
      case "Meetings:": {
        const r = parseActivityColumn(body, "meeting");
        result.activities.push(...r.activities);
        warnings.push(...r.warnings);
        break;
      }
      case "Emails:": {
        const r = parseActivityColumn(body, "email");
        result.activities.push(...r.activities);
        warnings.push(...r.warnings);
        break;
      }
      case "Linked Opportunity:": {
        const opp = parseLinkedOpportunityBlock(section.bodyLines);
        if (opp.name || opp.status || opp.amount !== undefined) {
          result.opportunities.push(opp);
        } else {
          warnings.push({
            message: `Linked Opportunity block at line ${section.startLine} had no recognizable fields.`,
            line: section.startLine,
          });
        }
        break;
      }
    }
  }

  return result;
}
