"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { isHexColor, isPaletteColor, PALETTE, tagColorClasses } from "./helpers";

interface TagColorPickerProps {
  value: string;
  onChange: (color: string) => void;
}

/**
 * Side-by-side picker for tag colours. The 11 palette swatches are
 * the canonical choices; the hex input is the escape hatch for
 * custom colours. Selected swatch shows a ring + check; if the
 * current value is a hex string, no swatch is selected but the hex
 * input shows it.
 */
export function TagColorPicker({ value, onChange }: TagColorPickerProps) {
  const [hexDraft, setHexDraft] = useState(
    isHexColor(value) ? value : "#",
  );
  const [hexError, setHexError] = useState<string | null>(null);

  function pickPalette(name: string) {
    setHexDraft("#");
    setHexError(null);
    onChange(name);
  }

  function applyHex() {
    if (isHexColor(hexDraft)) {
      setHexError(null);
      onChange(hexDraft);
    } else {
      setHexError("Use a six-digit hex like #1a2b3c.");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {PALETTE.map((name) => {
          const { classes, inlineStyle } = tagColorClasses(name);
          const selected = isPaletteColor(value) && value === name;
          return (
            <button
              key={name}
              type="button"
              onClick={() => pickPalette(name)}
              aria-label={`Use ${name} colour`}
              aria-pressed={selected}
              className={cn(
                "relative h-7 w-7 rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                classes,
                selected
                  ? "ring-2 ring-foreground ring-offset-2 ring-offset-background"
                  : "ring-1 ring-foreground/10 hover:ring-foreground/40",
              )}
              style={inlineStyle ?? undefined}
            >
              {selected ? (
                <Check size={14} className="absolute inset-0 m-auto" />
              ) : null}
            </button>
          );
        })}
      </div>

      <div>
        <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-muted-foreground">
          Custom hex
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={hexDraft}
              onChange={(e) => {
                // Auto-prefix `#` when the user types/pastes a bare
                // 6-char hex (common when copying from a color picker
                // that doesn't include the prefix). Without this, the
                // input shows "1A2B3C" and Apply errors with "use a
                // six-digit hex like #1a2b3c" — non-obvious UX.
                let next = e.target.value.trim();
                if (next.length > 0 && !next.startsWith("#")) {
                  next = `#${next}`;
                }
                setHexDraft(next);
                setHexError(null);
              }}
              onBlur={() => {
                if (hexDraft && hexDraft !== "#" && hexDraft !== value) {
                  applyHex();
                }
              }}
              placeholder="#1a2b3c"
              maxLength={7}
              className="h-9 w-32 rounded-md border border-border bg-input/60 px-3 font-mono text-sm normal-case tracking-normal"
            />
            <button
              type="button"
              onClick={applyHex}
              className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              Apply
            </button>
            {isHexColor(value) ? (
              <span
                aria-label={`Current colour ${value}`}
                className="h-6 w-6 rounded-full border border-foreground/10"
                style={{ backgroundColor: value }}
              />
            ) : null}
          </div>
        </label>
        {hexError ? (
          <p className="mt-1 text-xs text-destructive">{hexError}</p>
        ) : null}
      </div>
    </div>
  );
}
