import "server-only";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { users } from "@/db/schema/users";
import type { SessionUser } from "@/lib/auth-helpers";
import {
  LEAD_RATINGS,
  LEAD_SOURCES,
  LEAD_STATUSES,
} from "@/lib/lead-constants";

export { LEAD_RATINGS, LEAD_SOURCES, LEAD_STATUSES };

export const leadFiltersSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  rating: z.enum(LEAD_RATINGS).optional(),
  source: z.enum(LEAD_SOURCES).optional(),
  ownerId: z.string().uuid().optional(),
  tag: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
  sort: z
    .enum([
      "lastActivity",
      "created",
      "name",
      "company",
      "value",
    ])
    .default("lastActivity"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});

export type LeadFilters = z.infer<typeof leadFiltersSchema>;

const leadCreateSchemaBase = z.object({
  salutation: z.string().max(20).optional().nullable(),
  firstName: z.string().trim().min(1, "First name required").max(120),
  lastName: z.string().trim().min(1, "Last name required").max(120),
  jobTitle: z.string().max(200).optional().nullable(),
  companyName: z.string().max(200).optional().nullable(),
  industry: z.string().max(100).optional().nullable(),
  email: z.string().email().or(z.literal("")).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  mobilePhone: z.string().max(40).optional().nullable(),
  website: z.string().url().or(z.literal("")).optional().nullable(),
  linkedinUrl: z.string().url().or(z.literal("")).optional().nullable(),
  street1: z.string().max(200).optional().nullable(),
  street2: z.string().max(200).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  state: z.string().max(100).optional().nullable(),
  postalCode: z.string().max(20).optional().nullable(),
  country: z.string().max(100).optional().nullable(),
  description: z.string().max(20_000).optional().nullable(),
  status: z.enum(LEAD_STATUSES).default("new"),
  rating: z.enum(LEAD_RATINGS).default("warm"),
  source: z.enum(LEAD_SOURCES).default("other"),
  estimatedValue: z
    .union([z.string(), z.number()])
    .optional()
    .nullable()
    .transform((v) => {
      if (v === null || v === undefined || v === "") return null;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n.toFixed(2) : null;
    }),
  estimatedCloseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
  doNotContact: z.boolean().default(false),
  doNotEmail: z.boolean().default(false),
  doNotCall: z.boolean().default(false),
  tags: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (!v) return null;
      const arr = Array.isArray(v)
        ? v
        : v.split(",").map((s) => s.trim()).filter(Boolean);
      return arr.length === 0 ? null : arr;
    }),
  ownerId: z.string().uuid().optional().nullable(),
});

export const leadCreateSchema = leadCreateSchemaBase;
export const leadUpdateSchema = leadCreateSchemaBase.partial().extend({
  id: z.string().uuid(),
});

export type LeadCreateInput = z.infer<typeof leadCreateSchema>;
export type LeadUpdateInput = z.infer<typeof leadUpdateSchema>;

export interface LeadListResult {
  rows: Array<{
    id: string;
    firstName: string;
    lastName: string;
    companyName: string | null;
    email: string | null;
    phone: string | null;
    status: (typeof LEAD_STATUSES)[number];
    rating: (typeof LEAD_RATINGS)[number];
    source: (typeof LEAD_SOURCES)[number];
    ownerId: string | null;
    ownerDisplayName: string | null;
    estimatedValue: string | null;
    lastActivityAt: Date | null;
    createdAt: Date;
    tags: string[] | null;
  }>;
  total: number;
  page: number;
  pageSize: number;
}

