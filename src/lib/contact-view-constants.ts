// Plain constants for the Contacts saved-view system. Safe to import
// from client components — no DB imports. Mirrors `account-view-constants.ts`
// but with contact-specific columns.

export const AVAILABLE_CONTACT_COLUMNS = [
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "account", label: "Account" },
  { key: "jobTitle", label: "Job title" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "mobilePhone", label: "Mobile" },
  { key: "doNotContact", label: "DNC" },
  { key: "owner", label: "Owner" },
  { key: "createdAt", label: "Created" },
  { key: "updatedAt", label: "Updated" },
] as const;

export type ContactColumnKey =
  (typeof AVAILABLE_CONTACT_COLUMNS)[number]["key"];

export const CONTACT_COLUMN_KEYS: ContactColumnKey[] =
  AVAILABLE_CONTACT_COLUMNS.map((c) => c.key);

export const DEFAULT_CONTACT_COLUMNS: ContactColumnKey[] = [
  "firstName",
  "lastName",
  "account",
  "jobTitle",
  "email",
  "owner",
  "updatedAt",
];

export const CONTACT_SORT_FIELDS = [
  "firstName",
  "lastName",
  "jobTitle",
  "email",
  "createdAt",
  "updatedAt",
] as const;

export type ContactSortField = (typeof CONTACT_SORT_FIELDS)[number];
