// Plain constants for the Accounts saved-view system. Safe to import
// from client components — no DB imports. Mirrors `view-constants.ts`
// (leads) but with account-specific columns.

export const AVAILABLE_ACCOUNT_COLUMNS = [
  { key: "name", label: "Name" },
  { key: "accountNumber", label: "Account #" },
  { key: "industry", label: "Industry" },
  { key: "website", label: "Website" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "country", label: "Country" },
  { key: "primaryContact", label: "Primary contact" },
  { key: "parentAccount", label: "Parent account" },
  { key: "numberOfEmployees", label: "Employees" },
  { key: "annualRevenue", label: "Revenue" },
  { key: "owner", label: "Owner" },
  { key: "wonDeals", label: "Won deals" },
  { key: "createdAt", label: "Created" },
  { key: "updatedAt", label: "Updated" },
] as const;

export type AccountColumnKey =
  (typeof AVAILABLE_ACCOUNT_COLUMNS)[number]["key"];

export const ACCOUNT_COLUMN_KEYS: AccountColumnKey[] =
  AVAILABLE_ACCOUNT_COLUMNS.map((c) => c.key);

export const DEFAULT_ACCOUNT_COLUMNS: AccountColumnKey[] = [
  "name",
  "industry",
  "website",
  "city",
  "state",
  "owner",
  "createdAt",
];

export const ACCOUNT_SORT_FIELDS = [
  "name",
  "accountNumber",
  "industry",
  "city",
  "state",
  "country",
  "annualRevenue",
  "numberOfEmployees",
  "createdAt",
  "updatedAt",
] as const;

export type AccountSortField = (typeof ACCOUNT_SORT_FIELDS)[number];
