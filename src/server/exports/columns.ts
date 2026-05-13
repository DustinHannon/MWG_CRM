/**
 * Column definitions for streaming exports of the five core CRM
 * entities. Centralised here so both the .xlsx and .csv routes
 * share a single column shape, and so the column order survives
 * future entity-schema changes via TypeScript drift checks.
 *
 * Each `key` matches a property on the entity row OR the corresponding
 * `mapRow` output. Route handlers either pass already-shaped objects
 * to `streamExcel` / `streamCsv` or supply a `mapRow` that adapts the
 * entity row to the column keys below.
 *
 * Column choice rationale: include identifying fields, key foreign-
 * key references rendered as names (consumer-friendly), the timestamps
 * needed for time-based pivoting, and the version stamp for forensic
 * correlation. Skip JSON-only fields (metadata) and access-control
 * stamps that are noise to end-users (deletedById, updatedById).
 *
 * Width values match the historic xlsx report (`marketing/reports/
 * email/export/route.ts`) conventions: 14 for short text / counts,
 * 22 for timestamps, 30+ for free-form fields.
 */

import type { ExportColumn } from "./stream-excel";

export const LEAD_COLUMNS: readonly ExportColumn[] = [
  { header: "Lead ID", key: "id", width: 38 },
  { header: "First name", key: "firstName", width: 18 },
  { header: "Last name", key: "lastName", width: 18 },
  { header: "Company", key: "companyName", width: 30 },
  { header: "Email", key: "email", width: 30 },
  { header: "Phone", key: "phone", width: 18 },
  { header: "Mobile phone", key: "mobilePhone", width: 18 },
  { header: "Status", key: "status", width: 14 },
  { header: "Rating", key: "rating", width: 12 },
  { header: "Source", key: "source", width: 16 },
  { header: "Score", key: "score", width: 10 },
  { header: "Score band", key: "scoreBand", width: 12 },
  { header: "Industry", key: "industry", width: 18 },
  { header: "Job title", key: "jobTitle", width: 22 },
  { header: "City", key: "city", width: 16 },
  { header: "State", key: "state", width: 10 },
  { header: "Postal code", key: "postalCode", width: 14 },
  { header: "Country", key: "country", width: 14 },
  { header: "Estimated value", key: "estimatedValue", width: 16 },
  { header: "Estimated close date", key: "estimatedCloseDate", width: 18, numFmt: "yyyy-mm-dd" },
  { header: "Owner", key: "ownerName", width: 22 },
  { header: "Last activity at", key: "lastActivityAt", width: 22, numFmt: "yyyy-mm-dd hh:mm" },
  { header: "Created at", key: "createdAt", width: 22, numFmt: "yyyy-mm-dd hh:mm" },
  { header: "Updated at", key: "updatedAt", width: 22, numFmt: "yyyy-mm-dd hh:mm" },
];

export const ACCOUNT_COLUMNS: readonly ExportColumn[] = [
  { header: "Account ID", key: "id", width: 38 },
  { header: "Name", key: "name", width: 30 },
  { header: "Industry", key: "industry", width: 18 },
  { header: "Website", key: "website", width: 28 },
  { header: "Email", key: "email", width: 30 },
  { header: "Phone", key: "phone", width: 18 },
  { header: "Account number", key: "accountNumber", width: 16 },
  { header: "Employees", key: "numberOfEmployees", width: 12 },
  { header: "Annual revenue", key: "annualRevenue", width: 16 },
  { header: "City", key: "city", width: 16 },
  { header: "State", key: "state", width: 10 },
  { header: "Postal code", key: "postalCode", width: 14 },
  { header: "Country", key: "country", width: 14 },
  { header: "Owner", key: "ownerName", width: 22 },
  { header: "Created at", key: "createdAt", width: 22, numFmt: "yyyy-mm-dd hh:mm" },
  { header: "Updated at", key: "updatedAt", width: 22, numFmt: "yyyy-mm-dd hh:mm" },
];

export const CONTACT_COLUMNS: readonly ExportColumn[] = [
  { header: "Contact ID", key: "id", width: 38 },
  { header: "First name", key: "firstName", width: 18 },
  { header: "Last name", key: "lastName", width: 18 },
  { header: "Job title", key: "jobTitle", width: 22 },
  { header: "Account", key: "accountName", width: 30 },
  { header: "Email", key: "email", width: 30 },
  { header: "Phone", key: "phone", width: 18 },
  { header: "Mobile phone", key: "mobilePhone", width: 18 },
  { header: "City", key: "city", width: 16 },
  { header: "State", key: "state", width: 10 },
  { header: "Postal code", key: "postalCode", width: 14 },
  { header: "Country", key: "country", width: 14 },
  { header: "Do not contact", key: "doNotContact", width: 14 },
  { header: "Do not email", key: "doNotEmail", width: 14 },
  { header: "Owner", key: "ownerName", width: 22 },
  { header: "Created at", key: "createdAt", width: 22, numFmt: "yyyy-mm-dd hh:mm" },
  { header: "Updated at", key: "updatedAt", width: 22, numFmt: "yyyy-mm-dd hh:mm" },
];

export const OPPORTUNITY_COLUMNS: readonly ExportColumn[] = [
  { header: "Opportunity ID", key: "id", width: 38 },
  { header: "Name", key: "name", width: 30 },
  { header: "Stage", key: "stage", width: 16 },
  { header: "Amount", key: "amount", width: 14 },
  { header: "Probability", key: "probability", width: 12 },
  { header: "Account", key: "accountName", width: 30 },
  { header: "Primary contact", key: "primaryContactName", width: 24 },
  { header: "Expected close date", key: "expectedCloseDate", width: 18, numFmt: "yyyy-mm-dd" },
  { header: "Owner", key: "ownerName", width: 22 },
  { header: "Closed at", key: "closedAt", width: 22, numFmt: "yyyy-mm-dd hh:mm" },
  { header: "Created at", key: "createdAt", width: 22, numFmt: "yyyy-mm-dd hh:mm" },
  { header: "Updated at", key: "updatedAt", width: 22, numFmt: "yyyy-mm-dd hh:mm" },
];

export const TASK_COLUMNS: readonly ExportColumn[] = [
  { header: "Task ID", key: "id", width: 38 },
  { header: "Title", key: "title", width: 32 },
  { header: "Status", key: "status", width: 14 },
  { header: "Priority", key: "priority", width: 12 },
  { header: "Due at", key: "dueAt", width: 18, numFmt: "yyyy-mm-dd" },
  { header: "Assigned to", key: "assignedToName", width: 22 },
  { header: "Lead", key: "leadName", width: 24 },
  { header: "Account", key: "accountName", width: 24 },
  { header: "Contact", key: "contactName", width: 24 },
  { header: "Opportunity", key: "opportunityName", width: 24 },
  { header: "Completed at", key: "completedAt", width: 22, numFmt: "yyyy-mm-dd hh:mm" },
  { header: "Created at", key: "createdAt", width: 22, numFmt: "yyyy-mm-dd hh:mm" },
  { header: "Updated at", key: "updatedAt", width: 22, numFmt: "yyyy-mm-dd hh:mm" },
];

export const EXPORT_COLUMNS = {
  lead: LEAD_COLUMNS,
  account: ACCOUNT_COLUMNS,
  contact: CONTACT_COLUMNS,
  opportunity: OPPORTUNITY_COLUMNS,
  task: TASK_COLUMNS,
} as const;

export type ExportEntity = keyof typeof EXPORT_COLUMNS;
