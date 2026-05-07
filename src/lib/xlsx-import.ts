import "server-only";
import { eq, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { z } from "zod";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { users } from "@/db/schema/users";
import {
  LEAD_RATINGS,
  LEAD_SOURCES,
  LEAD_STATUSES,
  type LeadRating,
  type LeadSource,
  type LeadStatus,
} from "@/lib/lead-constants";

interface RawRow {
  rowNumber: number;
  data: Record<string, string>;
}

export interface ImportError {
  row: number;
  field: string;
  message: string;
}

export interface ImportResult {
  totalRows: number;
  successful: number;
  failed: number;
  needsReview: number;
  inserted: string[]; // lead IDs
  updated: string[];
  errors: ImportError[];
  needsReviewRows: Array<{ row: number; reason: string; existingLeadId: string }>;
}

const HEADER_MAP: Record<string, string> = {
  "First Name*": "firstName",
  "First Name": "firstName",
  "Last Name*": "lastName",
  "Last Name": "lastName",
  Email: "email",
  Phone: "phone",
  "Mobile Phone": "mobilePhone",
  "Job Title": "jobTitle",
  Company: "companyName",
  Industry: "industry",
  Website: "website",
  "LinkedIn URL": "linkedinUrl",
  "Street 1": "street1",
  "Street 2": "street2",
  City: "city",
  State: "state",
  "Postal Code": "postalCode",
  Country: "country",
  Status: "status",
  Rating: "rating",
  Source: "source",
  "Estimated Value": "estimatedValue",
  "Estimated Close Date": "estimatedCloseDate",
  Description: "description",
  Tags: "tags",
  "Do Not Contact": "doNotContact",
  "Do Not Email": "doNotEmail",
  "Do Not Call": "doNotCall",
  "Owner Email": "ownerEmail",
  "External ID": "externalId",
};

function parseBool(s: string | undefined): boolean {
  if (!s) return false;
  const v = s.toLowerCase().trim();
  return v === "true" || v === "yes" || v === "y" || v === "1";
}

const importRowSchema = z.object({
  firstName: z.string().trim().min(1, "First name required").max(120),
  lastName: z.string().trim().min(1, "Last name required").max(120),
  email: z.string().trim().email().or(z.literal("")).optional(),
  phone: z.string().trim().max(40).optional(),
  mobilePhone: z.string().trim().max(40).optional(),
  jobTitle: z.string().trim().max(200).optional(),
  companyName: z.string().trim().max(200).optional(),
  industry: z.string().trim().max(100).optional(),
  website: z.string().trim().url().or(z.literal("")).optional(),
  linkedinUrl: z.string().trim().url().or(z.literal("")).optional(),
  street1: z.string().trim().max(200).optional(),
  street2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(20).optional(),
  country: z.string().trim().max(100).optional(),
  status: z.enum(LEAD_STATUSES).default("new"),
  rating: z.enum(LEAD_RATINGS).default("warm"),
  source: z.enum(LEAD_SOURCES).default("import"),
  estimatedValue: z.string().trim().optional(),
  estimatedCloseDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/u, "Use YYYY-MM-DD")
    .or(z.literal(""))
    .optional(),
  description: z.string().trim().max(20_000).optional(),
  tags: z.string().trim().optional(),
  doNotContact: z.boolean().default(false),
  doNotEmail: z.boolean().default(false),
  doNotCall: z.boolean().default(false),
  ownerEmail: z.string().trim().email().or(z.literal("")).optional(),
  externalId: z.string().trim().max(120).optional(),
});

