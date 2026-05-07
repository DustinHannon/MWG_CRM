import "server-only";
import { logger } from "@/lib/logger";
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

/**
 * The filters arrive from URL query strings (and from saved-view JSON).
 * URL forms always serialise empty <select> values as `key=` — an empty
 * string. zod's z.enum REJECTS empty strings (they're not in the enum),
 * which is the root cause of the "Apply button throws" bug from Phase 2A.
 *
 * Fix: pre-process the raw input via `sanitizeFilterInput` below so empty
 * strings collapse to undefined BEFORE the schema parse. This applies to
 * the URL submit path (the Apply button) and to any future programmatic
 * caller, so the schema itself stays strict.
 */
const emptyToUndef = <T extends z.ZodTypeAny>(s: T) =>
  z.preprocess((v) => (v === "" || v === null ? undefined : v), s);

export const leadFiltersSchema = z.object({
  q: emptyToUndef(z.string().trim().max(200)).optional(),
  status: emptyToUndef(z.enum(LEAD_STATUSES)).optional(),
  rating: emptyToUndef(z.enum(LEAD_RATINGS)).optional(),
  source: emptyToUndef(z.enum(LEAD_SOURCES)).optional(),
  ownerId: emptyToUndef(z.string().uuid()).optional(),
  tag: emptyToUndef(z.string().trim().max(80)).optional(),
  page: emptyToUndef(z.coerce.number().int().min(1)).default(1),
  pageSize: emptyToUndef(z.coerce.number().int().min(10).max(200)).default(50),
  sort: emptyToUndef(
    z.enum(["lastActivity", "created", "name", "company", "value"]),
  ).default("lastActivity"),
  dir: emptyToUndef(z.enum(["asc", "desc"])).default("desc"),
});

export type LeadFilters = z.infer<typeof leadFiltersSchema>;

/**
 * Belt + suspenders: reject any payload where do_not_contact=true but
 * do_not_email=false or do_not_call=false. The lead-form UX auto-checks
 * + disables those when DNC is on, but a forged form / API caller could
 * skip that — this refinement closes that gap server-side.
 */
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

const dncRefinement = (data: {
  doNotContact?: boolean;
  doNotEmail?: boolean;
  doNotCall?: boolean;
}) => {
  if (!data.doNotContact) return true;
  return data.doNotEmail !== false && data.doNotCall !== false;
};

export const leadCreateSchema = leadCreateSchemaBase.refine(dncRefinement, {
  message:
    "Do Not Contact implies Do Not Email and Do Not Call — both must be true.",
  path: ["doNotContact"],
});

/**
 * Partial-update schema. Built off the unrefined base because z.refine()
 * turns a ZodObject into ZodEffects, which doesn't have .partial(). Re-
 * apply the DNC refinement after .partial().
 */
export const leadUpdateSchema = leadCreateSchemaBase
  .partial()
  .extend({ id: z.string().uuid() })
  .refine(dncRefinement, {
    message:
      "Do Not Contact implies Do Not Email and Do Not Call — both must be true.",
    path: ["doNotContact"],
  });

/** For server-action callers that need a partial without the id field. */
export const leadPartialSchema = leadCreateSchemaBase.partial().refine(
  dncRefinement,
  {
    message:
      "Do Not Contact implies Do Not Email and Do Not Call — both must be true.",
    path: ["doNotContact"],
  },
);

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
  // safeParse + log on failure: an unknown filter shape should NOT throw
  // and crash the page. Bad filters produce an empty result set + warning.
  const parsed = leadFiltersSchema.safeParse(rawFilters ?? {});
  if (!parsed.success) {
    logger.warn("leads.invalid_filters", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }
  const filters = parsed.success
    ? parsed.data
    : leadFiltersSchema.parse({});

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
  // Non-admin without canViewAllRecords sees only their own.
  if (!user.isAdmin && !canViewAll) {
    wheres.push(eq(leads.ownerId, user.id));
  }

  // Phase 4G — default queries hide archived rows.
  wheres.push(eq(leads.isDeleted, false));

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
      // Phase 5B — `last_activity_at` left NULL on creation so scoring
      // recency rules don't treat just-imported / just-created leads as
      // engaged. It bumps when the first counting activity (note / call /
      // email / meeting / task) is logged.
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

/**
 * Hard-delete a batch of lead ids. Cascades through activities, tasks,
 * lead_tags, attachments. Use only from admin flows or the purge cron;
 * regular users archive via `archiveLeadsById()`.
 *
 * @actor admin or purge cron only
 */
export async function deleteLeadsById(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(leads).where(inArray(leads.id, ids));
}

/**
 * Phase 4G — soft delete (archive). Sets `is_deleted=true` and the
 * deletion-attribution columns. Reversible via `restoreLeadsById()`.
 *
 * @actor lead owner or admin
 */
export async function archiveLeadsById(
  ids: string[],
  actorId: string,
  reason?: string,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(leads)
    .set({
      isDeleted: true,
      deletedAt: sql`now()`,
      deletedById: actorId,
      deleteReason: reason ?? null,
      updatedAt: sql`now()`,
    })
    .where(inArray(leads.id, ids));
}

/**
 * Phase 4G — restore archived leads. Returns row count for logging.
 *
 * @actor admin only
 */
export async function restoreLeadsById(
  ids: string[],
  actorId: string,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(leads)
    .set({
      isDeleted: false,
      deletedAt: null,
      deletedById: null,
      deleteReason: null,
      updatedAt: sql`now()`,
      updatedById: actorId,
    })
    .where(inArray(leads.id, ids));
}
