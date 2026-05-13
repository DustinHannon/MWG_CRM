// aggregator that turns a ParseResult[] into a
// preview shape suitable for display + the commit step. The preview
// is the bridge between workbook parsing and the actual writes:
// owner email resolution, by-name resolution, and external-id
// matching are done here so the user can see counts before committing.

import "server-only";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { tags } from "@/db/schema/tags";
import { and, eq, inArray, sql } from "drizzle-orm";
import { tagName } from "@/lib/validation/primitives";
import {
  resolveByNames,
  resolveOwnerEmails,
} from "./resolve-users";
import type { ParseResult, ParsedRow } from "./parse-row";

export interface ImportPreview {
  totalRows: number;
  newLeadCount: number;
  updatedLeadCount: number;
  skippedRowCount: number;

  subjectsToSet: number;
  callActivitiesToCreate: number;
  meetingActivitiesToCreate: number;
  noteActivitiesToCreate: number;
  emailActivitiesToCreate: number;

  opportunitiesToCreate: number;

  // Distinct valid tag names referenced across all OK rows.
  distinctTagCount: number;
  // Subset of distinctTagCount that does NOT yet exist in the tags
  // table (case-insensitive). These will be created on commit with a
  // rotated palette colour.
  newTagCount: number;

  smartDetectEnabled: boolean;

  warnings: PreviewWarning[];
  errors: PreviewError[];
}

export interface PreviewWarning {
  group: "owners" | "by-names" | "status" | "stage" | "row-warning" | "headers";
  message: string;
  rows: number[];
}

export interface PreviewError {
  rowNumber: number;
  errors: string[];
}

interface BuildPreviewArgs {
  parseRows: ParseResult[];
  smartDetect: boolean;
  unknownHeaders: string[];
  missingRequiredHeaders: string[];
}

