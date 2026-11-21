import { usdPerEthFromSqrt, valueInToken1 } from "./math";
import type { SeriesPoint, VaultEvent, VaultTotals } from "./types";

const big = (v: unknown) => {
  try {
    return BigInt(String(v ?? "0"));
  } catch {
    return 0n;
  }
};

/**
 * NAV vs par per settlement, from Settled events alone.
 * Each Settled closes a segment that started at the previous reset (settlement, re-baseline or first deposit).
 * nav/bench is exact. The segment's start NAV is recovered as bench × s0/s1 (par's principal moves with
 * sqrtPrice for a full-range position); that drops par's fee credit, which is the same factor on every line,
 * so the gaps between lines stay exact while both levels miss a fraction of a bp per epoch.
 */
export function buildSeries(events: VaultEvent[]): { series: SeriesPoint[]; totals: VaultTotals } {
  const ev = [...events].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const depositTx = new Set(ev.filter((e) => e.name === "Deposited").map((e) => e.tx));
  const series: SeriesPoint[] = [];
  let strategy = 1, par = 1, depositor = 1;
  let prevS: bigint | null = null;
  let firstDep: VaultEvent | null = null;
  let deficit = 0n;
  const totals = { settlements: 0, shortfallPaid: 0n, take: 0n, carry: 0n, beats: 0, misses: 0 };

  for (const e of ev) {
    if (e.name === "Deposited" && !firstDep && prevS === null) firstDep = e;
    if (e.name === "Fired" && series.length) series[series.length - 1].fired = true;
    if (e.name !== "Settled") continue;
    const nav = big(e.args.nav), bench = big(e.args.bench), take = big(e.args.take), paid = big(e.args.shortfallPaid);
    const s = big(e.args.sqrtPriceX96);
    if (bench === 0n || s === 0n) continue;
    const benchF = Number(bench);
    let startNav: number;
    if (prevS !== null) startNav = benchF * (Number(prevS) / Number(s));
    else if (firstDep) startNav = Number(valueInToken1(big(firstDep.args.amount0), big(firstDep.args.amount1), s));
    else startNav = benchF;
    if (!(startNav > 0)) startNav = benchF;

    if (series.length === 0) {
      series.push({
        ts: firstDep?.ts ?? e.ts, block: firstDep?.block ?? e.block, strategy: 1, par: 1, depositor: 1, vsPar: 0,
        price: usdPerEthFromSqrt(prevS ?? s), kind: "epoch", miss: false,
      });
    }
    const navF = Number(nav);
    strategy *= navF / startNav;
    par *= benchF / startNav;
    depositor *= (navF - Number(take) + Number(paid)) / startNav;
    const miss = nav < bench;
    const kind = depositTx.has(e.tx) ? "rebase" : "epoch";
    series.push({ ts: e.ts, block: e.block, strategy, par, depositor, vsPar: navF / benchF - 1, price: usdPerEthFromSqrt(s), kind, miss });

    totals.settlements += kind === "epoch" ? 1 : 0;
    totals.shortfallPaid += paid;
    totals.take += take;
    if (miss) {
      if (paid > 0n) totals.misses += 1;
      deficit += paid;
    } else {
      if (nav > bench) totals.beats += 1;
      const excess = nav - bench;
      const recoup = excess < deficit ? excess : deficit;
      deficit -= recoup;
      totals.carry += take > recoup ? take - recoup : 0n;
    }
    prevS = s;
  }
  return {
    series,
    totals: {
      settlements: totals.settlements,
      shortfallPaid: totals.shortfallPaid.toString(),
      take: totals.take.toString(),
      carry: totals.carry.toString(),
      beats: totals.beats,
      misses: totals.misses,
    },
  };
}
