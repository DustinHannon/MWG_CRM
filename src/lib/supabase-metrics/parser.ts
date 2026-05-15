/**
 * Inline Prometheus text-exposition parser. No external dep — we own
 * every line of parsing logic so a malformed upstream response can
 * never crash the scrape handler.
 *
 * Handles:
 *   `# HELP <name> <text>` lines     — discard
 *   `# TYPE <name> <type>` lines     — capture type
 *   `<name>{labels} <float>` samples — emit with labels
 *   `<name> <float>` samples         — emit with empty labels
 *   Histogram suffixes `_bucket` / `_sum` / `_count` — pass through as
 *   separate series; the dashboard never aggregates raw histograms so
 *   we treat them like any other series.
 *   Trailing scrape-timestamp                  — ignored (caller uses
 *   scrape-start time so every row in one batch joins trivially).
 *   Escape sequences `\\`, `\"`, `\n` in label values — decoded.
 *   NaN / +Inf / -Inf / empty value            — emitted as `value`
 *   field with the literal float; caller's job to coerce.
 *   Blank lines / unparseable lines            — skipped, counted.
 *
 * The parser never throws for any single-line problem — it accumulates
 * the bad-line count instead. A truly empty / non-text body returns
 * `{ samples: [], skippedLines: 0 }` so the scrape handler can decide
 * to log a warning without a try/catch nest.
 */

export type PromMetricType =
  | "gauge"
  | "counter"
  | "histogram"
  | "summary"
  | "untyped";

export interface ParsedSample {
  name: string;
  labels: Record<string, string>;
  value: number;
  type: PromMetricType;
}

export interface ParseResult {
  samples: ParsedSample[];
  skippedLines: number;
}

export function parsePrometheusText(body: string): ParseResult {
  if (typeof body !== "string" || body.length === 0) {
    return { samples: [], skippedLines: 0 };
  }
  const typeMap = new Map<string, PromMetricType>();
  const samples: ParsedSample[] = [];
  let skippedLines = 0;

  const lines = body.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;

    if (line.startsWith("#")) {
      // `# TYPE name type`
      if (line.startsWith("# TYPE ")) {
        const rest = line.slice("# TYPE ".length).trim();
        const sp = rest.indexOf(" ");
        if (sp > 0) {
          const name = rest.slice(0, sp);
          const t = rest.slice(sp + 1).trim().toLowerCase();
          if (
            t === "gauge" ||
            t === "counter" ||
            t === "histogram" ||
            t === "summary" ||
            t === "untyped"
          ) {
            typeMap.set(name, t);
          }
        }
      }
      // HELP / other comments are discarded.
      continue;
    }

    try {
      const sample = parseSample(line, typeMap);
      if (sample) {
        samples.push(sample);
      } else {
        skippedLines += 1;
      }
    } catch {
      skippedLines += 1;
    }
  }

  return { samples, skippedLines };
}

function parseSample(
  line: string,
  typeMap: Map<string, PromMetricType>,
): ParsedSample | null {
  // Two valid shapes:
  //   name{labels} value [timestamp]
  //   name value [timestamp]
  const braceOpen = line.indexOf("{");
  let name: string;
  let labels: Record<string, string>;
  let rest: string;

  if (braceOpen === -1) {
    // No labels.
    const sp = line.indexOf(" ");
    if (sp <= 0) return null;
    name = line.slice(0, sp);
    labels = {};
    rest = line.slice(sp + 1).trimStart();
  } else {
    name = line.slice(0, braceOpen);
    if (name.length === 0) return null;
    const braceClose = findMatchingBrace(line, braceOpen);
    if (braceClose === -1) return null;
    labels = parseLabels(line.slice(braceOpen + 1, braceClose));
    rest = line.slice(braceClose + 1).trimStart();
  }

  if (!isValidMetricName(name)) return null;

  // `rest` is "<value>" or "<value> <timestamp>". Take the first token.
  const valueEnd = rest.indexOf(" ");
  const valueStr = valueEnd === -1 ? rest : rest.slice(0, valueEnd);
  if (valueStr.length === 0) return null;

  const value = parsePromFloat(valueStr);
  if (Number.isNaN(value) && valueStr.toLowerCase() !== "nan") {
    // True parse failure (not the literal "NaN" sentinel).
    return null;
  }

  return {
    name,
    labels,
    value,
    type: typeMap.get(name) ?? "untyped",
  };
}

