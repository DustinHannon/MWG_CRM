import "server-only";

/**
 * DB row -> JSON serializers for /api/v1.
 *
 * The DB layer uses camelCase Drizzle keys; the public API contract is
 * snake_case (consistent with most external integrators). These helpers
 * convert between them and ISO-format every Date.
 *
 * Each helper accepts a permissive `Record<string, unknown>` to keep
 * the route layer terse — Drizzle's row types vary per query shape.
 */

function iso(d: Date | null | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  return new Date(d as unknown as string).toISOString();
}

export function serializeLead(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    salutation: (row.salutation ?? null) as string | null,
    first_name: (row.firstName ?? null) as string | null,
    last_name: (row.lastName ?? null) as string | null,
    company_name: (row.companyName ?? null) as string | null,
    email: (row.email ?? null) as string | null,
    phone: (row.phone ?? null) as string | null,
    mobile_phone: (row.mobilePhone ?? null) as string | null,
    job_title: (row.jobTitle ?? null) as string | null,
    industry: (row.industry ?? null) as string | null,
    website: (row.website ?? null) as string | null,
    linkedin_url: (row.linkedinUrl ?? null) as string | null,
    street1: (row.street1 ?? null) as string | null,
    street2: (row.street2 ?? null) as string | null,
    city: (row.city ?? null) as string | null,
    state: (row.state ?? null) as string | null,
    postal_code: (row.postalCode ?? null) as string | null,
    country: (row.country ?? null) as string | null,
    description: (row.description ?? null) as string | null,
    subject: (row.subject ?? null) as string | null,
    status: row.status as string,
    rating: row.rating as string,
    source: row.source as string,
    do_not_contact: (row.doNotContact ?? false) as boolean,
    do_not_email: (row.doNotEmail ?? false) as boolean,
    do_not_call: (row.doNotCall ?? false) as boolean,
    owner_id: (row.ownerId ?? null) as string | null,
    estimated_value: (row.estimatedValue ?? null) as string | null,
    estimated_close_date: (row.estimatedCloseDate ?? null) as string | null,
    last_activity_at: iso(row.lastActivityAt as Date | null),
    converted_at: iso(row.convertedAt as Date | null),
    version: (row.version ?? 1) as number,
    updated_at: iso(row.updatedAt as Date) ?? new Date(0).toISOString(),
    created_at: iso(row.createdAt as Date) ?? new Date(0).toISOString(),
    tags: (row.tags ?? null) as string[] | null,
  };
}

export function serializeAccount(row: Record<string, unknown>) {
  const out0 = {
    account_number: (row.accountNumber ?? null) as string | null,
    email: (row.email ?? null) as string | null,
    number_of_employees: (row.numberOfEmployees ?? null) as number | null,
    annual_revenue: (row.annualRevenue ?? null) as string | null,
    parent_account_id: (row.parentAccountId ?? null) as string | null,
    primary_contact_id: (row.primaryContactId ?? null) as string | null,
  };
  return Object.assign(out0, _serializeAccountBase(row));
}
function _serializeAccountBase(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    name: row.name as string,
    industry: (row.industry ?? null) as string | null,
    website: (row.website ?? null) as string | null,
    phone: (row.phone ?? null) as string | null,
    street1: (row.street1 ?? null) as string | null,
    street2: (row.street2 ?? null) as string | null,
    city: (row.city ?? null) as string | null,
    state: (row.state ?? null) as string | null,
    postal_code: (row.postalCode ?? null) as string | null,
    country: (row.country ?? null) as string | null,
    description: (row.description ?? null) as string | null,
    owner_id: (row.ownerId ?? null) as string | null,
    source_lead_id: (row.sourceLeadId ?? null) as string | null,
    version: (row.version ?? 1) as number,
    created_at: iso(row.createdAt as Date) ?? new Date(0).toISOString(),
    updated_at: iso(row.updatedAt as Date) ?? new Date(0).toISOString(),
  };
}

