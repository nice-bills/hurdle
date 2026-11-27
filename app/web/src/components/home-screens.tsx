"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useOverview } from "@/lib/hooks";
import { fmtNum, fmtSignedPct, fmtUsd } from "@/lib/format";
import { markPrice, useUnit } from "@/lib/unit";
import type { VaultSummary } from "@/lib/types";
import { Chip, Num, Skeleton, SourceBadge, StatusPill } from "./ui";
import { VaultList, VaultListSkeleton, fmtPts, vaultName, vsPar } from "./vault-list";
import { IconAlert, IconArrow, IconCheck, IconSnow } from "./icons";

/** A phone-shaped column on desktop; on a phone it is just the page. */
function Screen({ title, sub, action, children, id }: { title: string; sub?: string; action?: ReactNode; children: ReactNode; id: string }) {
  return (
    <section className="screen" aria-labelledby={id}>
      <div className="inner">
        <div className="mb-4 flex items-start gap-2 px-1">
          <div className="min-w-0 flex-1">
            <h2 id={id} className="text-[26px] font-semibold leading-tight tracking-[-0.035em]">{title}</h2>
            {sub ? <p className="mt-0.5 text-[13px] text-ink-2">{sub}</p> : null}
          </div>
          {action}
        </div>
        {children}
      </div>
    </section>
  );
}

/** The vault with the longest record that is still running: the one worth showing first. */
function featured(vs: VaultSummary[]) {
  const live = vs.filter((v) => !v.fired && v.cumulative);
  return [...(live.length ? live : vs)].sort((a, b) => b.totals.settlements - a.totals.settlements)[0];
}

function Row({ swatch, label, value, strong }: { swatch: ReactNode; label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      {swatch}
      <span className={`flex-1 text-[14px] ${strong ? "font-medium" : "text-ink-2"}`}>{label}</span>
      <span className="num text-[14px] font-medium"><Num value={value} /></span>
    </div>
  );
}

function OverviewScreen() {
  const { data, error } = useOverview();
  const { unit } = useUnit();
  const v = data ? featured(data.vaults) : null;
  const g = v ? vsPar(v, unit) : null;
  const s = data?.stats;
  return (
    <Screen id="s-overview" title="Overview" sub="Live on Unichain Sepolia" action={error ? null : <SourceBadge source={data?.source} head={data?.head} />}>
      {error ? <p className="card mb-2.5 p-4 text-[13px] text-bad">Chain read failed: {(error as Error).message}</p> : null}
      <Link href={v ? `/vaults/${v.address}` : "/vaults"} className="card block p-4">
        <div className="flex items-center justify-between gap-2 text-[12.5px] text-ink-2">
          <span>{v ? `${vaultName(v)} · you vs par` : "You vs par"}</span>
          {v ? <StatusPill status={v.status} size="sm" /> : null}
        </div>
        <div className="num mt-1.5 text-[38px] font-medium leading-tight tracking-[-0.035em]">
          {g ? <Num value={fmtPts(g.you)} /> : data ? <span className="text-[17px] text-ink-2">no settle yet</span> : <Skeleton className="mt-1 h-9 w-36" />}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {v ? (
            <>
              <Chip tone={v.totals.misses ? "grey" : "good"}>{v.totals.beats} of {v.totals.settlements} hours beat par</Chip>
              {v.totals.misses ? <Chip tone="bad">{v.totals.misses} paid by bond</Chip> : null}
            </>
          ) : null}
        </div>
        <div className="mt-3 divide-y divide-line">
          <Row swatch={<i className="h-[3px] w-4 rounded-full bg-you" />} label="You" strong value={g ? fmtSignedPct(g.youAbs) : "–"} />
          <Row swatch={<i className="bar-hatch h-[2px] w-4" />} label="Par (passive LP)" value={g ? fmtSignedPct(g.parAbs) : "–"} />
          <Row swatch={<i className="h-[2px] w-4 rounded-full bg-ink-3" />} label="Curator strategy" value={g ? fmtSignedPct(g.stratAbs) : "–"} />
        </div>
      </Link>
      <dl className="card mt-2.5 grid p-4 grid-cols-2 gap-x-4 gap-y-3.5">
        {[
          ["Deposits", s ? fmtUsd(s.tvlUsd) : null],
          ["Hours settled", s ? fmtNum(s.settlements) : null],
          ["Bond paid to you", s ? fmtUsd(s.shortfallPaidUsd) : null],
          ["Carry to curators", s ? fmtUsd(s.carryUsd) : null],
        ].map(([k, val]) => (
          <div key={k}>
            <dt className="text-[12px] text-ink-2">{k}</dt>
            <dd className="num mt-0.5 text-[19px] font-medium tracking-[-0.02em]">{val ? <Num value={val} /> : <Skeleton className="mt-1 h-5 w-16" />}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 px-1 text-[12px] text-ink-3">
        ETH {data ? `$${fmtNum(markPrice(data.pool), 0)}` : "…"} at the pool TWAP, where vaults are marked. Points are of starting capital.
      </p>
    </Screen>
  );
}

function VaultsScreen() {
  const { data } = useOverview();
  return (
    <Screen
      id="s-vaults"
      title="Vaults"
      sub={data ? `${data.vaults.length} curators with a bond up` : "Curators with a bond up"}
      action={
        <Link href="/vaults" className="inline-flex h-10 items-center gap-1 rounded-full bg-surface px-3.5 text-[13px] font-medium">
          All <IconArrow size={14} />
        </Link>
      }
    >
      {data ? <VaultList vaults={data.vaults.slice(0, 3)} price={markPrice(data.pool)} compact /> : <VaultListSkeleton rows={3} compact />}
    </Screen>
  );
}

function Rule({ tone, icon, head, body }: { tone: "good" | "bad" | "ice"; icon: ReactNode; head: string; body: string }) {
  const c = { good: "bg-good-soft text-good", bad: "bg-bad-soft text-bad", ice: "bg-ice-soft text-ice" }[tone];
  return (
    <li className="card flex gap-3 p-3.5">
      <span aria-hidden className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${c}`}>{icon}</span>
      <div>
        <div className="text-[14.5px] font-medium">{head}</div>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-2">{body}</p>
      </div>
    </li>
  );
}

function RulesScreen() {
  return (
    <Screen id="s-rules" title="How it settles" sub="Every hour, anyone can call settle()">
      <ul className="grid gap-2.5">
        <Rule tone="good" icon={<IconCheck size={16} strokeWidth={2.4} />} head="Beat par" body="The excess refills any bond paid out earlier. The curator keeps 20% of the rest as carry." />
        <Rule tone="bad" icon={<IconArrow size={16} className="rotate-90" />} head="Miss par" body="The bond pays you up to par. Deposits wait until the curator refills it." />
        <Rule tone="ice" icon={<IconSnow size={16} />} head="Bond under 2%" body="Deposits and rebalances freeze until the curator tops up the bond." />
        <Rule tone="bad" icon={<IconAlert size={16} />} head="Bond under 1% after a miss" body="The curator is fired. The vault goes 50/50 full range, where it simply is par." />
      </ul>
      <p className="mt-3 px-1 text-[12px] leading-snug text-ink-3">
        Par is a passive full-range LP, computed by the pool from its own fee growth and TWAP. No oracle, no self-reporting.
      </p>
    </Screen>
  );
}

export function HomeScreens() {
  return (
    <div className="grid gap-10 md:gap-4 lg:grid-cols-3">
      <OverviewScreen />
      <VaultsScreen />
      <RulesScreen />
    </div>
  );
}
