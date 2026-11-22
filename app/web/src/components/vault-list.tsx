"use client";

import Link from "next/link";
import { DEPOSIT_WINDOW } from "@/lib/chain";
import { fmtDuration, fmtSignedBp, short } from "@/lib/format";
import { money, moneyAlt, useUnit } from "@/lib/unit";
import type { VaultSummary } from "@/lib/types";
import { BondMeter, SignedValue, StatusPill, useNow } from "./ui";

export function epochInfo(v: Pick<VaultSummary, "epochStart" | "epochSeconds" | "fired">, now: number) {
  const end = v.epochStart + v.epochSeconds;
  const due = v.epochStart > 0 && now >= end;
  const windowOpen = v.epochStart > 0 && (now <= v.epochStart + DEPOSIT_WINDOW || due);
  return { end, due, windowOpen, left: end - now, windowLeft: v.epochStart + DEPOSIT_WINDOW - now };
}

export function vaultName(v: Pick<VaultSummary, "label" | "address">) {
  return v.label ?? `Vault ${short(v.address, 3)}`;
}

/** `price` = USD per ETH at the hook TWAP (what the contract marks NAV at). */
export function VaultList({ vaults, price, compact = false }: { vaults: VaultSummary[]; price: number; compact?: boolean }) {
  const now = useNow(1000);
  const { unit } = useUnit();
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="hidden grid-cols-[minmax(0,1.5fr)_0.8fr_1fr_1.2fr_0.9fr_1fr] gap-4 border-b border-line bg-bg-2 px-5 py-2.5 text-[12px] font-medium text-ink-2 lg:grid">
        <span>Vault</span>
        <span>Status</span>
        <span className="text-right">NAV ({unit === "usd" ? "USD" : "mWETH"})</span>
        <span>Bond / NAV</span>
        <span className="text-right">Last epoch vs par</span>
        <span className="text-right">Epoch</span>
      </div>
      <ul className="rows">
        {vaults.map((v) => {
          const e = epochInfo(v, now);
          return (
            <li key={v.address}>
              <Link
                href={`/vaults/${v.address}`}
                className="group grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-4 transition-colors duration-150 hover:bg-bg-2 sm:px-5 lg:grid-cols-[minmax(0,1.5fr)_0.8fr_1fr_1.2fr_0.9fr_1fr] lg:items-center"
              >
                <div className="col-span-2 flex min-w-0 items-center justify-between gap-3 lg:col-span-1">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-semibold">
                      <span className="truncate group-hover:underline">{vaultName(v)}</span>
                      <span className="text-[12px] font-normal text-ink-2">carry {v.carryBps / 100}%</span>
                    </div>
                    <div className="truncate text-[12.5px] text-ink-2">
                      <span className="font-mono">{short(v.address)}</span>
                      {v.note ? ` · ${v.note}` : ` · curator ${short(v.curator)}`}
                    </div>
                  </div>
                  <span className="lg:hidden"><StatusPill status={v.status} size="sm" /></span>
                </div>
                <div className="hidden lg:block"><StatusPill status={v.status} /></div>
                <div className="lg:text-right">
                  <div className="text-[11.5px] text-ink-2 lg:hidden">NAV</div>
                  <div className="num font-medium">{money(v.nav, price, unit)}</div>
                  <div className="num text-[12.5px] text-ink-2">{v.nav ? moneyAlt(v.nav, price, unit) : ""}</div>
                </div>
                <div>
                  <div className="text-[11.5px] text-ink-2 lg:hidden">Bond / NAV</div>
                  <div className="num mb-1.5 text-[13.5px] font-medium">{v.bondBps != null ? `${(v.bondBps / 100).toFixed(2)}%` : "–"}</div>
                  <BondMeter bondBps={v.bondBps} minBondBps={v.minBondBps} compact />
                </div>
                <div className="lg:text-right">
                  <div className="text-[11.5px] text-ink-2 lg:hidden">Last epoch vs par</div>
                  {v.lastSettle ? (
                    <SignedValue v={v.lastSettle.vsPar} className="font-medium">{fmtSignedBp(v.lastSettle.vsPar)}</SignedValue>
                  ) : (
                    <span className="text-ink-2">no settlement yet</span>
                  )}
                </div>
                <div className="lg:text-right">
                  <div className="text-[11.5px] text-ink-2 lg:hidden">Epoch</div>
                  {v.fired ? (
                    <span className="text-[13.5px] text-ink-2">parked passive</span>
                  ) : e.due ? (
                    <span className="text-[13.5px] font-semibold text-bar-ink">Settle due</span>
                  ) : (
                    <span className="num text-[13.5px] font-medium">{fmtDuration(e.left)}</span>
                  )}
                  {!compact && !v.fired && (
                    <div className={`text-[12px] ${e.windowOpen ? "text-good" : "text-ink-2"}`}>
                      {e.windowOpen ? (e.due ? "deposits open (settles first)" : `deposits open · ${fmtDuration(e.windowLeft)}`) : "deposits closed"}
                    </div>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function VaultListSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-6 border-b border-line px-5 py-5 last:border-0">
          <Skeleton w="w-40" />
          <Skeleton w="w-16" />
          <Skeleton w="ml-auto w-24" />
        </div>
      ))}
    </div>
  );
}
function Skeleton({ w }: { w: string }) {
  return <span className={`skeleton block h-4 ${w}`} />;
}
