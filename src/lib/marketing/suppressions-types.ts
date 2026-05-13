/**
 * Client-safe types and constants for marketing suppressions.
 *
 * Lives separately from `suppressions.ts` (which is `import
 * "server-only"`-guarded for the DB query helpers) so client
 * components can import the union and the runtime list without
 * dragging the DB connection module into the browser bundle.
 */

export type SuppressionType =
  | "unsubscribe"
  | "group_unsubscribe"
  | "bounce"
  | "block"
  | "spamreport"
  | "invalid"
  | "manual";

export const SUPPRESSION_TYPES: ReadonlyArray<SuppressionType> = [
  "unsubscribe",
  "group_unsubscribe",
  "bounce",
  "block",
  "spamreport",
  "invalid",
  "manual",
];

/**
 * Row shape returned by the suppressions list endpoint. Lives here
 * (vs in `suppressions.ts`) so the client list component can `import
 * type` it without pulling in the server module.
 */
export interface MarketingSuppressionRow {
  email: string;
  suppressionType: SuppressionType;
  reason: string | null;
  suppressedAt: Date;
  syncedAt: Date;
  addedByUserId: string | null;
  addedByName: string | null;
}
