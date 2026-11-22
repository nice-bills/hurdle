"use client";

import { useId, useMemo, useRef, useState, useEffect, type ReactNode } from "react";

export type Line = {
  id: string;
  label: string;
  values: number[];
  color: string; // css color
  kind: "par" | "solid" | "dash";
  width?: number;
};
export type Marker = { t: number; label: string; tone: "bad" | "ink" };

type Props = {
  t: number[];
  lines: Line[];
  height?: number;
  /** fractional index up to which lines are drawn (playback); default all */
  pos?: number;
  markers?: Marker[];
  yFormat?: (v: number) => string;
  xFormat?: (t: number) => string;
  tooltip?: (i: number) => ReactNode;
  /** shade the area below the par line */
  belowPar?: boolean;
  ariaLabel: string;
  dots?: boolean;
  fixedDomain?: [number, number];
  includeZero?: boolean;
  /** axis titles: unit and basis of the y axis, what the x axis is */
  yTitle?: string;
  xTitle?: string;
};

function nice(lo: number, hi: number) {
  const span = hi - lo || Math.abs(hi) * 0.01 || 0.001;
  const pad = span * 0.12;
  lo -= pad;
  hi += pad;
  const raw = (hi - lo) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-12; v += step) ticks.push(+v.toPrecision(12));
  return { lo, hi, ticks };
}

