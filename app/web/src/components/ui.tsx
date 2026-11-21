"use client";

import { useEffect, useState, type ReactNode } from "react";
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
    ACTIVE: { cls: "text-good bg-good-soft border-good/30", icon: <IconCheck size={12} strokeWidth={2.4} />, t: "Active" },
    FROZEN: { cls: "text-ice bg-ice-soft border-ice/30", icon: <IconSnow size={12} strokeWidth={2.2} />, t: "Frozen" },
    FIRED: { cls: "text-bad bg-bad-soft border-bad/35", icon: <IconAlert size={12} strokeWidth={2.2} />, t: "Fired" },
  }[status];
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border font-semibold uppercase tracking-[0.06em] ${map.cls} ${
        size === "sm" ? "px-2 py-0.5 text-[10.5px]" : "px-2.5 py-1 text-[11.5px]"
      }`}
    >
      {map.icon}
      {map.t}
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

/** Bond as % of NAV against the floor (minBondBps) and the fire line (half of it). */
export function BondMeter({ bondBps, minBondBps, compact = false }: { bondBps: number | null; minBondBps: number; compact?: boolean }) {
  const floor = minBondBps / 100; // percent
  const fire = floor / 2;
  const v = bondBps == null ? null : bondBps / 100;
  const max = Math.max(floor * 3, (v ?? 0) * 1.15, 1);
  const pos = (x: number) => `${Math.min(100, Math.max(0, (x / max) * 100))}%`;
  const tone = v == null ? "bg-ink-3" : v < fire ? "bg-bad" : v < floor ? "bg-ice" : "bg-good";
  return (
    <div className="w-full" role="meter" aria-valuenow={v ?? undefined} aria-valuemin={0} aria-valuemax={max} aria-label={`Bond ${v?.toFixed(2) ?? "unknown"}% of NAV, floor ${floor}%, fire line ${fire}%`}>
      <div className={`relative rounded-full bg-bg-3 ${compact ? "h-1.5" : "h-2.5"}`}>
        <div className={`absolute inset-y-0 left-0 rounded-full ${tone} transition-[width] duration-500 ease-[var(--ease-out-quart)]`} style={{ width: v == null ? 0 : pos(v) }} />
        <span className="absolute -inset-y-1 w-[2px] -translate-x-1/2 rounded bg-ice" style={{ left: pos(floor) }} />
        <span className="absolute -inset-y-1 w-[2px] -translate-x-1/2 rounded bg-bad" style={{ left: pos(fire) }} />
      </div>
      {!compact && (
        <div className="relative mt-1.5 h-4 text-[11px] text-ink-2">
          <span className="absolute -translate-x-1/2 whitespace-nowrap text-bad" style={{ left: pos(fire) }}>fire {fire}%</span>
          <span className="absolute -translate-x-1/2 whitespace-nowrap text-ice" style={{ left: pos(floor) }}>floor {floor}%</span>
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
    <section id={id} className={`rounded-xl border border-line bg-surface ${className}`}>
      {(title || aside) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 sm:px-5">
          {title && <h2 className="text-[15px] font-semibold">{title}</h2>}
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
    "inline-flex items-center justify-center gap-2 rounded-lg bg-bar px-4 h-11 text-[15px] font-semibold text-on-bar transition-[filter,transform] duration-150 hover:brightness-[1.04] active:translate-y-px disabled:cursor-not-allowed disabled:bg-bg-3 disabled:text-ink-3 disabled:brightness-100",
  ink:
    "inline-flex items-center justify-center gap-2 rounded-lg bg-ink px-4 h-11 text-[15px] font-semibold text-bg transition-[opacity,transform] duration-150 hover:opacity-90 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40",
  ghost:
    "inline-flex items-center justify-center gap-2 rounded-lg border border-line px-3.5 h-10 text-[14px] font-medium text-ink transition-colors duration-150 hover:border-line-2 hover:bg-bg-2 disabled:cursor-not-allowed disabled:opacity-50",
};

export const inputCls =
  "num h-11 w-full rounded-lg border border-line bg-bg px-3 text-[15px] text-ink outline-none transition-colors placeholder:text-ink-3 hover:border-line-2 focus:border-bar focus:ring-2 focus:ring-bar-soft";

export function SignedValue({ v, children, className = "" }: { v: number | null | undefined; children: ReactNode; className?: string }) {
  const cls = v == null || Math.abs(v) < 1e-9 ? "text-ink" : v > 0 ? "text-good" : "text-bad";
  return <span className={`num ${cls} ${className}`}>{children}</span>;
}

export function Note({ tone = "info", children }: { tone?: "info" | "warn" | "bad" | "good"; children: ReactNode }) {
  const map = {
    info: "border-line bg-bg-2 text-ink-2",
    warn: "border-ice/30 bg-ice-soft text-ink",
    bad: "border-bad/30 bg-bad-soft text-ink",
    good: "border-good/30 bg-good-soft text-ink",
  }[tone];
  return <div className={`rounded-lg border px-3 py-2.5 text-[13.5px] leading-snug ${map}`}>{children}</div>;
}
