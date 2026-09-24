import { useEffect, useId, useRef, useState } from "react";
import type { ChartView } from "../messages";

/**
 * The price chart: a line with a wash of colour under it, or candles.
 *
 * Plain SVG, no chart library. It has to read in both themes, at popup width
 * and at whatever width a side panel is dragged to, so it measures its own
 * container rather than assuming 328px.
 *
 * The dashed baseline is the range's first price, so "above the line" means
 * up over the period. Dragging or hovering scrubs: the caller is told which
 * point is under the pointer and shows the value at that moment.
 */

export type ChartStyle = "line" | "candles";

/** What sits under the pointer. Carries its own time and price, because the
 *  candles and the line are different series with different lengths: an
 *  index into one means nothing in the other. */
export interface HoverPoint {
  index: number;
  t: number;
  v: number;
}

export function PriceChart({
  chart,
  hover,
  onHover,
  style = "line",
  height = 104,
  axis = false,
}: {
  chart?: ChartView;
  hover?: number | null;
  onHover?: (p: HoverPoint | null) => void;
  style?: ChartStyle;
  height?: number;
  /** Price labels down the right edge. Off for the small inline charts,
   *  where there is no room and the number is already beside them. */
  axis?: boolean;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const gradientId = useId();
  // The line is drawn at the width it is given, so a wider panel gets a wider
  // chart rather than a 328px one with a gap beside it.
  const [width, setWidth] = useState(328);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry?.contentRect.width ?? 0);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const candles = style === "candles" ? chart?.candles ?? [] : [];
  const asCandles = candles.length > 1;
  const points = chart?.points ?? [];

  const empty = asCandles ? candles.length < 2 : points.length < 2;
  if (empty) {
    return (
      <div ref={box} style={{ width: "100%" }}>
        <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true" style={{ display: "block" }}>
          <path d={`M0 ${height / 2} H${width}`} style={{ fill: "none", stroke: "var(--border)", strokeWidth: 1.5, strokeDasharray: "2 5" }} />
        </svg>
      </div>
    );
  }

  const n = asCandles ? candles.length : points.length;
  const lows = asCandles ? candles.map((c) => c.l) : points.map((p) => p.v);
  const highs = asCandles ? candles.map((c) => c.h) : points.map((p) => p.v);
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const pad = 8;
  const span = max - min || max || 1;
  /**
   * Room for the prices, taken out of the plot rather than added beside it.
   *
   * Drawing the line the full width and putting labels over the end of it
   * hides the most recent price behind the number describing it, which is
   * the one part of the chart anybody is actually looking at.
   */
  const axisW = axis ? 46 : 0;
  const plotW = Math.max(1, width - axisW);
  const x = (i: number) => (i / (n - 1)) * plotW;
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);

  const up = (chart?.changePct ?? 0) >= 0;
  const color = up ? "var(--accent)" : "var(--danger-text)";
  const at = hover === null || hover === undefined ? null : Math.min(Math.max(hover, 0), n - 1);
  const baseline = asCandles ? candles[0]!.o : points[0]!.v;

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  // The same path, closed along the bottom, for the wash of colour under it.
  const area = `${line} L${plotW} ${height} L0 ${height} Z`;
  // Candle bodies get whatever width is left after a gap, down to a hairline.
  const slot = plotW / n;
  const bodyW = Math.max(1.5, Math.min(9, slot * 0.62));

  const scrub = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || !onHover) return;
    // Against the plot, not the whole svg: the axis is not part of the
    // series and scrubbing over it would read the wrong point.
    const plotPx = rect.width * (plotW / width);
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / plotPx));
    const index = Math.round(f * (n - 1));
    const sample = asCandles ? { t: candles[index]!.t, v: candles[index]!.c } : { t: points[index]!.t, v: points[index]!.v };
    onHover({ index, ...sample });
  };

  return (
    <div ref={box} style={{ width: "100%" }}>
      <svg
        ref={ref}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        style={{ display: "block", touchAction: "none", cursor: onHover ? "crosshair" : "default" }}
        role="img"
        aria-label={`PRL price, ${chart?.range ?? ""}, ${up ? "up" : "down"} ${Math.abs(chart?.changePct ?? 0).toFixed(2)} percent`}
        onPointerMove={scrub}
        onPointerDown={scrub}
        onPointerLeave={() => onHover?.(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="55%" stopColor={color} stopOpacity="0.09" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`M0 ${y(baseline).toFixed(1)} H${plotW}`} style={{ fill: "none", stroke: "var(--border)", strokeWidth: 1.5, strokeDasharray: "2 5" }} />
        {asCandles ? (
          candles.map((c, i) => {
            const rising = c.c >= c.o;
            const stroke = rising ? "var(--accent)" : "var(--danger-text)";
            const top = y(Math.max(c.o, c.c));
            const bottom = y(Math.min(c.o, c.c));
            return (
              <g key={c.t} style={{ stroke, fill: stroke }}>
                <path d={`M${x(i).toFixed(1)} ${y(c.h).toFixed(1)} V${y(c.l).toFixed(1)}`} style={{ strokeWidth: 1 }} />
                <rect x={x(i) - bodyW / 2} y={top} width={bodyW} height={Math.max(1, bottom - top)} style={{ strokeWidth: 1 }} />
              </g>
            );
          })
        ) : (
          <>
            <path d={area} style={{ fill: `url(#${gradientId})`, stroke: "none" }} />
            <path d={line} style={{ fill: "none", stroke: color, strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }} />
          </>
        )}
        {axis &&
          [max, min + span / 2, min].map((v, i) => (
            <text
              key={`${v}-${i}`}
              x={plotW + 6}
              // Nudged in from the edges so the top and bottom labels are
              // not half cut off by the box.
              y={i === 0 ? 9 : i === 2 ? height - 2 : height / 2 + 3}
              style={{ fill: "var(--text-3)", fontSize: 9.5 }}
              className="mono"
            >
              {usdtPrice(v)}
            </text>
          ))}
        {at !== null && (
          <>
            <path d={`M${x(at).toFixed(1)} 0 V${height}`} style={{ fill: "none", stroke: "var(--text-3)", strokeWidth: 1 }} />
            {!asCandles && <circle cx={x(at)} cy={y(points[at]!.v)} r={3.5} style={{ fill: color, stroke: "var(--bg)", strokeWidth: 1.5 }} />}
          </>
        )}
      </svg>
    </div>
  );
}

