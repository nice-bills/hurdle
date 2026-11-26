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
 *
 * Two bases are built side by side. token1: the contract's own unit (v5 mUSDC, v4 mWETH). USD: every NAV / par / payout is valued
 * at the Settled event's sqrtPriceX96 (mUSDC = $1, mWETH priced from the pool, order-aware), the start of a segment at the previous
 * settlement price, so a falling ETH shows up as the loss it is. `startSqrt` is the pool price when the first deposit
 * landed (read from chain history); without it the first segment starts at its own settlement price.
 */
export function buildSeries(events: VaultEvent[], startSqrt: bigint | null | undefined, wethIs0: boolean): { series: SeriesPoint[]; totals: VaultTotals } {
  // bond / NAV unit = token1: mWETH when USDC is token0 (v4), mUSDC when WETH is token0 (v5)
  const bondIsWeth = !wethIs0;
  const dec = bondIsWeth ? 1e18 : 1e6;
  const usdOf = (s: bigint) => (bondIsWeth ? usdPerEthFromSqrt(s, wethIs0) : 1); // USD per bond-unit token
  const ev = [...events].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const depositTx = new Set(ev.filter((e) => e.name === "Deposited").map((e) => e.tx));
  const series: SeriesPoint[] = [];
  let strategy = 1, par = 1, depositor = 1;
  let strategyU = 1, parU = 1, depositorU = 1;
  let prevS: bigint | null = null;
  let firstDep: VaultEvent | null = null;
  let deficit = 0n;
  const totals = { settlements: 0, shortfallPaid: 0n, take: 0n, carry: 0n, beats: 0, misses: 0, shortfallPaidUsd: 0, takeUsd: 0, carryUsd: 0 };

  for (const e of ev) {
    if (e.name === "Deposited" && !firstDep && prevS === null) firstDep = e;
    if (e.name === "Fired" && series.length) series[series.length - 1].fired = true;
    if (e.name !== "Settled") continue;
    const nav = big(e.args.nav), bench = big(e.args.bench), take = big(e.args.take), paid = big(e.args.shortfallPaid);
    const s = big(e.args.sqrtPriceX96);
    if (bench === 0n || s === 0n) continue;
    const benchF = Number(bench);
    const s0 = prevS ?? (firstDep && startSqrt && startSqrt > 0n ? startSqrt : s); // price at the segment start
    const usd1 = usdOf(s), usd0 = usdOf(s0);
    let startNav: number;
    if (prevS !== null) startNav = benchF * (Number(prevS) / Number(s));
    else if (firstDep) startNav = Number(valueInToken1(big(firstDep.args.amount0), big(firstDep.args.amount1), s0));
    else startNav = benchF;
    if (!(startNav > 0)) startNav = benchF;
    const startUsd = startNav * usd0;

    if (series.length === 0) {
      series.push({
        ts: firstDep?.ts ?? e.ts, block: firstDep?.block ?? e.block, strategy: 1, par: 1, depositor: 1, vsPar: 0,
        strategyUsd: 1, parUsd: 1, depositorUsd: 1,
        price: usdPerEthFromSqrt(s0, wethIs0), kind: "epoch", miss: false,
      });
    }
    const navF = Number(nav);
    strategy *= navF / startNav;
    par *= benchF / startNav;
    depositor *= (navF - Number(take) + Number(paid)) / startNav;
    strategyU *= (navF * usd1) / startUsd;
    parU *= (benchF * usd1) / startUsd;
    depositorU *= ((navF - Number(take) + Number(paid)) * usd1) / startUsd;
    const miss = nav < bench;
    const kind = depositTx.has(e.tx) ? "rebase" : "epoch";
    series.push({ ts: e.ts, block: e.block, strategy, par, depositor, strategyUsd: strategyU, parUsd: parU, depositorUsd: depositorU, vsPar: navF / benchF - 1, price: usdPerEthFromSqrt(s, wethIs0), kind, miss });

    totals.settlements += kind === "epoch" ? 1 : 0;
    totals.shortfallPaid += paid;
    totals.take += take;
    totals.shortfallPaidUsd += (Number(paid) / dec) * usd1;
    totals.takeUsd += (Number(take) / dec) * usd1;
    if (miss) {
      if (paid > 0n) totals.misses += 1;
      deficit += paid;
    } else {
      if (nav > bench) totals.beats += 1;
      const excess = nav - bench;
      const recoup = excess < deficit ? excess : deficit;
      deficit -= recoup;
      const carried = take > recoup ? take - recoup : 0n;
      totals.carry += carried;
      totals.carryUsd += (Number(carried) / dec) * usd1;
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
      shortfallPaidUsd: totals.shortfallPaidUsd,
      takeUsd: totals.takeUsd,
      carryUsd: totals.carryUsd,
    },
  };
}