export async function buildImportPreview({
  parseRows,
  smartDetect,
  unknownHeaders,
  missingRequiredHeaders,
}: BuildPreviewArgs): Promise<ImportPreview> {
  const errors: PreviewError[] = [];
  const okRows: ParsedRow[] = [];
  for (const r of parseRows) {
    if (r.ok) okRows.push(r);
    else errors.push({ rowNumber: r.rowNumber, errors: r.errors });
  }

  const warningGroups = new Map<string, PreviewWarning>();
  function pushWarning(
    group: PreviewWarning["group"],
    message: string,
    rowNumber: number | null,
  ) {
    const key = `${group}:${message}`;
    let entry = warningGroups.get(key);
    if (!entry) {
      entry = { group, message, rows: [] };
      warningGroups.set(key, entry);
    }
    if (rowNumber !== null && !entry.rows.includes(rowNumber)) {
      entry.rows.push(rowNumber);
    }
  }

  // Aggregate per-row warnings.
  for (const r of okRows) {
    for (const w of r.warnings) {
      pushWarning("row-warning", w, r.rowNumber);
    }
  }

  // Owner-email resolution: which emails from the file resolve, which
  // don't.
  const ownerEmails = new Set<string>();
  for (const r of okRows) {
    if (r.ownerEmailLower) ownerEmails.add(r.ownerEmailLower);
    for (const o of r.opportunities) {
      if (o.ownerEmail) ownerEmails.add(o.ownerEmail);
    }
  }
  const ownerMap = await resolveOwnerEmails(ownerEmails);
  for (const r of okRows) {
    if (r.ownerEmailLower && !ownerMap.has(r.ownerEmailLower)) {
      pushWarning(
        "owners",
        `Owner email not found: ${r.ownerEmailLower}`,
        r.rowNumber,
      );
    }
    for (const o of r.opportunities) {
      if (o.ownerEmail && !ownerMap.has(o.ownerEmail)) {
        pushWarning(
          "owners",
          `Opportunity owner email not found: ${o.ownerEmail}`,
          r.rowNumber,
        );
      }
    }
  }

  // By-name resolution.
  const byNames = new Set<string>();
  for (const r of okRows) {
    for (const a of r.activities) {
      if (a.metadata.byName) byNames.add(a.metadata.byName);
    }
  }
  const byNameMap = await resolveByNames(byNames);
  // Aggregate counts of unresolved by-names.
  const unresolvedByNameRows = new Map<string, number[]>();
  for (const r of okRows) {
    for (const a of r.activities) {
      if (!a.metadata.byName) continue;
      const norm = a.metadata.byName.trim().replace(/\s+/g, " ").toLowerCase();
      if (!byNameMap.has(norm)) {
        const list = unresolvedByNameRows.get(a.metadata.byName) ?? [];
        list.push(r.rowNumber);
        unresolvedByNameRows.set(a.metadata.byName, list);
      }
    }
  }
  for (const [name, rows] of unresolvedByNameRows) {
    pushWarning(
      "by-names",
      `Activity owner "${name}" not found in CRM (${rows.length} ${rows.length === 1 ? "activity" : "activities"}) — will store as imported_by_name`,
      null,
    );
    // Attach all rowNumbers anyway so users can drill in.
    const entry = warningGroups.get(`by-names:${`Activity owner "${name}" not found in CRM (${rows.length} ${rows.length === 1 ? "activity" : "activities"}) — will store as imported_by_name`}`);
    if (entry) entry.rows = rows;
  }

  // External-id match for new vs update counts.
  const externalIds = okRows
    .map((r) => r.leadPatch.externalId)
    .filter((v): v is string => Boolean(v));
  const matchedExt = new Set<string>();
  if (externalIds.length > 0) {
    const existing = await db
      .select({ externalId: leads.externalId })
      .from(leads)
      .where(
        and(inArray(leads.externalId, externalIds), eq(leads.isDeleted, false)),
      );
    for (const e of existing) {
      if (e.externalId) matchedExt.add(e.externalId);
    }
  }

  let newLeadCount = 0;
  let updatedLeadCount = 0;
  let subjectsToSet = 0;
  let callActivitiesToCreate = 0;
  let meetingActivitiesToCreate = 0;
  let noteActivitiesToCreate = 0;
  let emailActivitiesToCreate = 0;
  let opportunitiesToCreate = 0;

  for (const r of okRows) {
    if (r.leadPatch.externalId && matchedExt.has(r.leadPatch.externalId)) {
      updatedLeadCount += 1;
    } else {
      newLeadCount += 1;
    }
    if (r.leadPatch.subject) subjectsToSet += 1;
    for (const a of r.activities) {
      switch (a.kind) {
        case "call":
          callActivitiesToCreate += 1;
          break;
        case "meeting":
          meetingActivitiesToCreate += 1;
          break;
        case "note":
          noteActivitiesToCreate += 1;
          break;
        case "email":
          emailActivitiesToCreate += 1;
          break;
      }
    }
    opportunitiesToCreate += r.opportunities.length;
  }

  // Tag preview — collect every valid distinct tag name and figure
  // out how many would be newly created on commit. Mirrors the same
  // primitive-validation gate used in `commit.ts` so the preview's
  // counts match the commit's actual writes.
  //
  // Distinctness is case-INSENSITIVE so "Hot, hot, HOT" registers as
  // ONE distinct tag (commit creates only one). A case-sensitive Set
  // would overstate both counts by treating each variant separately.
  const distinctTagNamesLower = new Set<string>();
  for (const r of okRows) {
    if (!r.leadPatch.tags) continue;
    for (const t of r.leadPatch.tags.split(",")) {
      const trimmed = t.trim();
      if (trimmed.length === 0) continue;
      const parsed = tagName.safeParse(trimmed);
      if (!parsed.success) continue;
      distinctTagNamesLower.add(parsed.data.toLowerCase());
    }
  }
  let newTagCount = 0;
  if (distinctTagNamesLower.size > 0) {
    const lowered = Array.from(distinctTagNamesLower);
    const existing = await db
      .select({ name: tags.name })
      .from(tags)
      .where(
        sql`lower(${tags.name}) IN (${sql.join(
          lowered.map((n) => sql`${n}`),
          sql`, `,
        )})`,
      );
    const existingLowered = new Set(existing.map((e) => e.name.toLowerCase()));
    for (const n of distinctTagNamesLower) {
      if (!existingLowered.has(n)) newTagCount += 1;
    }
  }

  // Header-level warnings.
  if (unknownHeaders.length > 0) {
    pushWarning(
      "headers",
      `Unrecognized headers ignored: ${unknownHeaders.join(", ")}`,
      null,
    );
  }
  if (missingRequiredHeaders.length > 0) {
    pushWarning(
      "headers",
      `Required headers missing: ${missingRequiredHeaders.join(", ")}`,
      null,
    );
  }

  return {
    totalRows: okRows.length + errors.length,
    newLeadCount,
    updatedLeadCount,
    skippedRowCount: errors.length,
    subjectsToSet,
    callActivitiesToCreate,
    meetingActivitiesToCreate,
    noteActivitiesToCreate,
    emailActivitiesToCreate,
    opportunitiesToCreate,
    distinctTagCount: distinctTagNamesLower.size,
    newTagCount,
    smartDetectEnabled: smartDetect,
    warnings: Array.from(warningGroups.values()),
    errors,
  };
}
