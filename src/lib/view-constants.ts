// Plain constants — safe to import from client components. The richer
// queries / CRUD live in src/lib/views.ts which is server-only.

export const AVAILABLE_COLUMNS = [
  { key: "firstName", label: "First Name" },
  { key: "lastName", label: "Last Name" },
  { key: "companyName", label: "Company" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "mobilePhone", label: "Mobile Phone" },
  { key: "jobTitle", label: "Job Title" },
  { key: "status", label: "Status" },
  { key: "rating", label: "Rating" },
  { key: "source", label: "Source" },
  { key: "owner", label: "Owner" },
  { key: "tags", label: "Tags" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "estimatedValue", label: "Estimated Value" },
  { key: "estimatedCloseDate", label: "Estimated Close Date" },
  { key: "createdBy", label: "Created By" },
  { key: "createdVia", label: "Created Via" },
  { key: "createdAt", label: "Created At" },
  { key: "lastActivityAt", label: "Last Activity At" },
  { key: "updatedAt", label: "Updated At" },
] as const;

export type ColumnKey = (typeof AVAILABLE_COLUMNS)[number]["key"];
export const COLUMN_KEYS: ColumnKey[] = AVAILABLE_COLUMNS.map((c) => c.key);

export const DEFAULT_COLUMNS: ColumnKey[] = [
  "firstName",
  "lastName",
  "companyName",
  "status",
  "rating",
  "owner",
  "lastActivityAt",
];
