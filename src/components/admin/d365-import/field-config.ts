/**
 * Per-entity field configuration for the D365 import batch review UI.
 *
 * Each entry describes one column on the local row, the D365 source
 * field(s) it derives from, the input type the editor renders, and the
 * section header it belongs to. The mapper writes flat `NewLead`,
 * `NewContact`, etc. into `mappedPayload.mapped`; the review UI
 * iterates this config to render structured, typed inputs and shows
 * the D365 source value side-by-side.
 *
 * Fields not in this config still appear under "Other" so an unknown
 * field never silently vanishes.
 */

export type FieldType = "text" | "long_text" | "boolean" | "date" | "number" | "uuid_ref";

export interface FieldConfig {
  /** Local column name on the insertable (e.g., `firstName`). */
  name: string;
  /** Human-readable label. */
  label: string;
  /** Section header for grouping in the editor. */
  section: string;
  /** Input type. */
  type: FieldType;
  /** Source D365 field(s) — first non-empty wins for display. */
  sources?: string[];
  /** Read-only in the editor (e.g., createdAt). */
  readOnly?: boolean;
}

const CONTACT_FIELDS: FieldConfig[] = [
  // Identity
  { name: "firstName", label: "First name", section: "Identity", type: "text", sources: ["firstname"] },
  { name: "lastName", label: "Last name", section: "Identity", type: "text", sources: ["lastname"] },
  { name: "jobTitle", label: "Job title", section: "Identity", type: "text", sources: ["jobtitle"] },
  { name: "birthdate", label: "Birthdate", section: "Identity", type: "date", sources: ["birthdate"] },
  // Contact info
  { name: "email", label: "Email", section: "Contact info", type: "text", sources: ["emailaddress1", "emailaddress2", "emailaddress3"] },
  { name: "phone", label: "Phone", section: "Contact info", type: "text", sources: ["telephone1", "telephone2"] },
  { name: "mobilePhone", label: "Mobile", section: "Contact info", type: "text", sources: ["mobilephone"] },
  // Address
  { name: "street1", label: "Street 1", section: "Address", type: "text", sources: ["address1_line1"] },
  { name: "street2", label: "Street 2", section: "Address", type: "text", sources: ["address1_line2"] },
  { name: "city", label: "City", section: "Address", type: "text", sources: ["address1_city"] },
  { name: "state", label: "State / province", section: "Address", type: "text", sources: ["address1_stateorprovince"] },
  { name: "postalCode", label: "Postal code", section: "Address", type: "text", sources: ["address1_postalcode"] },
  { name: "country", label: "Country", section: "Address", type: "text", sources: ["address1_country"] },
  // Preferences
  { name: "doNotContact", label: "Do not contact (derived)", section: "Preferences", type: "boolean", readOnly: true },
  { name: "doNotEmail", label: "Do not email", section: "Preferences", type: "boolean", sources: ["donotemail"] },
  { name: "doNotCall", label: "Do not call", section: "Preferences", type: "boolean", sources: ["donotphone"] },
  { name: "doNotMail", label: "Do not postal mail", section: "Preferences", type: "boolean", sources: ["donotpostalmail"] },
  // Description
  { name: "description", label: "Description", section: "Notes", type: "long_text", sources: ["description"] },
  // Status (D365 lifecycle)
  { name: "d365StateCode", label: "D365 statecode", section: "Status", type: "number", sources: ["statecode"], readOnly: true },
  { name: "d365StatusCode", label: "D365 statuscode", section: "Status", type: "number", sources: ["statuscode"], readOnly: true },
  { name: "isDeleted", label: "Archive on import (D365 inactive)", section: "Status", type: "boolean" },
  { name: "deleteReason", label: "Archive reason", section: "Status", type: "text", readOnly: true },
  // Linkage
  { name: "accountId", label: "Linked account", section: "Linkage", type: "uuid_ref", sources: ["_parentcustomerid_value", "_accountid_value"] },
  // Audit
  { name: "ownerId", label: "Owner", section: "Audit", type: "uuid_ref", sources: ["_ownerid_value"], readOnly: true },
  { name: "createdById", label: "Created by", section: "Audit", type: "uuid_ref", sources: ["_createdby_value"], readOnly: true },
  { name: "updatedById", label: "Updated by", section: "Audit", type: "uuid_ref", sources: ["_modifiedby_value"], readOnly: true },
  { name: "createdAt", label: "Created at", section: "Audit", type: "date", sources: ["createdon"], readOnly: true },
  { name: "updatedAt", label: "Updated at", section: "Audit", type: "date", sources: ["modifiedon"], readOnly: true },
];

