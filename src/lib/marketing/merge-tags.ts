/**
 * Merge tag registry for marketing templates.
 *
 * The Unlayer editor renders an inline "personalize" button that
 * inserts a token like `{{firstName}}`. SendGrid Dynamic Templates
 * resolve those Handlebars tokens at send time using the
 * `dynamic_template_data` payload built per recipient.
 *
 * IMPORTANT — single-brace `{{var}}` form only. Triple-brace
 * `{{{var}}}` would render unescaped HTML in SendGrid's template
 * engine and is a stored-XSS risk for the recipient inbox; we never
 * emit that variant.
 */

export interface MergeTag {
  /** Human-readable label shown in the Unlayer "personalize" panel. */
  name: string;
  /** Handlebars token inserted into the design. */
  value: string;
  /** Sample value Unlayer displays in preview mode. */
  sample: string;
}

export const MERGE_TAGS: MergeTag[] = [
  { name: "First name", value: "{{firstName}}", sample: "Jamie" },
  { name: "Last name", value: "{{lastName}}", sample: "Reed" },
  { name: "Full name", value: "{{fullName}}", sample: "Jamie Reed" },
  { name: "Email", value: "{{email}}", sample: "jamie.reed@example.com" },
  { name: "Company", value: "{{companyName}}", sample: "Acme Holdings" },
  { name: "Job title", value: "{{jobTitle}}", sample: "Director of Benefits" },
  { name: "City", value: "{{city}}", sample: "Jackson" },
  { name: "State", value: "{{state}}", sample: "MS" },
];

/**
 * Build the `mergeTags` option Unlayer expects. Unlayer's API takes a
 * dictionary keyed by an arbitrary string id; we use the bare variable
 * name so the panel sorts predictably.
 */
export function buildMergeTagDict(): Record<
  string,
  { name: string; value: string; sample: string }
> {
  const dict: Record<string, { name: string; value: string; sample: string }> = {};
  for (const tag of MERGE_TAGS) {
    // Strip the `{{` `}}` wrappers for the dictionary key.
    const key = tag.value.replace(/[{}]/g, "");
    dict[key] = { name: tag.name, value: tag.value, sample: tag.sample };
  }
  return dict;
}
