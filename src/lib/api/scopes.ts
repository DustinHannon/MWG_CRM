/**
 * Phase 13 — API key scope catalogue. Every scope listed here is the
 * complete set; the admin UI grid renders from this; the auth middleware
 * checks against this; the OpenAPI security scheme documents this.
 *
 * Scopes are entity-granular: `read:<entity>`, `write:<entity>`,
 * `delete:<entity>`. The `admin` super-scope grants all of the above
 * plus access to admin-gated endpoints (`/users`).
 *
 * Plain constants — no server-only marker because the admin UI client
 * component renders the scope grid using ENTITIES + ALL_SCOPES + the
 * SCOPE_PRESETS bundle. None of the values here are secrets.
 */

export const ENTITIES = [
  "leads",
  "accounts",
  "contacts",
  "opportunities",
  "tasks",
  "activities",
] as const;

export type Entity = (typeof ENTITIES)[number];

const READ_SCOPES = ENTITIES.map((e) => `read:${e}` as const);
const WRITE_SCOPES = ENTITIES.map((e) => `write:${e}` as const);
const DELETE_SCOPES = ENTITIES.map((e) => `delete:${e}` as const);

export const ALL_SCOPES = [
  ...READ_SCOPES,
  ...WRITE_SCOPES,
  ...DELETE_SCOPES,
  "read:users",
  "admin",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

export function isValidScope(s: string): s is Scope {
  return (ALL_SCOPES as readonly string[]).includes(s);
}

/**
 * Quick-preset bundles surfaced as buttons in the key-generation modal.
 * The user can still hand-pick any combination after applying a preset.
 */
export const SCOPE_PRESETS = {
  readonly: [...READ_SCOPES, "read:users"] as Scope[],
  readwrite: [...READ_SCOPES, ...WRITE_SCOPES, "read:users"] as Scope[],
  full: [
    ...READ_SCOPES,
    ...WRITE_SCOPES,
    ...DELETE_SCOPES,
    "read:users",
  ] as Scope[],
  admin: ["admin" as Scope],
};

/**
 * Returns true if a key with `granted` scopes satisfies `required`.
 * `admin` super-scope grants everything except where the route demands
 * the literal `admin` scope (in which case only `admin` works).
 */
export function hasScope(granted: readonly string[], required: Scope): boolean {
  if (granted.includes("admin")) return true;
  return granted.includes(required);
}