export async function listLeads(
  user: SessionUser,
  rawFilters: unknown,
  canViewAll: boolean,
): Promise<LeadListResult> {
  const filters = leadFiltersSchema.parse(rawFilters ?? {});

  const wheres = [];
  if (filters.q) {
    const pattern = `%${filters.q}%`;
    wheres.push(
      or(
        ilike(leads.firstName, pattern),
        ilike(leads.lastName, pattern),
        ilike(leads.email, pattern),
        ilike(leads.companyName, pattern),
        ilike(leads.phone, pattern),
      ),
    );
  }
  if (filters.status) wheres.push(eq(leads.status, filters.status));
  if (filters.rating) wheres.push(eq(leads.rating, filters.rating));
  if (filters.source) wheres.push(eq(leads.source, filters.source));
  if (filters.ownerId) wheres.push(eq(leads.ownerId, filters.ownerId));
  if (filters.tag) {
    wheres.push(sql`${leads.tags} && ARRAY[${filters.tag}]::text[]`);
  }
  // Non-admin without canViewAllLeads sees only their own.
  if (!user.isAdmin && !canViewAll) {
    wheres.push(eq(leads.ownerId, user.id));
  }

  const whereExpr = wheres.length > 0 ? and(...wheres) : undefined;

  const sortColumn = (() => {
    switch (filters.sort) {
      case "name":
        return leads.lastName;
      case "company":
        return leads.companyName;
      case "value":
        return leads.estimatedValue;
      case "created":
        return leads.createdAt;
      default:
        return leads.lastActivityAt;
    }
  })();
  const order = filters.dir === "asc" ? asc(sortColumn) : desc(sortColumn);

  const offset = (filters.page - 1) * filters.pageSize;

  const [rows, totalRow] = await Promise.all([
    db
      .select({
        id: leads.id,
        firstName: leads.firstName,
        lastName: leads.lastName,
        companyName: leads.companyName,
        email: leads.email,
        phone: leads.phone,
        status: leads.status,
        rating: leads.rating,
        source: leads.source,
        ownerId: leads.ownerId,
        ownerDisplayName: users.displayName,
        estimatedValue: leads.estimatedValue,
        lastActivityAt: leads.lastActivityAt,
        createdAt: leads.createdAt,
        tags: leads.tags,
      })
      .from(leads)
      .leftJoin(users, eq(leads.ownerId, users.id))
      .where(whereExpr)
      .orderBy(order, desc(leads.createdAt))
      .limit(filters.pageSize)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(leads)
      .where(whereExpr),
  ]);

  return {
    rows,
    total: totalRow[0]?.count ?? 0,
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

export async function getLeadById(
  user: SessionUser,
  id: string,
  canViewAll: boolean,
) {
  const wheres = [eq(leads.id, id)];
  if (!user.isAdmin && !canViewAll) {
    wheres.push(eq(leads.ownerId, user.id));
  }
  const row = await db
    .select()
    .from(leads)
    .where(and(...wheres))
    .limit(1);
  return row[0] ?? null;
}

export async function createLead(
  user: SessionUser,
  input: LeadCreateInput,
): Promise<{ id: string }> {
  const ownerId = input.ownerId ?? user.id;
  const inserted = await db
    .insert(leads)
    .values({
      ownerId,
      status: input.status,
      rating: input.rating,
      source: input.source,
      salutation: input.salutation ?? null,
      firstName: input.firstName,
      lastName: input.lastName,
      jobTitle: input.jobTitle ?? null,
      companyName: input.companyName ?? null,
      industry: input.industry ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      mobilePhone: input.mobilePhone ?? null,
      website: input.website ?? null,
      linkedinUrl: input.linkedinUrl ?? null,
      street1: input.street1 ?? null,
      street2: input.street2 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      postalCode: input.postalCode ?? null,
      country: input.country ?? null,
      description: input.description ?? null,
      doNotContact: input.doNotContact,
      doNotEmail: input.doNotEmail,
      doNotCall: input.doNotCall,
      estimatedValue: input.estimatedValue,
      estimatedCloseDate: input.estimatedCloseDate ?? null,
      tags: input.tags ?? null,
      createdById: user.id,
      updatedById: user.id,
      lastActivityAt: sql`now()`,
    })
    .returning({ id: leads.id });
  return { id: inserted[0].id };
}

export async function updateLead(
  user: SessionUser,
  id: string,
  input: Partial<LeadCreateInput>,
): Promise<void> {
  const update: Record<string, unknown> = {
    updatedById: user.id,
    updatedAt: sql`now()`,
  };
  for (const key of Object.keys(input) as Array<keyof LeadCreateInput>) {
    update[key] = input[key];
  }
  await db.update(leads).set(update).where(eq(leads.id, id));
}

export async function deleteLeadsById(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(leads).where(inArray(leads.id, ids));
}