/** The line/candles switch that sits above the chart. */
export function ChartStyleToggle({ style, onStyle, disabled }: {
  style: ChartStyle;
  onStyle: (s: ChartStyle) => void;
  disabled?: boolean;
}) {
  const option = (id: ChartStyle, label: string, d: string) => (
    <button key={id} type="button" className="pill" aria-pressed={style === id} aria-label={label}
      title={disabled ? "No candles for this range" : label}
      disabled={disabled && id === "candles"}
      onClick={() => onStyle(id)}
      style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 22, padding: 0, borderRadius: 6 }}>
      <svg viewBox="0 0 24 24" width={15} height={15} aria-hidden="true" style={{ display: "block", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" }}>
        <path d={d} />
      </svg>
    </button>
  );
  return (
    <div style={{ display: "flex", gap: 2 }} role="group" aria-label="Chart style">
      {option("line", "Line", "M3 16l5-6 4 4 3-4 6 3")}
      {option("candles", "Candles", "M7 4v16M7 8h0M5 8h4v7H5zM17 4v16M15 7h4v9h-4z")}
    </div>
  );
}

/** "1,234.56" with two decimals, for USDT amounts. */
export function usdt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "0.8200" style price, four decimals like the design. */
export function usdtPrice(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

/** What a chart range covers, in words, for the change line. */
export const RANGE_TAIL: Record<string, string> = {
  "1D": "Today",
  "1W": "Past week",
  "1M": "Past month",
  "3M": "Past 3 months",
  ALL: "All time",
};

/** The moment under the pointer, kept short enough for one line: a time on
 *  the day chart, a date on the rest, a year only when the range spans them. */
export function pointLabel(tSeconds: number, range: string): string {
  const d = new Date(tSeconds * 1000);
  if (range === "1D") return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: range === "ALL" ? "numeric" : undefined });
}

/** Which unit the owner reads amounts in. Kept here so every screen can ask,
 *  rather than Home knowing and the others guessing. */
export type Denom = "usdt" | "prl";
export const DENOM_KEY = "oyster.denom";

export function readDenom(): Denom {
  try {
    return localStorage.getItem(DENOM_KEY) === "prl" ? "prl" : "usdt";
  } catch {
    return "usdt";
  }
}

export function writeDenom(d: Denom): void {
  try {
    localStorage.setItem(DENOM_KEY, d);
  } catch {
    /* private mode: the choice lasts as long as the window does */
  }
}