export function serializeContact(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    account_id: (row.accountId ?? null) as string | null,
    first_name: row.firstName as string,
    last_name: (row.lastName ?? null) as string | null,
    job_title: (row.jobTitle ?? null) as string | null,
    email: (row.email ?? null) as string | null,
    phone: (row.phone ?? null) as string | null,
    mobile_phone: (row.mobilePhone ?? null) as string | null,
    description: (row.description ?? null) as string | null,
    street1: (row.street1 ?? null) as string | null,
    street2: (row.street2 ?? null) as string | null,
    city: (row.city ?? null) as string | null,
    state: (row.state ?? null) as string | null,
    postal_code: (row.postalCode ?? null) as string | null,
    country: (row.country ?? null) as string | null,
    birthdate: (row.birthdate ?? null) as string | null,
    do_not_contact: (row.doNotContact ?? false) as boolean,
    do_not_email: (row.doNotEmail ?? false) as boolean,
    do_not_call: (row.doNotCall ?? false) as boolean,
    do_not_mail: (row.doNotMail ?? false) as boolean,
    owner_id: (row.ownerId ?? null) as string | null,
    version: (row.version ?? 1) as number,
    created_at: iso(row.createdAt as Date) ?? new Date(0).toISOString(),
    updated_at: iso(row.updatedAt as Date) ?? new Date(0).toISOString(),
  };
}

export function serializeOpportunity(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    account_id: (row.accountId ?? null) as string | null,
    primary_contact_id: (row.primaryContactId ?? null) as string | null,
    name: row.name as string,
    stage: row.stage as string,
    amount: (row.amount ?? null) as string | null,
    probability: (row.probability ?? null) as number | null,
    expected_close_date: (row.expectedCloseDate ?? null) as string | null,
    description: (row.description ?? null) as string | null,
    closed_at: iso(row.closedAt as Date | null),
    owner_id: (row.ownerId ?? null) as string | null,
    version: (row.version ?? 1) as number,
    created_at: iso(row.createdAt as Date) ?? new Date(0).toISOString(),
    updated_at: iso(row.updatedAt as Date) ?? new Date(0).toISOString(),
  };
}

export function serializeTask(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    title: row.title as string,
    description: (row.description ?? null) as string | null,
    status: row.status as string,
    priority: row.priority as string,
    due_at: iso(row.dueAt as Date | null),
    completed_at: iso(row.completedAt as Date | null),
    assigned_to_id: (row.assignedToId ?? null) as string | null,
    created_by_id: (row.createdById ?? null) as string | null,
    lead_id: (row.leadId ?? null) as string | null,
    account_id: (row.accountId ?? null) as string | null,
    contact_id: (row.contactId ?? null) as string | null,
    opportunity_id: (row.opportunityId ?? null) as string | null,
    version: (row.version ?? 1) as number,
    created_at: iso(row.createdAt as Date) ?? new Date(0).toISOString(),
    updated_at: iso(row.updatedAt as Date) ?? new Date(0).toISOString(),
  };
}

export function serializeActivity(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    lead_id: (row.leadId ?? null) as string | null,
    account_id: (row.accountId ?? null) as string | null,
    contact_id: (row.contactId ?? null) as string | null,
    opportunity_id: (row.opportunityId ?? null) as string | null,
    user_id: (row.userId ?? null) as string | null,
    kind: row.kind as string,
    direction: (row.direction ?? null) as string | null,
    subject: (row.subject ?? null) as string | null,
    body: (row.body ?? null) as string | null,
    occurred_at:
      iso(row.occurredAt as Date) ?? new Date(0).toISOString(),
    duration_minutes: (row.durationMinutes ?? null) as number | null,
    outcome: (row.outcome ?? null) as string | null,
    created_at: iso(row.createdAt as Date) ?? new Date(0).toISOString(),
    updated_at: iso(row.updatedAt as Date) ?? new Date(0).toISOString(),
  };
}

export function serializeUserSummary(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    email: row.email as string,
    display_name: row.displayName as string,
    first_name: row.firstName as string,
    last_name: (row.lastName ?? null) as string | null,
    is_admin: (row.isAdmin ?? false) as boolean,
    is_active: (row.isActive ?? false) as boolean,
    job_title: (row.jobTitle ?? null) as string | null,
    department: (row.department ?? null) as string | null,
    created_at: iso(row.createdAt as Date) ?? new Date(0).toISOString(),
  };
}
