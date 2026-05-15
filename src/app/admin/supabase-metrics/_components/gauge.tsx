"use client";

interface GaugeProps {
  label: string;
  value: number;
  max?: number;
  unit?: string;
  thresholds?: { warn: number; danger: number };
}

const SIZE = 120;
const STROKE = 10;
const RADIUS = (SIZE - STROKE) / 2;
const CENTER = SIZE / 2;
// 270deg sweep, gap centered at the bottom.
const SWEEP_DEG = 270;
const START_DEG = 135;

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(r: number, startDeg: number, endDeg: number) {
  const start = polar(CENTER, CENTER, r, startDeg);
  const end = polar(CENTER, CENTER, r, endDeg);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

function sanitize(n: number) {
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function Gauge({ label, value, max = 100, unit, thresholds }: GaugeProps) {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
  const safeValue = Math.min(sanitize(value), safeMax);
  const ratio = safeMax > 0 ? safeValue / safeMax : 0;

  const warn = thresholds?.warn ?? 70;
  const danger = thresholds?.danger ?? 90;

  // Thresholds are expressed in the same unit as `value`.
  let arcColor = "var(--chart-2)";
  if (safeValue >= danger) {
    arcColor = "var(--destructive)";
  } else if (safeValue >= warn) {
    arcColor = "var(--chart-4)";
  }

  const endDeg = START_DEG + SWEEP_DEG * ratio;
  const trackPath = arcPath(RADIUS, START_DEG, START_DEG + SWEEP_DEG);
  const valuePath = arcPath(RADIUS, START_DEG, endDeg);

  const display = Number.isInteger(safeValue)
    ? String(safeValue)
    : safeValue.toFixed(1);

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative h-[120px] w-[120px]">
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="block"
          role="img"
          aria-label={`${label}: ${display}${unit ?? ""}`}
        >
          <path
            d={trackPath}
            fill="none"
            stroke="var(--border)"
            strokeWidth={STROKE}
            strokeLinecap="round"
          />
          {ratio > 0 ? (
            <path
              d={valuePath}
              fill="none"
              stroke={arcColor}
              strokeWidth={STROKE}
              strokeLinecap="round"
            />
          ) : null}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold tabular-nums text-foreground">
            {display}
            {unit ? (
              <span className="ml-0.5 text-xs text-muted-foreground">
                {unit}
              </span>
            ) : null}
          </span>
        </div>
      </div>
      <span className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        {label}
      </span>
    </div>
  );
}
