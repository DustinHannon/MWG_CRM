/**
 * HTML helpers for rendering imported / external body content.
 *
 * D365 email bodies are full Outlook/Word HTML documents; calls, notes, and
 * most task descriptions are plain text. These helpers are PURE string ops
 * (no DOM) so they run identically on the server and the client — a snippet
 * computed during SSR matches the client render and won't trip a hydration
 * mismatch.
 *
 * All patterns here are LINEAR (no nested/backtracking quantifiers) and the
 * stripper caps its input, so a pathological body (e.g. a long run of bare
 * `<`) can't pin a CPU — important because `htmlToPlainText` runs synchronously
 * inside server components.
 */

/** True when the string looks like it actually contains HTML markup. */
export function isLikelyHtml(s: string | null | undefined): boolean {
  if (!s) return false;
  // A real tag: `<` (optionally `/`) then a tag NAME (`[a-z][a-z0-9]*`)
  // terminated by whitespace, `/`, or `>`; OR a doctype / comment open. The
  // name-terminator requirement is what stops a bare angle-bracketed email or
  // URL (`<bob@x.com>`, `<https://…>`) from being mistaken for HTML — `@`/`:`
  // is not a valid terminator. Requiring `[a-z]` right after `<` also keeps
  // the test linear on a run of bare `<` (instant fail, no scan-to-end).
  return /<(?:!doctype\b|!--|\/?[a-z][a-z0-9]*[\s/>])/i.test(s);
}

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&mdash;": "—",
  "&ndash;": "–",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&rdquo;": "”",
  "&ldquo;": "“",
  "&hellip;": "…",
  "&copy;": "©",
  "&reg;": "®",
  "&trade;": "™",
  "&middot;": "·",
  "&bull;": "•",
  "&deg;": "°",
  "&euro;": "€",
  "&pound;": "£",
  "&cent;": "¢",
  "&times;": "×",
  "&divide;": "÷",
  "&sect;": "§",
};

/** Cap the input the stripper scans. Snippets need ~180 chars; even a print
 * summary rarely needs more than a few KB of text. Bounding the input keeps
 * the lazy `<style>`/`<head>` strips from going quadratic on a malformed body
 * with many unclosed openers. */
const MAX_STRIP_INPUT = 100_000;

/** Decode one numeric character reference to its code point, dropping
 * out-of-range / surrogate values (which `String.fromCodePoint` would throw
 * on) to a single space. */
function decodeCodePoint(code: number): string {
  if (
    !Number.isInteger(code) ||
    code <= 0 ||
    code > 0x10ffff ||
    (code >= 0xd800 && code <= 0xdfff)
  ) {
    return " ";
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return " ";
  }
}

/**
 * Strip HTML to readable plain text — for collapsed snippets, list-cell
 * previews, and the print summary (a full HTML email has no place in a paper
 * summary). Drops comments (incl. Word MSO conditionals), head/style/script
 * blocks, converts block boundaries to newlines, removes the remaining tags,
 * decodes numeric + common named entities, and collapses runs of whitespace.
 */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return "";
  const input =
    html.length > MAX_STRIP_INPUT ? html.slice(0, MAX_STRIP_INPUT) : html;
  return input
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // Linear tag strip: `[^<>]` can never consume a `<`, so a run of bare `<`
    // fails instantly at each position instead of backtracking (no ReDoS).
    .replace(/<[^<>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      decodeCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => decodeCodePoint(Number.parseInt(dec, 10)))
    // Unknown named entities degrade to their literal text, never vanish.
    .replace(/&[a-z][a-z0-9]*;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "");
}

/**
 * Display helper for inline surfaces (list cells, key/value rows, the print
 * summary): strip to plain text ONLY when the value is actually HTML. Genuine
 * plain text is returned untouched, so a user-typed description keeps its
 * literal `&`/`<` and its own whitespace — `htmlToPlainText` would otherwise
 * entity-decode and collapse it.
 */
export function htmlToDisplayText(s: string | null | undefined): string {
  if (!s) return "";
  return isLikelyHtml(s) ? htmlToPlainText(s) : s;
}