export async function importLeadsFromBuffer(
  buf: ArrayBuffer | Buffer,
  importerUserId: string,
  importJobId?: string,
): Promise<ImportResult> {
  const wb = XLSX.read(buf, { type: "array" });
  const sheetName =
    wb.SheetNames.find((n) => n.toLowerCase() === "leads") ?? wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) {
    return {
      totalRows: 0,
      successful: 0,
      failed: 0,
      needsReview: 0,
      inserted: [],
      updated: [],
      errors: [{ row: 0, field: "_sheet", message: `Missing sheet: ${sheetName}` }],
      needsReviewRows: [],
    };
  }

  const rows: Record<string, string>[] = XLSX.utils.sheet_to_json(sheet, {
    raw: false,
    defval: "",
  });

  // Header mapping: normalise to internal field names.
  const raw: RawRow[] = rows.map((r, i) => {
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) {
      const mapped = HEADER_MAP[k] ?? k;
      data[mapped] = String(v ?? "").trim();
    }
    return { rowNumber: i + 2, data }; // row 1 is header
  });

  // Resolve owner emails -> userIds in one query.
  const ownerEmails = Array.from(
    new Set(
      raw
        .map((r) => r.data.ownerEmail?.toLowerCase())
        .filter((e): e is string => Boolean(e) && e.length > 0),
    ),
  );
  const ownerMap = new Map<string, string>();
  if (ownerEmails.length > 0) {
    const uRows = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(sql`${users.email} IN (${sql.join(
        ownerEmails.map((e) => sql`${e}`),
        sql`, `,
      )})`);
    for (const u of uRows) {
      ownerMap.set(u.email.toLowerCase(), u.id);
    }
  }

  const errors: ImportError[] = [];
  const inserted: string[] = [];
  const updated: string[] = [];
  const needsReview: ImportResult["needsReviewRows"] = [];
  // Used to mark inserted rows so they're discoverable on the lead detail
  // page and via the "Recently Imported" built-in view.
  const importJobIdForRows = importJobId ?? null;

  // Single-row processing keeps the surface simple. For very large imports
  // (>5k rows) we'd want chunked transactions; v1 caps at 10MB upload which
  // is well within reach.
  for (const r of raw) {
    const parsed = importRowSchema.safeParse({
      firstName: r.data.firstName,
      lastName: r.data.lastName,
      email: r.data.email,
      phone: r.data.phone,
      mobilePhone: r.data.mobilePhone,
      jobTitle: r.data.jobTitle,
      companyName: r.data.companyName,
      industry: r.data.industry,
      website: r.data.website,
      linkedinUrl: r.data.linkedinUrl,
      street1: r.data.street1,
      street2: r.data.street2,
      city: r.data.city,
      state: r.data.state,
      postalCode: r.data.postalCode,
      country: r.data.country,
      status: r.data.status?.toLowerCase() || "new",
      rating: r.data.rating?.toLowerCase() || "warm",
      source: r.data.source?.toLowerCase() || "import",
      estimatedValue: r.data.estimatedValue,
      estimatedCloseDate: r.data.estimatedCloseDate,
      description: r.data.description,
      tags: r.data.tags,
      doNotContact: parseBool(r.data.doNotContact),
      doNotEmail: parseBool(r.data.doNotEmail),
      doNotCall: parseBool(r.data.doNotCall),
      ownerEmail: r.data.ownerEmail,
      externalId: r.data.externalId,
    });

    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push({
          row: r.rowNumber,
          field: String(issue.path[0] ?? ""),
          message: issue.message,
        });
      }
      continue;
    }

    const d = parsed.data;
    const tags = d.tags
      ? d.tags.split(",").map((s) => s.trim()).filter(Boolean)
      : null;
    const estimatedValue =
      d.estimatedValue && d.estimatedValue.length > 0
        ? Number(d.estimatedValue)
        : null;
    if (d.estimatedValue && Number.isNaN(estimatedValue)) {
      errors.push({
        row: r.rowNumber,
        field: "estimatedValue",
        message: "Not a valid number",
      });
      continue;
    }

    const ownerId =
      (d.ownerEmail && ownerMap.get(d.ownerEmail.toLowerCase())) ?? importerUserId;

    // Upsert by external_id; if external_id matches, UPDATE.
    if (d.externalId) {
      const existing = await db
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.externalId, d.externalId))
        .limit(1);
      if (existing[0]) {
        await db
          .update(leads)
          .set({
            firstName: d.firstName,
            lastName: d.lastName,
            email: d.email || null,
            phone: d.phone || null,
            mobilePhone: d.mobilePhone || null,
            jobTitle: d.jobTitle || null,
            companyName: d.companyName || null,
            industry: d.industry || null,
            website: d.website || null,
            linkedinUrl: d.linkedinUrl || null,
            street1: d.street1 || null,
            street2: d.street2 || null,
            city: d.city || null,
            state: d.state || null,
            postalCode: d.postalCode || null,
            country: d.country || null,
            status: d.status as LeadStatus,
            rating: d.rating as LeadRating,
            source: d.source as LeadSource,
            estimatedValue: estimatedValue !== null ? estimatedValue.toFixed(2) : null,
            estimatedCloseDate: d.estimatedCloseDate || null,
            description: d.description || null,
            tags,
            doNotContact: d.doNotContact,
            doNotEmail: d.doNotEmail,
            doNotCall: d.doNotCall,
            updatedById: importerUserId,
            updatedAt: sql`now()`,
          })
          .where(eq(leads.id, existing[0].id));
        updated.push(existing[0].id);
        continue;
      }
    }

    // Email-match dedup: flag for review (don't auto-merge).
    if (d.email) {
      const dup = await db
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.email, d.email))
        .limit(1);
      if (dup[0]) {
        needsReview.push({
          row: r.rowNumber,
          reason: "Email matches an existing lead",
          existingLeadId: dup[0].id,
        });
        continue;
      }
    }

    const insertedRow = await db
      .insert(leads)
      .values({
        ownerId,
        status: d.status as LeadStatus,
        rating: d.rating as LeadRating,
        source: d.source as LeadSource,
        firstName: d.firstName,
        lastName: d.lastName,
        email: d.email || null,
        phone: d.phone || null,
        mobilePhone: d.mobilePhone || null,
        jobTitle: d.jobTitle || null,
        companyName: d.companyName || null,
        industry: d.industry || null,
        website: d.website || null,
        linkedinUrl: d.linkedinUrl || null,
        street1: d.street1 || null,
        street2: d.street2 || null,
        city: d.city || null,
        state: d.state || null,
        postalCode: d.postalCode || null,
        country: d.country || null,
        estimatedValue: estimatedValue !== null ? estimatedValue.toFixed(2) : null,
        estimatedCloseDate: d.estimatedCloseDate || null,
        description: d.description || null,
        tags,
        externalId: d.externalId || null,
        doNotContact: d.doNotContact,
        doNotEmail: d.doNotEmail,
        doNotCall: d.doNotCall,
        createdById: importerUserId,
        updatedById: importerUserId,
        // Phase 5B — `last_activity_at` left NULL on import. Imports do
        // NOT count as engagement signal; the column populates only when
        // a real counting activity is logged.
        // Provenance — Phase 2D.
        createdVia: "imported",
        importJobId: importJobIdForRows,
      })
      .returning({ id: leads.id });
    inserted.push(insertedRow[0].id);
  }

  return {
    totalRows: raw.length,
    successful: inserted.length + updated.length,
    failed: errors.length,
    needsReview: needsReview.length,
    inserted,
    updated,
    errors,
    needsReviewRows: needsReview,
  };
}

export function buildErrorReport(errors: ImportError[]): Uint8Array {
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Row", "Field", "Error"],
    ...errors.map((e) => [String(e.row), e.field, e.message]),
  ]);
  sheet["!cols"] = [{ wch: 8 }, { wch: 24 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, sheet, "Errors");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Uint8Array(buf);
}

export function buildLeadsExport(rows: Array<Record<string, unknown>>): Uint8Array {
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, sheet, "Leads");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Uint8Array(buf);
}