function findMatchingBrace(line: string, openIdx: number): number {
  // Label values can contain `}` only when escaped; we scan respecting
  // quoting state. This handles the common `re="a{b}"` edge case.
  let i = openIdx + 1;
  let inQuote = false;
  let prevBackslash = false;
  while (i < line.length) {
    const ch = line[i];
    if (inQuote) {
      if (prevBackslash) {
        prevBackslash = false;
      } else if (ch === "\\") {
        prevBackslash = true;
      } else if (ch === '"') {
        inQuote = false;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
      } else if (ch === "}") {
        return i;
      }
    }
    i += 1;
  }
  return -1;
}

function parseLabels(body: string): Record<string, string> {
  // body is the interior of the `{}` without the braces.
  const out: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    // skip whitespace / commas between labels.
    while (i < body.length && (body[i] === " " || body[i] === ",")) i += 1;
    if (i >= body.length) break;

    // key — `[a-zA-Z_][a-zA-Z0-9_]*`
    const keyStart = i;
    while (
      i < body.length &&
      ((body[i] >= "a" && body[i] <= "z") ||
        (body[i] >= "A" && body[i] <= "Z") ||
        (body[i] >= "0" && body[i] <= "9") ||
        body[i] === "_")
    ) {
      i += 1;
    }
    const key = body.slice(keyStart, i);
    if (key.length === 0) break;

    // optional whitespace + `=`
    while (i < body.length && body[i] === " ") i += 1;
    if (body[i] !== "=") break;
    i += 1;
    while (i < body.length && body[i] === " ") i += 1;

    // value — quoted with `\` escapes.
    if (body[i] !== '"') break;
    i += 1;
    let v = "";
    while (i < body.length && body[i] !== '"') {
      if (body[i] === "\\" && i + 1 < body.length) {
        const next = body[i + 1];
        if (next === "\\") v += "\\";
        else if (next === '"') v += '"';
        else if (next === "n") v += "\n";
        else v += next;
        i += 2;
      } else {
        v += body[i];
        i += 1;
      }
    }
    // skip closing `"` (or terminate if missing).
    if (body[i] === '"') i += 1;
    out[key] = v;
  }
  return out;
}

function isValidMetricName(name: string): boolean {
  // Prometheus metric names: `[a-zA-Z_:][a-zA-Z0-9_:]*`.
  // Limit length to defend against pathological inputs.
  if (name.length === 0 || name.length > 256) return false;
  const first = name.charCodeAt(0);
  const isAlpha =
    (first >= 65 && first <= 90) ||
    (first >= 97 && first <= 122) ||
    first === 95 ||
    first === 58;
  if (!isAlpha) return false;
  for (let i = 1; i < name.length; i += 1) {
    const c = name.charCodeAt(i);
    const ok =
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      c === 95 ||
      c === 58;
    if (!ok) return false;
  }
  return true;
}

function parsePromFloat(s: string): number {
  // Prometheus uses `Nan`, `+Inf`, `-Inf` (case-insensitive variants).
  const low = s.toLowerCase();
  if (low === "nan") return Number.NaN;
  if (low === "+inf" || low === "inf") return Number.POSITIVE_INFINITY;
  if (low === "-inf") return Number.NEGATIVE_INFINITY;
  // parseFloat tolerates trailing garbage; require strict numeric form.
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
    return Number.NaN;
  }
  return Number.parseFloat(s);
}
