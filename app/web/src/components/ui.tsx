"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { addrUrl, txUrl } from "@/lib/chain";
import { short } from "@/lib/format";
import type { DataSource, VaultStatus } from "@/lib/types";
import { IconAlert, IconCheck, IconCopy, IconExternal, IconSnow } from "./icons";

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function StatusPill({ status, size = "md" }: { status: VaultStatus; size?: "sm" | "md" }) {
  const map = {
    ACTIVE: { cls: "text-good bg-good-soft", icon: <IconCheck size={12} strokeWidth={2.4} />, t: "Active" },
    FROZEN: { cls: "text-ice bg-ice-soft", icon: <IconSnow size={12} strokeWidth={2.2} />, t: "Frozen" },
    FIRED: { cls: "text-bad bg-bad-soft", icon: <IconAlert size={12} strokeWidth={2.2} />, t: "Fired" },
  }[status];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full font-medium ${map.cls} ${size === "sm" ? "h-[22px] px-2 text-[11.5px]" : "h-[26px] px-2.5 text-[12.5px]"}`}>
      {map.icon}
      {map.t}
    </span>
  );
}

/** Small tinted chip, as in the reference ("+18.2%", "Paid", "Pending"). */
export function Chip({ tone = "grey", children, className = "" }: { tone?: "good" | "bad" | "grey" | "ink" | "ice"; children: ReactNode; className?: string }) {
  const cls = { good: "bg-good-soft text-good", bad: "bg-bad-soft text-bad", grey: "bg-bg-3 text-ink-2", ink: "bg-ink text-bg", ice: "bg-ice-soft text-ice" }[tone];
  return <span className={`inline-flex h-[22px] items-center whitespace-nowrap rounded-full px-2 text-[11.5px] font-medium ${cls} ${className}`}>{children}</span>;
}

/** Pill segmented control with a sliding white thumb. Buttons keep aria-pressed (or role=tab + aria-selected). */
export function Segmented<T extends string>({ value, onChange, options, label, tabs = false, className = "" }: {
  value: T; onChange: (v: T) => void; options: { v: T; label: ReactNode }[]; label: string; tabs?: boolean; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const b = ref.current?.querySelector<HTMLButtonElement>(`[data-v="${value}"]`);
      if (b) setThumb({ x: b.offsetLeft, w: b.offsetWidth });
    };
    place();
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [value, options.length]);
  return (
    <div ref={ref} role={tabs ? "tablist" : "group"} aria-label={label} className={`seg ${className}`}>
      {thumb && <span className="thumb" aria-hidden style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }} />}
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          data-v={o.v}
          {...(tabs ? { role: "tab", "aria-selected": value === o.v } : { "aria-pressed": value === o.v })}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Round white icon button (the reference's bell / plus / back). */
export function RoundButton({ label, children, onClick, className = "" }: { label: string; children: ReactNode; onClick?: () => void; className?: string }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className={`grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface text-ink transition-transform duration-150 active:scale-95 ${className}`}>
      {children}
    </button>
  );
}

/** A number with its decimals in light grey ("$248" + ".9k"). */
export function Num({ value, className = "" }: { value: string; className?: string }) {
  const m = value.match(/^([^.]*)(\.\d+)(.*)$/);
  return (
    <span className={`num ${className}`}>
      {m ? (<>{m[1]}<span className="dim">{m[2]}{m[3]}</span></>) : value}
    </span>
  );
}

export function Address({ value, kind = "address", chars = 4, className = "" }: { value: string; kind?: "address" | "tx"; chars?: number; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-[12.5px] ${className}`}>
      <a href={kind === "tx" ? txUrl(value) : addrUrl(value)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-ink hover:underline" title={value}>
        {short(value, chars)}
        <IconExternal size={12} className="opacity-60" />
      </a>
      <button
        type="button"
        className="grid h-6 w-6 place-items-center rounded text-ink-3 transition-colors hover:bg-bg-3 hover:text-ink"
        onClick={() => {
          navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
        aria-label={copied ? "Copied" : `Copy ${kind}`}
      >
        {copied ? <IconCheck size={13} className="text-good" /> : <IconCopy size={13} />}
      </button>
    </span>
  );
}

/** Bond as % of NAV against the floor (minBondBps) and the fire line (half of it). Black fill, white tick marks. */
export function BondMeter({ bondBps, minBondBps, compact = false }: { bondBps: number | null; minBondBps: number; compact?: boolean }) {
  const floor = minBondBps / 100; // percent
  const fire = floor / 2;
  const v = bondBps == null ? null : bondBps / 100;
  const max = Math.max(floor * 3, (v ?? 0) * 1.15, 1);
  const pos = (x: number) => `${Math.min(100, Math.max(0, (x / max) * 100))}%`;
  const tone = v == null ? "bg-ink-3" : v < fire ? "bg-bad" : v < floor ? "bg-ice" : "bg-ink";
  return (
    <div className="w-full" role="meter" aria-valuenow={v ?? undefined} aria-valuemin={0} aria-valuemax={max} aria-label={`Bond ${v?.toFixed(2) ?? "unknown"}% of NAV, floor ${floor}%, fire line ${fire}%`}>
      <div className={`relative rounded-full bg-bg-3 ${compact ? "h-1" : "h-1.5"}`}>
        <div className={`absolute inset-y-0 left-0 rounded-full ${tone} transition-[width] duration-700 ease-[var(--ease-out-quart)]`} style={{ width: v == null ? 0 : pos(v) }} />
        {!compact && <span className="absolute -inset-y-1 w-[2px] -translate-x-1/2 rounded bg-surface shadow-[0_0_0_1px_var(--line-2)]" style={{ left: pos(floor) }} />}
        {!compact && <span className="absolute -inset-y-1 w-[2px] -translate-x-1/2 rounded bg-surface shadow-[0_0_0_1px_var(--bad)]" style={{ left: pos(fire) }} />}
      </div>
      {!compact && (
        <div className="relative mt-1.5 h-4 text-[11px] text-ink-2">
          <span className="absolute -translate-x-1/2 whitespace-nowrap text-bad" style={{ left: pos(fire) }}>fire {fire}%</span>
          <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: pos(floor) }}>floor {floor}%</span>
        </div>
      )}
    </div>
  );
}

