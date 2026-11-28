"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useEffect, useMemo, useRef, useState } from "react";
import { maxUint256, parseUnits } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { erc20Abi, swapRouterAbi } from "@/shared/abis";
import { ADDR, CHAIN_ID, MAX_SQRT_PRICE, MIN_SQRT_PRICE, POOL_KEY, USDC_TOKEN, WETH_IS_0, WETH_TOKEN } from "@/lib/chain";
import { usePool } from "@/lib/hooks";
import { fmtNum, fmtToken } from "@/lib/format";
import { usdPerEthFromSqrt, usdPerEthFromTick } from "@/lib/math";
import { TxStatus, useTx } from "@/lib/tx";
import { ParChart } from "@/components/par-chart";
import { Note, Panel, Skeleton, SourceBadge, btn } from "@/components/ui";
import { IconSwap } from "@/components/icons";

const DEV = 50; // the deployed vaults' maxTickDeviation

export function SwapView() {
  const { data: pool } = usePool();
  const [samples, setSamples] = useState<{ ts: number; spot: number; twap: number | null; twap10: number | null }[]>([]);
  const last = useRef(0);
  useEffect(() => {
    if (!pool || pool.headTs === last.current) return;
    last.current = pool.headTs;
    setSamples((s) => [...s.slice(-180), { ts: pool.headTs, spot: pool.tick, twap: pool.twapTick, twap10: pool.twap10Tick }]);
  }, [pool]);

  return (
    <div className="pt-8 sm:pt-10">
      <h1 className="text-[clamp(2rem,4vw,2.6rem)] font-medium leading-tight tracking-[-0.04em]">Swap</h1>
      <p className="mt-2 max-w-[62ch] text-[15.5px] text-ink-2">
        Trade on the hooked mUSDC/mWETH pool to move the price and generate fees. Vault NAV and par are valued at the hook&apos;s TWAP,
        so a swap moves spot at once and the TWAP over the next minutes.
      </p>
      <div className="mt-6 grid gap-2.5 lg:grid-cols-[400px_minmax(0,1fr)] lg:gap-6">
        <SwapForm pool={pool ?? null} />
        <div className="min-w-0 space-y-2.5">
          <Panel title="Spot vs TWAP" aside={pool ? <SourceBadge source={pool.source as "db" | "rpc"} head={pool.head} /> : null}>
            {pool ? <PriceGrid pool={pool} /> : <Skeleton className="h-28" />}
            {pool && <DeviationRuler spot={pool.tick} twap={pool.twap10Tick} reference={pool.referenceTick} />}
          </Panel>
          <Panel title="Price history" aside={<span className="text-[12.5px] text-ink-2">USDC per ETH</span>}>
            <History pool={pool ?? null} samples={samples} />
          </Panel>
        </div>
      </div>
    </div>
  );
}