const LEAD_FIELDS: FieldConfig[] = [
  { name: "firstName", label: "First name", section: "Identity", type: "text", sources: ["firstname"] },
  { name: "lastName", label: "Last name", section: "Identity", type: "text", sources: ["lastname"] },
  { name: "companyName", label: "Company", section: "Identity", type: "text", sources: ["companyname"] },
  { name: "jobTitle", label: "Job title", section: "Identity", type: "text", sources: ["jobtitle"] },
  { name: "subject", label: "Subject", section: "Identity", type: "text", sources: ["subject"] },
  { name: "email", label: "Email", section: "Contact info", type: "text", sources: ["emailaddress1", "emailaddress2", "emailaddress3"] },
  { name: "phone", label: "Phone", section: "Contact info", type: "text", sources: ["telephone1"] },
  { name: "mobilePhone", label: "Mobile", section: "Contact info", type: "text", sources: ["mobilephone"] },
  { name: "website", label: "Website", section: "Contact info", type: "text", sources: ["websiteurl"] },
  { name: "street1", label: "Street 1", section: "Address", type: "text", sources: ["address1_line1"] },
  { name: "street2", label: "Street 2", section: "Address", type: "text", sources: ["address1_line2"] },
  { name: "city", label: "City", section: "Address", type: "text", sources: ["address1_city"] },
  { name: "state", label: "State / province", section: "Address", type: "text", sources: ["address1_stateorprovince"] },
  { name: "postalCode", label: "Postal code", section: "Address", type: "text", sources: ["address1_postalcode"] },
  { name: "country", label: "Country", section: "Address", type: "text", sources: ["address1_country"] },
  { name: "description", label: "Description", section: "Notes", type: "long_text", sources: ["description"] },
  { name: "doNotEmail", label: "Do not email", section: "Preferences", type: "boolean", sources: ["donotemail"] },
  { name: "doNotCall", label: "Do not call", section: "Preferences", type: "boolean", sources: ["donotphone"] },
  { name: "doNotContact", label: "Do not contact (derived)", section: "Preferences", type: "boolean", readOnly: true },
  { name: "status", label: "Lead status", section: "Status", type: "text" },
  { name: "rating", label: "Rating", section: "Status", type: "text", sources: ["leadqualitycode"] },
  { name: "source", label: "Source", section: "Status", type: "text", sources: ["leadsourcecode"] },
  { name: "industry", label: "Industry", section: "Status", type: "text", sources: ["industrycode"] },
  { name: "estimatedValue", label: "Estimated value", section: "Status", type: "number", sources: ["estimatedamount"] },
  { name: "estimatedCloseDate", label: "Estimated close date", section: "Status", type: "date", sources: ["estimatedclosedate"] },
  { name: "d365StateCode", label: "D365 statecode", section: "Status", type: "number", sources: ["statecode"], readOnly: true },
  { name: "d365StatusCode", label: "D365 statuscode", section: "Status", type: "number", sources: ["statuscode"], readOnly: true },
  { name: "ownerId", label: "Owner", section: "Audit", type: "uuid_ref", sources: ["_ownerid_value"], readOnly: true },
  { name: "externalId", label: "D365 lead id", section: "Audit", type: "uuid_ref", sources: ["leadid"], readOnly: true },
  { name: "createdAt", label: "Created at", section: "Audit", type: "date", sources: ["createdon"], readOnly: true },
  { name: "updatedAt", label: "Updated at", section: "Audit", type: "date", sources: ["modifiedon"], readOnly: true },
];

