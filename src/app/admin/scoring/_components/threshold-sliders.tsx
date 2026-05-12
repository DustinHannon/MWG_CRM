"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { setScoringThresholdsAction } from "../actions";

/**
 * three coupled inputs for hot / warm / cool with the
 * server-side ordering invariant (hot > warm > cool) enforced both
 * here and via the DB CHECK constraint. Local state lets admins drag
 * past invalid intermediate values; "Save" is disabled until valid.
 */
export function ThresholdSliders({
  initial,
}: {
  initial: { hot: number; warm: number; cool: number };
}) {
  const [hot, setHot] = useState(initial.hot);
  const [warm, setWarm] = useState(initial.warm);
  const [cool, setCool] = useState(initial.cool);
  const [pending, startTransition] = useTransition();

  const valid = hot > warm && warm > cool;
  const dirty =
    hot !== initial.hot || warm !== initial.warm || cool !== initial.cool;

  function save() {
    startTransition(async () => {
      const res = await setScoringThresholdsAction({
        hotThreshold: hot,
        warmThreshold: warm,
        coolThreshold: cool,
      });
      if (!res.ok) toast.error(res.error);
      else toast.success("Thresholds saved");
    });
  }

  return (
    <div className="mt-4 space-y-3">
      <Slider
        label="Hot"
        color="text-[var(--priority-very-high-fg)]"
        value={hot}
        min={cool + 2}
        max={500}
        onChange={setHot}
      />
      <Slider
        label="Warm"
        color="text-[var(--priority-medium-fg)]"
        value={warm}
        min={cool + 1}
        max={hot - 1}
        onChange={setWarm}
      />
      <Slider
        label="Cool"
        color="text-[var(--status-contacted-fg)]"
        value={cool}
        min={-100}
        max={warm - 1}
        onChange={setCool}
      />

      <div className="flex items-center gap-3 pt-2">
        <button
          type="button"
          onClick={save}
          disabled={pending || !dirty || !valid}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          Save thresholds
        </button>
        {!valid ? (
          <span className="text-xs text-destructive">
            Hot must be greater than Warm; Warm must be greater than Cool.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Slider({
  label,
  color,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  color: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-3 text-sm">
      <span className={`w-16 font-medium ${color}`}>{label}</span>
      <input
        type="range"
        min={Math.max(-100, Math.min(min, value))}
        max={Math.min(500, Math.max(max, value))}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1"
      />
      <input
        type="number"
        min={-100}
        max={500}
        value={value}
        onChange={(e) => onChange(Number(e.target.value || 0))}
        className="w-20 rounded border border-glass-border bg-input/40 px-2 py-1 text-right text-sm tabular-nums"
      />
    </label>
  );
}
