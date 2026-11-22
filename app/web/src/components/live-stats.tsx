"use client";

import Link from "next/link";
import { useOverview } from "@/lib/hooks";
import { fmtNum, fmtUsd } from "@/lib/format";
import { UnitToggle, markPrice } from "@/lib/unit";
import { SourceBadge, Skeleton } from "./ui";
import { VaultList, VaultListSkeleton } from "./vault-list";
import { IconArrow } from "./icons";

export function LiveScoreboard() {
  const { data, error } = useOverview();
  const s = data?.stats;
  const cells = [
    { k: "Vaults", v: s ? fmtNum(s.vaults) : null },
    { k: "TVL", v: s ? fmtUsd(s.tvlUsd) : null, sub: s ? `${fmtNum(s.tvlEth, 3)} mWETH` : "" },
    { k: "Shortfall paid to depositors", v: s ? fmtUsd(s.shortfallPaidUsd) : null },
    { k: "Carry earned by curators", v: s ? fmtUsd(s.carryUsd) : null },
    { k: "ETH price (pool spot)", v: data ? `$${fmtNum(data.pool.price, 0)}` : null, sub: data?.pool.twapPrice ? `TWAP $${fmtNum(data.pool.twapPrice, 0)} (NAV is marked here)` : "" },
  ];
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-ink">Live on Unichain Sepolia</h2>
        {error ? <span className="text-[12px] text-bad">Chain read failed: {(error as Error).message}</span> : <SourceBadge source={data?.source} head={data?.head} />}
      </div>
      <dl className="grid grid-cols-2 border-y border-line sm:grid-cols-3 lg:grid-cols-5">
        {cells.map((c, i) => (
          <div key={c.k} className={`py-4 pr-4 ${i > 0 ? "lg:border-l lg:border-line lg:pl-5" : ""} ${i % 2 === 1 ? "max-sm:border-l max-sm:border-line max-sm:pl-4" : ""} ${i >= 2 ? "max-sm:border-t max-sm:border-line" : ""}`}>
            <dt className="text-[12.5px] text-ink-2">{c.k}</dt>
            <dd className="num mt-1 text-[22px] font-semibold tracking-tight">{c.v ?? <Skeleton className="mt-1 h-6 w-20" />}</dd>
            {c.sub ? <dd className="num text-[12px] text-ink-2">{c.sub}</dd> : null}
          </div>
        ))}
      </dl>
    </div>
  );
}

export function LiveVaults() {
  const { data } = useOverview();
  return (
    <div>
      <div className="mb-3 flex items-end justify-between gap-3">
        <h2 className="text-[22px] font-semibold tracking-tight">Vaults right now</h2>
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
          <UnitToggle />
          <Link href="/vaults" className="inline-flex items-center gap-1 text-[14px] font-medium hover:underline">
            All vaults <IconArrow size={14} />
          </Link>
        </div>
      </div>
      {data ? <VaultList vaults={data.vaults.slice(0, 4)} price={markPrice(data.pool)} compact /> : <VaultListSkeleton />}
    </div>
  );
}