export function SourceBadge({ source, head }: { source?: DataSource; head?: number }) {
  if (!source) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-2" title={source === "db" ? "Indexed by the Hurdle worker (Postgres) + live eth_call" : "Read straight from the chain (eth_getLogs + eth_call)"}>
      <span className={`h-1.5 w-1.5 rounded-full ${source === "db" ? "bg-good" : "bg-bar"}`} />
      {source === "db" ? "Indexed" : "Direct RPC"}
      {head ? <span className="num">· block {head.toLocaleString("en-US")}</span> : null}
    </span>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`skeleton block ${className}`} />;
}

export function Panel({ title, aside, children, className = "", id }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={`card ${className}`}>
      {(title || aside) && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4 sm:px-5">
          {title && <h2 className="text-[16px] font-semibold tracking-[-0.02em]">{title}</h2>}
          {aside}
        </div>
      )}
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

export function KV({ k, v, hint }: { k: ReactNode; v: ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 text-[14px]">
      <span className="text-ink-2" title={hint}>{k}</span>
      <span className="num text-right font-medium">{v}</span>
    </div>
  );
}

export const btn = {
  primary:
    "inline-flex items-center justify-center gap-2 rounded-full bg-ink px-5 h-12 text-[15px] font-medium text-bg transition-[opacity,transform,background-color] duration-150 hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-bg-3 disabled:text-ink-3 disabled:opacity-100",
  ink:
    "inline-flex items-center justify-center gap-2 rounded-full bg-ink px-5 h-11 text-[15px] font-medium text-bg transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40",
  ghost:
    "inline-flex items-center justify-center gap-2 rounded-full bg-surface px-4 h-10 text-[14px] font-medium text-ink transition-[background-color,transform] duration-150 hover:bg-bg-2 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50",
};

export const inputCls =
  "num h-12 w-full rounded-2xl border border-transparent bg-bg-2 px-4 text-[16px] text-ink outline-none transition-colors placeholder:text-ink-3 hover:border-line-2 focus:border-ink focus:bg-surface";

export function SignedValue({ v, children, className = "" }: { v: number | null | undefined; children: ReactNode; className?: string }) {
  const cls = v == null || Math.abs(v) < 5e-6 ? "text-ink" : v > 0 ? "text-good" : "text-bad";
  return <span className={`num ${cls} ${className}`}>{children}</span>;
}

export function Note({ tone = "info", children }: { tone?: "info" | "warn" | "bad" | "good"; children: ReactNode }) {
  const map = {
    info: "bg-bg-2 text-ink-2",
    warn: "bg-ice-soft text-ink",
    bad: "bg-bad-soft text-ink",
    good: "bg-good-soft text-ink",
  }[tone];
  return <div className={`rounded-2xl px-3.5 py-3 text-[13.5px] leading-snug ${map}`}>{children}</div>;
}
