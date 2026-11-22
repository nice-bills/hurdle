"use client";

import Link from "next/link";
import { useVaultDetail } from "@/lib/hooks";
import { txUrl } from "@/lib/chain";
import { ago, fmtDuration, fmtEth, fmtSignedBp, fmtSignedPct, fmtUsd, short, utc } from "@/lib/format";
import { UnitToggle, markPrice, money, moneyAlt, unitName, useUnit, type Unit } from "@/lib/unit";
import { KeeperRuns } from "@/components/keeper-runs";
import { usdPerEthFromSqrt } from "@/lib/math";
import type { VaultDetail, VaultEvent } from "@/lib/types";
import { ActionPanel } from "@/components/actions";
import { Legend, ParChart } from "@/components/par-chart";
import { RangeBar } from "@/components/range-bar";
import { Address, BondMeter, Note, Panel, SignedValue, Skeleton, SourceBadge, StatusPill, useNow } from "@/components/ui";
import { epochInfo, vaultName } from "@/components/vault-list";
import { IconAlert, IconExternal } from "@/components/icons";

export function VaultView({ address }: { address: string }) {
  const { data, error, isLoading } = useVaultDetail(address);
  if (error && !data)
    return (
      <div className="py-16">
        <Note tone="bad">
          {/not a Hurdle vault/.test((error as Error).message)
            ? `${address} is not a vault created by the Hurdle factory.`
            : `Could not load this vault: ${(error as Error).message}`}
        </Note>
        <Link href="/vaults" className="mt-4 inline-block font-medium hover:underline">Back to vaults</Link>
      </div>
    );
  if (isLoading || !data) return <VaultSkeleton />;
  return <Loaded d={data} />;
}

