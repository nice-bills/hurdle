"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useOverview } from "@/lib/hooks";
import { fmtNum, fmtUsd } from "@/lib/format";
import { UnitToggle, markPrice } from "@/lib/unit";
import type { VaultStatus } from "@/lib/types";
import { VaultList, VaultListSkeleton } from "@/components/vault-list";
import { Note, Segmented, SourceBadge, StatusPill, btn } from "@/components/ui";

const FILTERS: ("ALL" | VaultStatus)[] = ["ALL", "ACTIVE", "FROZEN", "FIRED"];

export function VaultsExplorer() {
  const { data, error, isLoading } = useOverview();
  const [f, setF] = useState<(typeof FILTERS)[number]>("ALL");
  const list = useMemo(() => (data ? data.vaults.filter((v) => f === "ALL" || v.status === f) : []), [data, f]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: 0, ACTIVE: 0, FROZEN: 0, FIRED: 0 };
    data?.vaults.forEach((v) => { c.ALL++; c[v.status]++; });
    return c;
  }, [data]);

  return (
    <div className="pt-8 sm:pt-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[clamp(2rem,4vw,2.6rem)] font-medium leading-tight tracking-[-0.04em]">Vaults</h1>
          <p className="mt-1 max-w-[62ch] text-ink-2">
            Every vault created by the factory on the canonical Hurdle hook. Each one is measured against the same par: the
            pool&apos;s passive full-range LP.
          </p>
        </div>
        <Link href="/create" className={btn.ghost}>Create a vault</Link>
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          tabs
          label="Filter by status"
          value={f}
          onChange={setF}
          className="max-w-full overflow-x-auto"
          options={FILTERS.map((x) => ({
            v: x,
            label: (
              <>
                {x === "ALL" ? "All" : x[0] + x.slice(1).toLowerCase()} <span className="num text-ink-3">{counts[x]}</span>
              </>
            ),
          }))}
        />
        <div className="flex flex-wrap items-center gap-4 text-[13px] text-ink-2">
          <UnitToggle />
          {data && <span className="num">TVL {fmtUsd(data.stats.tvlUsd)} · ETH ${fmtNum(data.pool.price, 0)}</span>}
          <SourceBadge source={data?.source} head={data?.head} />
        </div>
      </div>

      <div className="mt-4">
        {error ? (
          <Note tone="bad">Could not load vaults: {(error as Error).message}. The RPC may be rate limiting; this page retries every 20 s.</Note>
        ) : isLoading || !data ? (
          <VaultListSkeleton rows={3} />
        ) : list.length ? (
          <VaultList vaults={list} price={markPrice(data.pool)} />
        ) : (
          <div className="card px-6 py-12 text-center">
            <p className="font-semibold">No {f.toLowerCase()} vaults.</p>
            <p className="mt-1 text-ink-2">{f === "FIRED" ? "Nobody has been fired yet. That is the point." : "Try another filter, or create one."}</p>
          </div>
        )}
      </div>

      {data && data.legacyVaults.length > 0 && (
        <section className="mt-10" aria-label="Earlier deployment (v4)">
          <h2 className="text-[20px] font-semibold tracking-[-0.03em]">Earlier deployment (v4) — Reckless was fired on-chain</h2>
          <p className="mb-3 mt-1 max-w-[70ch] text-[13.5px] text-ink-2">
            The previous deployment, kept read-only as the fire showcase: Reckless v4 breached its bond and was fired on 2026-11-22 16:39 UTC.
            These vaults are priced on their own (v4) pool.
          </p>
          <VaultList vaults={data.legacyVaults} price={markPrice(data.legacyPool)} bondIsWeth={!data.legacyPool.wethIs0} />
        </section>
      )}

      <dl className="card mt-10 grid gap-4 text-[13.5px] sm:grid-cols-3">
        <div className="flex gap-3"><dt><StatusPill status="ACTIVE" size="sm" /></dt><dd className="text-ink-2">Bond at or above its floor. Deposits open in the first 5 minutes of each epoch.</dd></div>
        <div className="flex gap-3"><dt><StatusPill status="FROZEN" size="sm" /></dt><dd className="text-ink-2">Bond under the floor (NAV grew). No deposits or rebalances until the curator tops up.</dd></div>
        <div className="flex gap-3"><dt><StatusPill status="FIRED" size="sm" /></dt><dd className="text-ink-2">A miss left the bond under half the floor. The vault parked passive full range.</dd></div>
      </dl>
    </div>
  );
}
