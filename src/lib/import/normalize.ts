// value-level normalisation for imported cells. Phone is
// the only one with substantial logic; the rest are trims and
// lowercasings that keep the schema's CHECK constraints happy.

import { parsePhoneNumber } from "libphonenumber-js";

export function normaliseEmail(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

export function normaliseUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Allow http(s) only — schema CHECK enforces the protocol regex too.
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

export function normalisePhone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = parsePhoneNumber(trimmed, "US");
    if (parsed && parsed.isValid()) return parsed.format("E.164");
  } catch {
    /* fall through */
  }
  // Couldn't normalise — pass through trimmed so the user can fix
  // later. The 50-char CHECK guards length.
  return trimmed.slice(0, 50);
}

export function trimToNull(
  raw: string | undefined | null,
  maxLen?: number,
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (maxLen && trimmed.length > maxLen) return trimmed.slice(0, maxLen);
  return trimmed;
}

export function parseBoolish(s: string | undefined | null): boolean {
  if (!s) return false;
  const v = s.toString().trim().toLowerCase();
  return ["true", "yes", "y", "1", "x", "✓", "checked"].includes(v);
}

export function parseIntInRange(
  raw: string | undefined | null,
  min: number,
  max: number,
): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9-]/g, "");
  if (cleaned.length === 0) return null;
  const n = parseInt(cleaned, 10);
  if (Number.isNaN(n) || n < min || n > max) return null;
  return n;
}

export function parseCurrencyish(
  raw: string | undefined | null,
): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned.length === 0) return null;
  const n = parseFloat(cleaned);
  if (Number.isNaN(n) || n < 0) return null;
  return n;
}

export function parseIsoDate(
  raw: string | undefined | null,
): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Accept YYYY-MM-DD or full ISO. Excel dates often serialise as ISO
  // with timezone via exceljs; if the cell is already a Date, the caller
  // should have stringified it before reaching here.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (!m) {
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