function Loaded({ d }: { d: VaultDetail }) {
  const v = d.vault;
  const now = useNow(1000);
  const e = epochInfo(v, now);
  const { unit } = useUnit();
  const price = markPrice(d.pool);
  const fm = (wei: bigint | string | null | undefined) => money(wei, price, unit);
  const cum = v.cumulative;
  // "vs par" = gap between the index lines in points of starting capital (the README / replay convention), in the chosen unit
  const depVsPar = cum ? (unit === "usd" ? cum.depositorUsd - cum.parUsd : cum.depositor - cum.par) : null;
  const stratVsPar = cum ? (unit === "usd" ? cum.strategyUsd - cum.parUsd : cum.strategy - cum.par) : null;

  return (
    <div className="pt-8">
      <nav aria-label="Breadcrumb" className="text-[13px] text-ink-2">
        <Link href="/vaults" className="hover:text-ink hover:underline">Vaults</Link> <span aria-hidden>/</span> {vaultName(v)}
      </nav>
      <header className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[30px] font-bold tracking-[-0.03em] sm:text-[34px]">{vaultName(v)}</h1>
            <StatusPill status={v.status} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-2">
            <Address value={v.address} />
            <span className="inline-flex items-center gap-1">curator <Address value={v.curator} /></span>
            {v.note && <span>{v.note}</span>}
            {v.isVault && <span className="text-good">factory-registered (isVault)</span>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <SourceBadge source={d.source} head={d.head} />
          <UnitToggle />
        </div>
      </header>

      {v.status === "FIRED" && (
        <div className="mt-5"><Note tone="bad"><b className="font-semibold">Fired {v.firedAt ? utc(v.firedAt) : ""}.</b> A miss left the bond below half the floor. The vault {v.parked ? "is parked passive full range: it now simply tracks par." : "is being parked full range; anyone can finish it from the Settle tab."}</Note></div>
      )}
      {v.status === "FROZEN" && (
        <div className="mt-5"><Note tone="warn"><b className="font-semibold">Frozen.</b> The bond is {((v.bondBps ?? 0) / 100).toFixed(2)}% of NAV, under the {v.minBondBps / 100}% floor. Deposits and curator rebalances wait until the curator posts bond. Depositors stay covered.</Note></div>
      )}

      {/* scoreboard */}
      <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line lg:grid-cols-4">
        <Cell k={`NAV (${unitName(unit)})`} v={fm(v.nav)} sub={v.nav ? `${moneyAlt(v.nav, price, unit)} · ETH $${price.toFixed(0)} TWAP` : ""} />
        <Cell
          k={`Depositors vs par (${unitName(unit)})`}
          v={depVsPar != null ? <SignedValue v={depVsPar}>{fmtSignedPct(depVsPar, 3)}</SignedValue> : "–"}
          sub={stratVsPar != null ? `strategy ${fmtSignedPct(stratVsPar, 3)} · points of starting capital · ${v.totals.settlements} epochs` : "starts at the first settlement"}
        />
        <Cell
          k="Bond / NAV"
          v={v.bondBps != null ? `${(v.bondBps / 100).toFixed(2)}%` : "–"}
          sub={<span className="block pt-2"><BondMeter bondBps={v.bondBps} minBondBps={v.minBondBps} compact /></span>}
        />
        <Cell
          k={v.fired ? "Epoch" : e.due ? "Epoch over" : "Epoch ends in"}
          v={v.fired ? "parked" : e.due ? <span className="text-bar-ink">settle due</span> : fmtDuration(e.left)}
          sub={v.fired ? "" : e.windowOpen ? <span className="text-good">deposit window open</span> : "deposit window closed"}
        />
      </dl>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-6">
          <Panel title="NAV vs par, per settlement" aside={<Legend items={[{ label: "Par", kind: "par" }, { label: "Depositors", kind: "solid", color: "var(--ink)" }, { label: "Strategy NAV", kind: "dash", color: "var(--ink-2)" }]} />}>
            <SeriesChart d={d} unit={unit} />
          </Panel>

          <div className="grid gap-6 md:grid-cols-2">
            <Panel title="Bond">
              <BondMeter bondBps={v.bondBps} minBondBps={v.minBondBps} />
              <div className="rows mt-4">
                <KV k="Posted tokens (mWETH)" v={fm(v.bond)} />
                <KV k="Bond value (incl. locked shares)" v={fm(v.bondValue)} />
                <KV k="Deficit (paid, not refilled)" v={fm(v.deficit)} />
                <KV k="Capacity (bond ÷ floor)" v={v.bondValue && v.minBondBps ? fm((BigInt(v.bondValue) * 10_000n) / BigInt(v.minBondBps)) : "–"} />
              </div>
            </Panel>
            <Panel title="Terms">
              <div className="rows">
                <KV k="Carry above par" v={`${v.carryBps / 100}%`} />
                <KV k="Bond floor / fire line" v={`${v.minBondBps / 100}% / ${v.minBondBps / 200}%`} />
                <KV k="Max tick deviation" v={`${v.maxTickDeviation} ticks`} />
                <KV k="Epoch" v={fmtDuration(v.epochSeconds)} />
                <KV k="Rebalances this epoch" v={`${v.rebalancesThisEpoch} / 4`} />
                <KV k="Shortfall paid · carry" v={unit === "usd" ? `${fmtUsd(v.totals.shortfallPaidUsd)} · ${fmtUsd(v.totals.carryUsd)}` : `${fmtEth(v.totals.shortfallPaid)} · ${fmtEth(v.totals.carry)} mWETH`} />
              </div>
            </Panel>
          </div>

          <Panel title="Position" aside={<span className="num text-[12.5px] text-ink-2">spot tick {d.pool.tick} · TWAP {d.pool.twapTick ?? "n/a"}</span>}>
            <RangeBar lo={v.lo} hi={v.hi} tick={d.pool.tick} twapTick={d.pool.twapTick} liquidity={v.liquidity} />
          </Panel>

          <Panel title="Activity" aside={<span className="text-[12.5px] text-ink-2">{d.events.length} events</span>}>
            <EventFeed events={d.events} unit={unit} price={price} />
          </Panel>

          {d.keeper.length > 0 && (
            <Panel title="Keeper runs">
              <KeeperRuns runs={d.keeper} />
            </Panel>
          )}
        </div>

        <aside className="lg:sticky lg:top-20 lg:self-start">
          <ActionPanel vault={v} pool={d.pool} />
          <p className="mt-3 px-1 text-[12px] leading-relaxed text-ink-2">
            {unit === "usd"
              ? "Values are in USD: mUSDC counts $1, mWETH is priced at the hook's TWAP (the price the contract marks NAV at). Charts value each settlement at its own price. Switch to mWETH to see the contract's own unit."
              : "Values are in mWETH (the pool's token1) at the hook's TWAP, the contract's own unit. When ETH falls, par in mWETH rises: switch to USD for the depositor's real outcome."}
            {" "}Testnet mock tokens only.
          </p>
        </aside>
      </div>
    </div>
  );
}

function Cell({ k, v, sub }: { k: string; v: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="bg-surface px-4 py-4 sm:px-5">
      <dt className="text-[12.5px] text-ink-2">{k}</dt>
      <dd className="num mt-1 text-[20px] font-semibold tracking-tight sm:text-[22px]">{v}</dd>
      {sub ? <dd className="num mt-0.5 text-[12.5px] text-ink-2">{sub}</dd> : null}
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2 text-[13.5px]">
      <span className="text-ink-2">{k}</span>
      <span className="num text-right font-medium">{v}</span>
    </div>
  );
}

function SeriesChart({ d, unit }: { d: VaultDetail; unit: Unit }) {
  const s = d.series;
  const now = useNow(1000);
  const e = epochInfo(d.vault, now);
  if (s.length < 2)
    return (
      <div className="grid h-[260px] place-items-center rounded-lg border border-dashed border-line-2 bg-bg-2 px-6 text-center">
        <div>
          <div className="bar-hatch mx-auto mb-4 h-2 w-24 rounded-full" />
          <p className="font-semibold">No settlement yet</p>
          <p className="mt-1 max-w-[44ch] text-[13.5px] text-ink-2">
            The chart starts when this vault settles its first epoch against par{d.vault.fired ? "." : e.due ? ": it is due now, anyone can settle it." : `, in ${fmtDuration(e.left)}.`}
          </p>
        </div>
      </div>
    );
  const fired = s.find((p) => p.fired);
  const usd = unit === "usd";
  const pick = (p: (typeof s)[number]) => (usd ? { par: p.parUsd, strategy: p.strategyUsd, depositor: p.depositorUsd } : { par: p.par, strategy: p.strategy, depositor: p.depositor });
  const idx = s.map(pick);
  const u = unitName(unit);
  const when = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 16);
  return (
    <div>
      <ParChart
        t={s.map((p) => p.ts)}
        height={190}
        dots={s.length < 40}
        ariaLabel={`Gap to par in points of starting capital, ${u}, at each settlement`}
        yTitle={`vs par, ${u} (points of starting capital)`}
        xTitle="settlement time, UTC"
        yFormat={(x) => fmtSignedPct(x, Math.abs(x) < 0.01 ? 2 : 1)}
        xFormat={when}
        markers={fired ? [{ t: fired.ts, label: "Fired", tone: "bad" }] : []}
        lines={[
          { id: "par0", label: "Par", values: idx.map(() => 0), color: "var(--bar)", kind: "par" },
          { id: "nav", label: "Strategy", values: idx.map((p) => p.strategy - p.par), color: "var(--ink-2)", kind: "dash" },
          { id: "dep", label: "Depositors", values: idx.map((p) => p.depositor - p.par), color: "var(--ink)", kind: "solid" },
        ]}
        tooltip={(i) => (
          <div className="space-y-0.5">
            <div className="font-semibold">{utc(s[i].ts)}</div>
            <div className="num flex justify-between gap-4"><span className="text-ink-2">Depositors vs par</span>{fmtSignedPct(idx[i].depositor - idx[i].par, 3)}</div>
            <div className="num flex justify-between gap-4"><span className="text-ink-2">Strategy vs par</span>{fmtSignedPct(idx[i].strategy - idx[i].par, 3)}</div>
          </div>
        )}
      />
      <div className="mt-4" />
      <ParChart
        t={s.map((p) => p.ts)}
        height={300}
        dots={s.length < 40}
        ariaLabel={`Cumulative depositor, strategy and par value in ${u}, as return on starting capital, at each settlement`}
        yTitle={`return on starting capital, ${u}`}
        xTitle="settlement time, UTC"
        yFormat={(x) => fmtSignedPct(x, Math.abs(x) < 0.01 ? 2 : 1)}
        xFormat={when}
        markers={fired ? [{ t: fired.ts, label: "Fired", tone: "bad" }] : []}
        lines={[
          { id: "par", label: "Par", values: idx.map((p) => p.par - 1), color: "var(--bar)", kind: "par" },
          { id: "nav", label: "Strategy", values: idx.map((p) => p.strategy - 1), color: "var(--ink-2)", kind: "dash" },
          { id: "dep", label: "Depositors", values: idx.map((p) => p.depositor - 1), color: "var(--ink)", kind: "solid" },
        ]}
        tooltip={(i) => (
          <div className="space-y-0.5">
            <div className="font-semibold">{utc(s[i].ts)} {s[i].kind === "rebase" ? "· deposit re-baseline" : ""}</div>
            <div className="num flex justify-between gap-4"><span className="text-ink-2">Par</span>{fmtSignedPct(idx[i].par - 1, 3)}</div>
            <div className="num flex justify-between gap-4"><span className="text-ink-2">Depositors</span>{fmtSignedPct(idx[i].depositor - 1, 3)}</div>
            <div className="num flex justify-between gap-4"><span className="text-ink-2">Strategy</span>{fmtSignedPct(idx[i].strategy - 1, 3)}</div>
            {i > 0 && <div className="num flex justify-between gap-4"><span className="text-ink-2">This epoch vs par</span><SignedValue v={s[i].vsPar}>{fmtSignedBp(s[i].vsPar)}</SignedValue></div>}
            <div className="num flex justify-between gap-4"><span className="text-ink-2">ETH (TWAP)</span>${s[i].price.toFixed(0)}</div>
          </div>
        )}
      />
      <p className="mt-2 text-[12px] text-ink-2">
        {usd ? "USD: each settlement is valued at its own pool price (mUSDC = $1), so a falling ETH is a loss for par and depositors alike." : "mWETH: the contract's unit; par here rises when ETH falls."} Derived from Settled events: each epoch&apos;s NAV ÷ par is exact; levels exclude par&apos;s fee credit (a fraction of a bp per epoch), equally for every line.
      </p>
    </div>
  );
}

