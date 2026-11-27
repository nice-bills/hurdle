"use client";

import Link from "next/link";
import { DEPOSIT_WINDOW } from "@/lib/chain";
import { fmtDuration, fmtSignedPct, short } from "@/lib/format";
import { BOND_IS_WETH } from "@/lib/chain";
import { money, useUnit, type Unit } from "@/lib/unit";
import type { VaultSummary } from "@/lib/types";
import { BondMeter, Chip, StatusPill, useNow } from "./ui";

export function epochInfo(v: Pick<VaultSummary, "epochStart" | "epochSeconds" | "fired">, now: number) {
  const end = v.epochStart + v.epochSeconds;
  const due = v.epochStart > 0 && now >= end;
  const windowOpen = v.epochStart > 0 && (now <= v.epochStart + DEPOSIT_WINDOW || due);
  return { end, due, windowOpen, left: end - now, windowLeft: v.epochStart + DEPOSIT_WINDOW - now };
}

export function vaultName(v: Pick<VaultSummary, "label" | "address">) {
  return v.label ?? `Vault ${short(v.address, 3)}`;
}

/** Depositors and strategy minus par, in points of starting capital, in the chosen unit's basis. */
export function vsPar(v: Pick<VaultSummary, "cumulative">, unit: Unit) {
  const c = v.cumulative;
  if (!c) return null;
  return unit === "usd"
    ? { you: c.depositorUsd - c.parUsd, strat: c.strategyUsd - c.parUsd, youAbs: c.depositorUsd - 1, parAbs: c.parUsd - 1, stratAbs: c.strategyUsd - 1 }
    : { you: c.depositor - c.par, strat: c.strategy - c.par, youAbs: c.depositor - 1, parAbs: c.par - 1, stratAbs: c.strategy - 1 };
}

/** "+0.05 pts": a gap to par in points of starting capital. */
export const fmtPts = (f: number | null | undefined, d = 2) => fmtSignedPct(f, d).replace("%", " pts");

export function Monogram({ name, size = 36 }: { name: string; size?: number }) {
  return (
    <span aria-hidden className="grid shrink-0 place-items-center rounded-full bg-bg-2 font-semibold text-ink" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {name.replace(/^Vault /, "")[0]?.toUpperCase()}
    </span>
  );
}

/** One vault as a card (the reference's Projects card): name, bond against its floor, you vs par, the hour clock. */
export function VaultCard({ v, price, bondIsWeth = BOND_IS_WETH, compact = false }: { v: VaultSummary; price: number; bondIsWeth?: boolean; compact?: boolean }) {
  const now = useNow(1000);
  const { unit } = useUnit();
  const e = epochInfo(v, now);
  const g = vsPar(v, unit);
  const name = vaultName(v);
  return (
    <Link
      href={`/vaults/${v.address}`}
      className="card group block p-4 transition-transform duration-200 ease-[var(--ease-out-quart)] hover:-translate-y-0.5"
    >
      <div className="flex items-center gap-3">
        <Monogram name={name} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-medium">{name}</div>
          <div className="truncate text-[12px] text-ink-3">{v.note ? v.note.split(",")[0] : `curator ${short(v.curator)}`}</div>
        </div>
        <StatusPill status={v.status} size="sm" />
      </div>

      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          <div className="text-[12px] text-ink-2">You vs par</div>
          <div className="num text-[24px] font-medium leading-tight tracking-[-0.03em]">{g ? fmtPts(g.you) : <span className="text-[15px] text-ink-2">no settle yet</span>}</div>
        </div>
        <div className="text-right">
          <div className="text-[12px] text-ink-2">Deposits</div>
          <div className="num text-[15px] font-medium">{money(v.nav, price, unit, 4, bondIsWeth)}</div>
        </div>
      </div>

      <div className="mt-4 flex justify-between text-[12px]">
        <span><b className="num font-medium">{v.bondBps != null ? `${(v.bondBps / 100).toFixed(2)}%` : "–"}</b> <span className="text-ink-3">bond of deposits</span></span>
        <span className="text-ink-2">floor {v.minBondBps / 100}%</span>
      </div>
      <div className="mt-1.5"><BondMeter bondBps={v.bondBps} minBondBps={v.minBondBps} compact /></div>

      <div className="mt-3.5 flex items-center justify-between gap-2 text-[12px] text-ink-2">
        <span className="num">{v.totals.settlements ? `${v.totals.beats} of ${v.totals.settlements} hours beat par` : "first settle pending"}</span>
        {v.fired ? (
          <Chip>{v.parked ? "Parked passive" : "Parking"}</Chip>
        ) : e.due ? (
          <Chip tone="ink">Settle due</Chip>
        ) : !compact && e.windowOpen ? (
          <Chip tone="good">Deposits open · {fmtDuration(e.windowLeft)}</Chip>
        ) : (
          <Chip><span className="num">Settles in {fmtDuration(e.left)}</span></Chip>
        )}
      </div>
    </Link>
  );
}

/** `price` = USD per ETH at the hook TWAP (what the contract marks NAV at). */
export function VaultList({ vaults, price, compact = false, bondIsWeth = BOND_IS_WETH }: { vaults: VaultSummary[]; price: number; compact?: boolean; bondIsWeth?: boolean }) {
  return (
    <ul className={`grid gap-2.5 ${compact ? "" : "sm:grid-cols-2 lg:grid-cols-3"}`}>
      {vaults.map((v) => (
        <li key={v.address}>
          <VaultCard v={v} price={price} bondIsWeth={bondIsWeth} compact={compact} />
        </li>
      ))}
    </ul>
  );
}

export function VaultListSkeleton({ rows = 2, compact = false }: { rows?: number; compact?: boolean }) {
  return (
    <div className={`grid gap-2.5 ${compact ? "" : "sm:grid-cols-2 lg:grid-cols-3"}`} aria-busy="true" aria-label="Loading vaults">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="card p-4">
          <div className="flex items-center gap-3"><span className="skeleton block h-9 w-9 rounded-full" /><span className="skeleton block h-4 w-32" /></div>
          <span className="skeleton mt-5 block h-6 w-24" />
          <span className="skeleton mt-5 block h-1 w-full" />
        </div>
      ))}
    </div>
  );
}