const ACCOUNT_FIELDS: FieldConfig[] = [
  { name: "name", label: "Name", section: "Identity", type: "text", sources: ["name"] },
  { name: "accountNumber", label: "Account number", section: "Identity", type: "text", sources: ["accountnumber"] },
  { name: "industry", label: "Industry", section: "Identity", type: "text", sources: ["industrycode"] },
  { name: "website", label: "Website", section: "Identity", type: "text", sources: ["websiteurl"] },
  { name: "email", label: "Email", section: "Contact info", type: "text", sources: ["emailaddress1"] },
  { name: "phone", label: "Phone", section: "Contact info", type: "text", sources: ["telephone1"] },
  { name: "numberOfEmployees", label: "Employees", section: "Identity", type: "number", sources: ["numberofemployees"] },
  { name: "annualRevenue", label: "Annual revenue", section: "Identity", type: "number", sources: ["revenue"] },
  { name: "street1", label: "Street 1", section: "Address", type: "text", sources: ["address1_line1"] },
  { name: "street2", label: "Street 2", section: "Address", type: "text", sources: ["address1_line2"] },
  { name: "city", label: "City", section: "Address", type: "text", sources: ["address1_city"] },
  { name: "state", label: "State / province", section: "Address", type: "text", sources: ["address1_stateorprovince"] },
  { name: "postalCode", label: "Postal code", section: "Address", type: "text", sources: ["address1_postalcode"] },
  { name: "country", label: "Country", section: "Address", type: "text", sources: ["address1_country"] },
  { name: "description", label: "Description", section: "Notes", type: "long_text", sources: ["description"] },
  { name: "parentAccountId", label: "Parent account", section: "Linkage", type: "uuid_ref", sources: ["_parentaccountid_value"] },
  { name: "primaryContactId", label: "Primary contact", section: "Linkage", type: "uuid_ref", sources: ["_primarycontactid_value"] },
  { name: "d365StateCode", label: "D365 statecode", section: "Status", type: "number", sources: ["statecode"], readOnly: true },
  { name: "d365StatusCode", label: "D365 statuscode", section: "Status", type: "number", sources: ["statuscode"], readOnly: true },
  { name: "isDeleted", label: "Archive on import (D365 inactive)", section: "Status", type: "boolean" },
  { name: "ownerId", label: "Owner", section: "Audit", type: "uuid_ref", sources: ["_ownerid_value"], readOnly: true },
  { name: "createdAt", label: "Created at", section: "Audit", type: "date", sources: ["createdon"], readOnly: true },
  { name: "updatedAt", label: "Updated at", section: "Audit", type: "date", sources: ["modifiedon"], readOnly: true },
];

const OPPORTUNITY_FIELDS: FieldConfig[] = [
  { name: "name", label: "Name", section: "Identity", type: "text", sources: ["name"] },
  { name: "stage", label: "Stage", section: "Status", type: "text" },
  { name: "amount", label: "Amount", section: "Identity", type: "number", sources: ["estimatedvalue"] },
  { name: "probability", label: "Probability %", section: "Identity", type: "number", sources: ["closeprobability"] },
  { name: "expectedCloseDate", label: "Expected close date", section: "Identity", type: "date", sources: ["estimatedclosedate"] },
  { name: "closedAt", label: "Closed at", section: "Status", type: "date", sources: ["actualclosedate"], readOnly: true },
  { name: "accountId", label: "Linked account", section: "Linkage", type: "uuid_ref", sources: ["_customerid_value", "_parentaccountid_value"] },
  { name: "primaryContactId", label: "Primary contact", section: "Linkage", type: "uuid_ref", sources: ["_parentcontactid_value"] },
  { name: "description", label: "Description", section: "Notes", type: "long_text", sources: ["description"] },
  { name: "d365StateCode", label: "D365 statecode", section: "Status", type: "number", sources: ["statecode"], readOnly: true },
  { name: "d365StatusCode", label: "D365 statuscode", section: "Status", type: "number", sources: ["statuscode"], readOnly: true },
  { name: "ownerId", label: "Owner", section: "Audit", type: "uuid_ref", sources: ["_ownerid_value"], readOnly: true },
  { name: "createdAt", label: "Created at", section: "Audit", type: "date", sources: ["createdon"], readOnly: true },
  { name: "updatedAt", label: "Updated at", section: "Audit", type: "date", sources: ["modifiedon"], readOnly: true },
];

const ACTIVITY_FIELDS: FieldConfig[] = [
  { name: "subject", label: "Subject", section: "Identity", type: "text", sources: ["subject"] },
  { name: "kind", label: "Kind", section: "Identity", type: "text" },
  { name: "body", label: "Body", section: "Body", type: "long_text", sources: ["description", "notetext"] },
  { name: "occurredAt", label: "Occurred at", section: "Audit", type: "date", sources: ["scheduledstart", "actualstart", "createdon"], readOnly: true },
  { name: "createdAt", label: "Created at", section: "Audit", type: "date", sources: ["createdon"], readOnly: true },
];

export const FIELD_CONFIGS: Record<string, FieldConfig[]> = {
  contact: CONTACT_FIELDS,
  lead: LEAD_FIELDS,
  account: ACCOUNT_FIELDS,
  opportunity: OPPORTUNITY_FIELDS,
  annotation: ACTIVITY_FIELDS,
  task: ACTIVITY_FIELDS,
  phonecall: ACTIVITY_FIELDS,
  appointment: ACTIVITY_FIELDS,
  email: ACTIVITY_FIELDS,
};

export const SECTION_ORDER = [
  "Identity",
  "Contact info",
  "Address",
  "Preferences",
  "Notes",
  "Body",
  "Status",
  "Linkage",
  "Audit",
  "Other",
];

export function configFor(entityType: string): FieldConfig[] {
  return FIELD_CONFIGS[entityType] ?? [];
}