const EV_LABEL: Record<string, string> = {
  Settled: "Settled", Fired: "Fired", Deposited: "Deposit", Withdrawn: "Withdrawal", Rebalanced: "Rebalanced",
  BondPosted: "Bond posted", SettlerPaid: "Settler paid", BondReclaimed: "Bond reclaimed", VaultCreated: "Vault created",
};

/** USD per ETH for an event: its own Settled price, else the Settled in the same tx, else the nearest settlement, else `fallback`. */
function eventPrice(e: VaultEvent, all: VaultEvent[], fallback: number): number {
  if (e.name === "Settled") return usdPerEthFromSqrt(String(e.args.sqrtPriceX96));
  const settled = all.filter((x) => x.name === "Settled");
  const same = settled.find((x) => x.tx === e.tx);
  const near = same ?? settled.reduce<VaultEvent | null>((b, x) => (!b || Math.abs(x.block - e.block) < Math.abs(b.block - e.block) ? x : b), null);
  return near ? usdPerEthFromSqrt(String(near.args.sqrtPriceX96)) : fallback;
}

function describe(e: VaultEvent, unit: Unit, price: number): React.ReactNode {
  const a = e.args;
  const m = (wei: unknown) => money(String(wei), price, unit);
  switch (e.name) {
    case "Settled": {
      const nav = BigInt(String(a.nav)), bench = BigInt(String(a.bench));
      const beat = nav >= bench;
      const vs = Number(nav) / Math.max(1, Number(bench)) - 1;
      return (
        <>
          NAV {m(a.nav)} vs par {m(a.bench)} · <SignedValue v={vs}>{fmtSignedBp(vs)}</SignedValue>
          {beat ? (BigInt(String(a.take)) > 0n ? ` · curator take ${m(a.take)}` : "") : ` · bond paid ${m(a.shortfallPaid)}`}
          <span className="text-ink-2"> · ETH ${usdPerEthFromSqrt(String(a.sqrtPriceX96)).toFixed(0)}</span>
        </>
      );
    }
    case "Fired": return <>bond {m(a.bond)} left at NAV {m(a.nav)}: parked passive</>;
    case "Deposited": return <>{short(String(a.owner))} · {fmtEth(a.shares as string)} shares for {(Number(a.amount0) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })} mUSDC + {fmtEth(a.amount1 as string)} mWETH</>;
    case "Withdrawn": return <>{short(String(a.owner))} · {fmtEth(a.shares as string)} shares → {(Number(a.amount0) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })} mUSDC + {fmtEth(a.amount1 as string)} mWETH</>;
    case "Rebalanced": return <>ticks {String(a.tickLower)} → {String(a.tickUpper)}</>;
    case "BondPosted": return <>+{m(a.amount)} · bond {m(a.bond)}</>;
    case "SettlerPaid": return <>{short(String(a.settler))} earned {fmtEth(a.shares as string)} shares</>;
    case "BondReclaimed": return <>{m(a.bondTokens)} + {fmtEth(a.bondShares as string)} shares</>;
    case "VaultCreated": return <>by {short(String(a.curator))}</>;
    default: return null;
  }
}