function PriceGrid({ pool }: { pool: NonNullable<ReturnType<typeof usePool>["data"]> }) {
  const cells = [
    { k: "Spot", tick: pool.tick, strong: true },
    { k: "Block open", tick: pool.referenceTick },
    { k: "TWAP 10 min", tick: pool.twap10Tick },
    { k: "TWAP 30 min", tick: pool.twapTick },
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {cells.map((c) => (
        <div key={c.k} className="min-w-0 rounded-2xl bg-bg-2 px-3.5 py-3">
          <dt className="text-[12px] text-ink-2">{c.k}</dt>
          <dd className={`num mt-0.5 font-medium tracking-[-0.02em] ${c.strong ? "text-[20px]" : "text-[17px]"}`}>{c.tick != null ? `$${fmtNum(usdPerEthFromTick(c.tick), 2)}` : "n/a"}</dd>
          <dd className="num text-[11.5px] text-ink-2">{c.tick != null ? `tick ${c.tick}` : "needs 10 min history"}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Where spot sits against the ±maxTickDeviation band around the 10-min TWAP (the deposit / rebalance gate). */
function DeviationRuler({ spot, twap, reference }: { spot: number; twap: number | null; reference: number | null }) {
  if (twap == null) return null;
  const span = DEV * 3;
  const X = (d: number) => `${50 + (Math.max(-span, Math.min(span, d)) / span) * 50}%`;
  const d = spot - twap;
  const ok = Math.abs(d) <= DEV && (reference == null || Math.abs(spot - reference) <= DEV);
  return (
    <div className="mt-5">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
        <span className="font-semibold">Spot − TWAP: <span className="num">{d > 0 ? "+" : ""}{d} ticks</span></span>
        <span className={ok ? "text-good" : "text-bad"}>{ok ? `within ±${DEV}: deposits and rebalances pass` : `outside ±${DEV}: vaults refuse PriceDeviation`}</span>
      </div>
      <div className="relative h-8">
        <div className="absolute inset-x-0 top-3.5 h-1 rounded-full bg-bg-3" />
        <div className="absolute top-3.5 h-1 rounded-full bg-good/60" style={{ left: X(-DEV), right: `calc(100% - ${X(DEV)})` }} />
        <div className="absolute top-1 h-6 w-px bg-ink-3" style={{ left: "50%" }} />
        {reference != null && <div className="absolute top-2 h-4 w-[2px] -translate-x-1/2 bg-ink-2" style={{ left: X(reference - twap) }} title="block open" />}
        <div className="absolute top-0.5 h-7 w-[3px] -translate-x-1/2 rounded bg-ink" style={{ left: X(d) }} />
      </div>
      <div className="num mt-1 flex justify-between text-[11.5px] text-ink-2">
        <span>−{span}</span><span>TWAP</span><span>+{span}</span>
      </div>
    </div>
  );
}

function History({ pool, samples }: { pool: ReturnType<typeof usePool>["data"] | null; samples: { ts: number; spot: number; twap: number | null }[] }) {
  const series = useMemo(() => {
    const h = (pool?.history ?? []).map((p) => ({ ts: p.ts, spot: p.tick, twap: null as number | null }));
    const merged = [...h, ...samples].filter((p, i, a) => i === 0 || p.ts > a[i - 1].ts);
    return merged;
  }, [pool, samples]);
  if (series.length < 2)
    return (
      <div className="grid h-[200px] place-items-center rounded-2xl bg-bg-2 px-6 text-center text-[13.5px] text-ink-2">
        {pool ? "Collecting live samples (every few seconds). With the indexer running this shows the last 6 hours." : "Loading…"}
      </div>
    );
  const base = usdPerEthFromTick(series[0].spot);
  return (
    <ParChart
      t={series.map((p) => p.ts)}
      height={220}
      includeZero={false}
      ariaLabel="Pool spot price over time"
      yFormat={(v) => `$${fmtNum(base * (1 + v), 2)}`}
      xFormat={(ts) => new Date(ts * 1000).toISOString().slice(11, 16)}
      lines={[
        { id: "spot", label: "Spot", values: series.map((p) => usdPerEthFromTick(p.spot) / base - 1), color: "var(--ink)", kind: "solid", width: 2 },
        ...(series.some((p) => p.twap != null)
          ? [{ id: "twap", label: "TWAP", values: series.map((p) => usdPerEthFromTick(p.twap ?? p.spot) / base - 1), color: "var(--ink-2)", kind: "dash" as const }]
          : []),
      ]}
      tooltip={(i) => <div className="num">{new Date(series[i].ts * 1000).toISOString().slice(11, 19)} · ${fmtNum(usdPerEthFromTick(series[i].spot), 2)}</div>}
    />
  );
}

function SwapForm({ pool }: { pool: ReturnType<typeof usePool>["data"] | null }) {
  const { address } = useAccount();
  const tx = useTx();
  const [sellUsdc, setSellUsdc] = useState(true);
  const [amt, setAmt] = useState("");
  const tin = sellUsdc ? USDC_TOKEN : WETH_TOKEN;
  const tout = sellUsdc ? WETH_TOKEN : USDC_TOKEN;
  const zeroForOne = sellUsdc !== WETH_IS_0; // selling token0 pushes sqrtPrice down (v5: token0 = mWETH)
  let amount: bigint | null = null;
  try {
    amount = amt ? parseUnits(amt as `${number}`, tin.decimals) : null;
  } catch {
    amount = null;
  }
  const me = address ?? ADDR.factory;
  const r = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(address), refetchInterval: 10_000 },
    contracts: [
      { chainId: CHAIN_ID, address: tin.address, abi: erc20Abi, functionName: "balanceOf", args: [me] },
      { chainId: CHAIN_ID, address: tin.address, abi: erc20Abi, functionName: "allowance", args: [me, ADDR.swapRouter] },
    ],
  });
  const bal = r.data?.[0]?.status === "success" ? (r.data[0].result as bigint) : 0n;
  const allowance = r.data?.[1]?.status === "success" ? (r.data[1].result as bigint) : 0n;

  // constant-liquidity estimate inside the active range (display only)
  const est = useMemo(() => {
    if (!pool || !amount) return null;
    const L = Number(pool.liquidity);
    if (!(L > 0)) return null;
    const s = Number(BigInt(pool.sqrtPriceX96)) / 2 ** 96;
    const x = Number(amount) * (1 - 0.0005);
    let s2: number, out: number;
    if (zeroForOne) { s2 = 1 / (1 / s + x / L); out = L * (s - s2); }
    else { s2 = s + x / L; out = L * (1 / s - 1 / s2); }
    const after = usdPerEthFromSqrt(s2 * 2 ** 96);
    return { out, after, impact: after / pool.price - 1 };
  }, [pool, amount, zeroForOne]);
  return (
    <div className="card space-y-3 self-start p-3 sm:p-4">
      <div className="rounded-2xl bg-bg-2 p-4">
        <label htmlFor="sw-amt" className="text-[13px] text-ink-2">You sell</label>
        <div className="mt-1 flex items-center gap-2">
          <input id="sw-amt" inputMode="decimal" placeholder={sellUsdc ? "500" : "0.2"} className="num w-full min-w-0 bg-transparent text-[32px] font-medium tracking-[-0.03em] outline-none placeholder:text-ink-3" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
          <span className="grid h-9 shrink-0 place-items-center rounded-full bg-surface px-3.5 text-[14px] font-medium">{tin.symbol}</span>
        </div>
        <div className="mt-1 flex justify-between text-[12.5px] text-ink-2">
          <span className="num">Balance {fmtToken(bal, tin.decimals)}</span>
          {bal > 0n && <button type="button" className="hover:underline" onClick={() => setAmt(fmtToken(bal / 4n, tin.decimals).replace(/,/g, ""))}>25%</button>}
        </div>
      </div>
      <button type="button" onClick={() => { setSellUsdc((x) => !x); setAmt(""); }} className="relative z-10 mx-auto -my-6 grid h-10 w-10 place-items-center rounded-full bg-surface text-ink shadow-[0_0_0_4px_var(--surface)] transition-[transform,background-color] duration-150 hover:bg-bg-3 active:scale-90" aria-label="Flip direction">
        <IconSwap size={16} className="transition-transform duration-300 ease-[var(--ease-in-out)]" style={{ transform: `rotate(${sellUsdc ? 180 : 0}deg)` }} />
      </button>
      <div className="rounded-2xl bg-bg-2 p-4">
        <div className="text-[13px] text-ink-2">You receive (estimate)</div>
        <div className="num mt-1 text-[24px] font-medium tracking-[-0.03em]">{est ? `${fmtNum(est.out / 10 ** tout.decimals, tout.decimals === 6 ? 2 : 5)} ${tout.symbol}` : `– ${tout.symbol}`}</div>
        {est && (
          <div className="num mt-1 text-[12.5px] text-ink-2">
            ETH ${fmtNum(pool!.price, 2)} → ${fmtNum(est.after, 2)} ({est.impact >= 0 ? "+" : "−"}{Math.abs(est.impact * 100).toFixed(2)}%) · 0.05% fee
          </div>
        )}
      </div>
      {est && Math.abs(est.impact) > 0.02 && <Note tone="warn">This moves the price by more than 2%: spot will leave the ±{DEV}-tick band around the TWAP and vault deposits and rebalances will refuse until it recovers.</Note>}
      {!address ? (
        <ConnectButton label="Connect to swap" showBalance={false} />
      ) : (
        <div className="flex flex-col gap-2">
          {amount != null && amount > bal && (
            <button className={btn.ghost} disabled={tx.busy} onClick={() => tx.run(`Mint ${tin.symbol}`, { address: tin.address, abi: erc20Abi, functionName: "mint", args: [address, sellUsdc ? 10_000n * 10n ** 6n : 5n * 10n ** 18n] })}>
              Mint {sellUsdc ? "10,000 mUSDC" : "5 mWETH"} (faucet)
            </button>
          )}
          {amount != null && allowance < amount ? (
            <button className={btn.ghost} disabled={tx.busy} onClick={async () => { await tx.run(`Approve ${tin.symbol}`, { address: tin.address, abi: erc20Abi, functionName: "approve", args: [ADDR.swapRouter, maxUint256] }); r.refetch(); }}>
              Approve {tin.symbol} for the swap router
            </button>
          ) : null}
          <button
            className={btn.primary}
            disabled={tx.busy || !amount || amount > bal || allowance < amount}
            onClick={async () => {
              const rc = await tx.run("Swap", {
                address: ADDR.swapRouter,
                abi: swapRouterAbi,
                functionName: "swap",
                args: [POOL_KEY, { zeroForOne, amountSpecified: -amount!, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n }, { takeClaims: false, settleUsingBurn: false }, "0x"],
              });
              if (rc) setAmt("");
              r.refetch();
            }}
          >
            {!amount ? "Enter an amount" : amount > bal ? `Not enough ${tin.symbol}` : `Sell ${tin.symbol} for ${tout.symbol}`}
          </button>
        </div>
      )}
      <TxStatus state={tx.state} />
      <p className="px-1 text-[12px] leading-relaxed text-ink-2">Exact-input swap through the pool&apos;s PoolSwapTest router (fee 0.05%, tick spacing 10). Mock tokens on testnet.</p>
    </div>
  );
}