export function ParChart({ t, lines, height = 300, pos, markers = [], yFormat = (v) => v.toFixed(2), xFormat, tooltip, belowPar, ariaLabel, dots, fixedDomain, includeZero = true, yTitle, xTitle }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const uid = useId().replace(/:/g, "");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const N = t.length;
  const end = pos == null ? N - 1 : Math.min(N - 1, pos);
  const dom = useMemo(() => {
    if (fixedDomain) return nice(fixedDomain[0], fixedDomain[1]);
    const all = lines.flatMap((l) => l.values).filter(Number.isFinite);
    const z = includeZero ? [0] : [];
    return nice(Math.min(...all, ...z), Math.max(...all, ...z));
  }, [lines, fixedDomain, includeZero]);

  const narrow = w < 520;
  const g = { l: narrow ? 46 : 56, r: 14, t: yTitle ? 30 : 14, b: 26 };
  const iw = Math.max(1, w - g.l - g.r), ih = height - g.t - g.b;
  const t0 = t[0] ?? 0, t1 = t[N - 1] ?? 1;
  const X = (ts: number) => g.l + (t1 === t0 ? iw / 2 : ((ts - t0) / (t1 - t0)) * iw);
  const Y = (v: number) => g.t + ((dom.hi - v) / (dom.hi - dom.lo)) * ih;
  const interp = (arr: number[], p: number) => {
    if (!arr.length) return 0;
    p = Number.isFinite(p) ? Math.max(0, p) : arr.length - 1;
    const i = Math.floor(p), f = p - i;
    return i >= arr.length - 1 ? arr[arr.length - 1] : arr[i] + (arr[i + 1] - arr[i]) * f;
  };
  const pts = (vals: number[]) => {
    const o: [number, number][] = [];
    const n = Math.floor(end);
    for (let i = 0; i <= n && i < vals.length; i++) o.push([X(t[i]), Y(vals[i])]);
    if (end > n && n < vals.length - 1) o.push([X(interp(t, end)), Y(interp(vals, end))]);
    return o;
  };
  const path = (p: [number, number][]) => p.map((q, i) => `${i ? "L" : "M"}${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join("");

  const par = lines.find((l) => l.kind === "par");
  const xTicks = useMemo(() => {
    if (N < 2 || !xFormat) return [];
    const count = narrow ? 3 : 6;
    return Array.from({ length: count }, (_, k) => t0 + ((t1 - t0) * k) / (count - 1));
  }, [N, t0, t1, narrow, xFormat]);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (N < 2) return;
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const x = e.clientX - r.left;
    let best = 0, bd = Infinity;
    for (let i = 0; i <= Math.floor(end); i++) {
      const d = Math.abs(X(t[i]) - x);
      if (d < bd) { bd = d; best = i; }
    }
    setHover(best);
  };

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height: height + (xTitle ? 18 : 0) }}>
      {w > 0 && (
        <svg
          width={w}
          height={height}
          role="img"
          aria-label={ariaLabel}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          className="block touch-pan-y"
        >
          <defs>
            <pattern id={`hatch-${uid}`} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
              <rect width="8" height="8" fill="var(--bar)" />
              <rect width="3" height="8" fill="var(--surface)" opacity=".5" />
            </pattern>
          </defs>
          {yTitle && (
            <text x={g.l - (narrow ? 40 : 50)} y={11} className="fill-ink-2 text-[11.5px] font-medium">{yTitle}</text>
          )}
          {dom.ticks.map((v) => (
            <g key={v}>
              <line x1={g.l} x2={w - g.r} y1={Y(v)} y2={Y(v)} stroke={Math.abs(v) < 1e-12 ? "var(--line-2)" : "var(--grid)"} />
              <text x={g.l - 8} y={Y(v) + 4} textAnchor="end" className="num fill-ink-2 text-[11px]">{yFormat(v)}</text>
            </g>
          ))}
          {xTicks.map((ts, k) => (
            <text key={k} x={X(ts)} y={height - 6} textAnchor={k === 0 ? "start" : k === xTicks.length - 1 ? "end" : "middle"} className="num fill-ink-2 text-[11px]">
              {xFormat!(ts)}
            </text>
          ))}
          {belowPar && par && pts(par.values).length > 1 && (
            <path d={`${path(pts(par.values))}L${pts(par.values).at(-1)![0]} ${g.t + ih}L${pts(par.values)[0][0]} ${g.t + ih}Z`} fill="var(--bad-soft)" />
          )}
          {par && pts(par.values).length > 1 && (
            <path d={path(pts(par.values))} fill="none" stroke={`url(#hatch-${uid})`} strokeWidth={par.width ?? 7} strokeLinejoin="round" strokeLinecap="round" />
          )}
          {lines.filter((l) => l.kind !== "par").map((l) => {
            const p = pts(l.values);
            if (p.length < 2) return null;
            return (
              <g key={l.id}>
                <path d={path(p)} fill="none" stroke={l.color} strokeWidth={l.width ?? (l.kind === "dash" ? 1.6 : 2.4)} strokeDasharray={l.kind === "dash" ? "5 4" : undefined} strokeLinejoin="round" />
                {l.kind === "solid" && <circle cx={p.at(-1)![0]} cy={p.at(-1)![1]} r={3.5} fill={l.color} />}
                {dots && l.kind === "solid" && p.map((q, i) => <circle key={i} cx={q[0]} cy={q[1]} r={2} fill={l.color} />)}
              </g>
            );
          })}
          {markers.filter((m) => N > 1 && m.t <= interp(t, end) + 1e-9).map((m, k) => {
            const x = X(m.t);
            const right = x > w * 0.6;
            return (
              <g key={k}>
                <line x1={x} x2={x} y1={g.t} y2={g.t + ih} stroke={m.tone === "bad" ? "var(--bad)" : "var(--ink-3)"} strokeWidth={1.5} strokeDasharray="5 4" />
                <text x={x + (right ? -6 : 6)} y={g.t + 12 + k * 15} textAnchor={right ? "end" : "start"} className="text-[12px] font-semibold" style={{ fill: m.tone === "bad" ? "var(--bad)" : "var(--ink-2)", paintOrder: "stroke", stroke: "var(--surface)", strokeWidth: 3 }}>
                  {m.label}
                </text>
              </g>
            );
          })}
          {pos != null && N > 1 && Number.isFinite(X(interp(t, end))) && <line x1={X(interp(t, end))} x2={X(interp(t, end))} y1={g.t} y2={g.t + ih} stroke="var(--ink-3)" opacity={0.5} />}
          {hover != null && (
            <g>
              <line x1={X(t[hover])} x2={X(t[hover])} y1={g.t} y2={g.t + ih} stroke="var(--ink-2)" strokeWidth={1} />
              {lines.map((l) => (
                <circle key={l.id} cx={X(t[hover])} cy={Y(l.values[hover])} r={4} fill="var(--surface)" stroke={l.kind === "par" ? "var(--bar)" : l.color} strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
      )}
      {xTitle && w > 0 && <div className="absolute inset-x-0 bottom-0 pr-3 text-right text-[11px] text-ink-2">{xTitle}</div>}
      {hover != null && tooltip && w > 0 && (
        <div
          className="pointer-events-none absolute top-2 z-[var(--z-menu)] min-w-[180px] rounded-lg border border-line bg-surface px-3 py-2 text-[12.5px] shadow-card"
          style={X(t[hover]) > w / 2 ? { right: w - X(t[hover]) + 12 } : { left: X(t[hover]) + 12 }}
        >
          {tooltip(hover)}
        </div>
      )}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color?: string; kind: "par" | "solid" | "dash" | "area" }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-ink-2">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          {it.kind === "par" ? (
            <span className="bar-hatch h-[6px] w-6 rounded-full" />
          ) : it.kind === "area" ? (
            <span className="h-2.5 w-3.5 rounded-sm bg-bad-soft outline outline-1 outline-bad/40" />
          ) : (
            <span className="w-6" style={{ borderTop: `${it.kind === "dash" ? 2 : 3}px ${it.kind === "dash" ? "dashed" : "solid"} ${it.color}` }} />
          )}
          {it.label}
        </span>
      ))}
    </div>
  );
}