function EventFeed({ events, unit, price }: { events: VaultEvent[]; unit: Unit; price: number }) {
  if (!events.length) return <p className="text-[14px] text-ink-2">No events yet.</p>;
  return (
    <ul className="rows -my-1 max-h-[460px] overflow-y-auto pr-1">
      {events.slice(0, 80).map((e) => {
        const bad = e.name === "Fired" || (e.name === "Settled" && BigInt(String(e.args.shortfallPaid ?? "0")) > 0n);
        return (
          <li key={e.tx + e.logIndex} className="flex gap-3 py-2.5 text-[13.5px]">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${e.name === "Fired" ? "bg-bad" : bad ? "bg-bad/70" : e.name === "Settled" ? "bg-bar" : "bg-ink-3"}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-semibold">{e.name === "Fired" && <IconAlert size={13} className="mr-1 inline text-bad" />}{EV_LABEL[e.name] ?? e.name}</span>
                <a href={txUrl(e.tx)} target="_blank" rel="noreferrer" className="num inline-flex items-center gap-1 text-[12px] text-ink-2 hover:text-ink">
                  {ago(e.ts)} · #{e.block.toLocaleString("en-US")} <IconExternal size={11} />
                </a>
              </div>
              <div className="num mt-0.5 break-words text-ink-2">{describe(e, unit, eventPrice(e, events, price))}</div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function VaultSkeleton() {
  return (
    <div className="pt-8" aria-busy="true" aria-label="Loading vault">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="mt-4 h-9 w-64" />
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px]">
        <Skeleton className="h-[360px]" />
        <Skeleton className="h-[420px]" />
      </div>
    </div>
  );
}


