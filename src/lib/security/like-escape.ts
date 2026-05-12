/**
 * Escape user input for use in SQL LIKE / ILIKE
 * patterns. Postgres LIKE treats `%` and `_` as wildcards, so user
 * input destined for the value half of a `column LIKE pattern` clause
 * must be escaped before the surrounding `%` are concatenated.
 *
 * Drizzle's `.like()` / `.ilike()` accept a raw string and pass it
 * verbatim — they do NOT escape wildcard characters. Pass any user
 * input through `escapeLike` first.
 *
 * The default escape character is backslash, which Postgres recognises
 * by default. The returned string is safe to wrap in `%` for substring
 * matching: `\`%\` + escapeLike(input) + \`%\``.
 */
export function escapeLike(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Convenience — wraps `%escapeLike(input)%` so callers don't have to
 * remember to escape.
 */
export function likeContains(input: string): string {
  return `%${escapeLike(input)}%`;
}

/**
 * `escapeLike(input) + %` — anchored prefix (`startsWith`).
 */
export function likeStartsWith(input: string): string {
  return `${escapeLike(input)}%`;
}

/**
 * `% + escapeLike(input)` — anchored suffix (`endsWith`).
 */
export function likeEndsWith(input: string): string {
  return `%${escapeLike(input)}`;
}
