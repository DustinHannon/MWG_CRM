import { TAG_COLORS, type TagColor } from "@/db/schema/tags";

/**
 * Tag color helpers shared between TagChip, TagColorPicker, and
 * TagEditModal. Tags can be coloured either via a fixed palette name
 * (matches TAG_COLORS) or via a raw hex string `#RRGGBB` set through
 * the custom hex input on TagEditModal. All UI surfaces must accept
 * both forms.
 */

export const PALETTE: readonly TagColor[] = TAG_COLORS;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** True when value is a valid `#RRGGBB` hex string. */
export function isHexColor(value: string): boolean {
  return HEX_RE.test(value);
}

/** True when value is one of the fixed palette names. */
export function isPaletteColor(value: string): value is TagColor {
  return (PALETTE as readonly string[]).includes(value);
}

/**
 * Pick a sensible default palette colour by rotating through PALETTE.
 * Used when an inline tag is auto-created and no colour is supplied.
 */
export function nextDefaultPaletteColor(existingCount: number): TagColor {
  const idx = ((existingCount % PALETTE.length) + PALETTE.length) % PALETTE.length;
  return PALETTE[idx];
}

/**
 * YIQ-style brightness check on a hex string. Returns "light" when the
 * background is light enough that text should be dark, and "dark"
 * otherwise. Used only for tag chips rendered with custom hex colours;
 * palette colours have pre-computed -foreground tokens.
 */
export function tagContrastTextColor(hex: string): "light" | "dark" {
  if (!isHexColor(hex)) return "dark";
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // YIQ formula — biased toward perceived luminance.
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 140 ? "light" : "dark";
}

/**
 * Resolve a tag colour to a pair of Tailwind classes
 * (background + text). Palette names map to `bg-tag-<name>` /
 * `text-tag-<name>-foreground`. Hex values map to inline styles via
 * the caller; we return `null` so the caller can fall back.
 */
export function tagColorClasses(color: string | undefined | null): {
  classes: string | null;
  inlineStyle: { backgroundColor: string; color: string } | null;
} {
  const c = color ?? "slate";
  if (isPaletteColor(c)) {
    return {
      classes: `bg-tag-${c} text-tag-${c}-foreground`,
      inlineStyle: null,
    };
  }
  if (isHexColor(c)) {
    const fg = tagContrastTextColor(c) === "light" ? "#0f172a" : "#f8fafc";
    return {
      classes: null,
      inlineStyle: { backgroundColor: c, color: fg },
    };
  }
  // Unknown — fall back to slate palette.
  return {
    classes: "bg-tag-slate text-tag-slate-foreground",
    inlineStyle: null,
  };
}
