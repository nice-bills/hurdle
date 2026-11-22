"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useMemo, useState, type ReactNode } from "react";
import { formatUnits, maxUint256, parseUnits, type Address } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { erc20Abi, vaultAbi } from "@/shared/abis";
import { ADDR, CHAIN_ID, MAX_REBALANCES, SETTLER_BOUNTY_BPS, TOKENS, maxUsableTick, minUsableTick } from "@/lib/chain";
import { fmtDuration, fmtEth, fmtToken, fmtUsd } from "@/lib/format";
import { alignTick, tickFromUsd, usdPerEthFromTick } from "@/lib/math";
import { TxStatus, useTx } from "@/lib/tx";
import type { PoolState, VaultSummary } from "@/lib/types";
import { depositStatus } from "@/lib/deposit-status";
import { markPrice } from "@/lib/unit";
import { epochInfo } from "./vault-list";
import { RangeBar } from "./range-bar";
import { Note, btn, inputCls, useNow } from "./ui";

type Tab = "deposit" | "withdraw" | "settle" | "curator";

function parseAmt(s: string, dec: number): bigint | null {
  if (!s.trim()) return null;
  try {
    const v = parseUnits(s.trim() as `${number}`, dec);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/** Reads everything the connected wallet needs for this vault. */
function useWalletState(vault: Address) {
  const { address } = useAccount();
  const me = address ?? ADDR.factory;
  const r = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(address), refetchInterval: 10_000 },
    contracts: [
      { chainId: CHAIN_ID, address: TOKENS.token0.address, abi: erc20Abi, functionName: "balanceOf", args: [me] },
      { chainId: CHAIN_ID, address: TOKENS.token1.address, abi: erc20Abi, functionName: "balanceOf", args: [me] },
      { chainId: CHAIN_ID, address: TOKENS.token0.address, abi: erc20Abi, functionName: "allowance", args: [me, vault] },
      { chainId: CHAIN_ID, address: TOKENS.token1.address, abi: erc20Abi, functionName: "allowance", args: [me, vault] },
      { chainId: CHAIN_ID, address: vault, abi: vaultAbi, functionName: "balanceOf", args: [me] },
    ],
  });
  const v = (i: number) => (r.data?.[i]?.status === "success" ? (r.data[i].result as bigint) : 0n);
  return { address, bal0: v(0), bal1: v(1), allow0: v(2), allow1: v(3), shares: v(4), refetch: r.refetch, loaded: Boolean(r.data) };
}

export function ActionPanel({ vault, pool }: { vault: VaultSummary; pool: PoolState }) {
  const { address } = useAccount();
  const isCurator = Boolean(address && address.toLowerCase() === vault.curator.toLowerCase());
  const now = useNow(1000);
  const e = epochInfo(vault, now);
  const [tab, setTab] = useState<Tab>(isCurator ? "curator" : e.due ? "settle" : "deposit");
  const tabs: { id: Tab; label: string; dot?: boolean }[] = [
    { id: "deposit", label: "Deposit" },
    { id: "withdraw", label: "Withdraw" },
    { id: "settle", label: "Settle", dot: e.due && !vault.fired },
    ...(isCurator ? [{ id: "curator" as Tab, label: "Curator" }] : []),
  ];
  return (
    <div className="rounded-xl border border-line bg-surface">
      <div role="tablist" aria-label="Vault actions" className="flex border-b border-line px-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`relative flex-1 px-2 py-3.5 text-[14px] font-medium transition-colors ${tab === t.id ? "text-ink" : "text-ink-2 hover:text-ink"}`}
          >
            <span className="inline-flex items-center gap-1.5">
              {t.label}
              {t.dot && <span className="h-1.5 w-1.5 rounded-full bg-bar" aria-label="due" />}
            </span>
            {tab === t.id && <span className="bar-hatch absolute inset-x-3 -bottom-px h-[3px] rounded-full" />}
          </button>
        ))}
      </div>
      <div className="p-4 sm:p-5">
        {!address ? (
          <ConnectPrompt tab={tab} vault={vault} pool={pool} />
        ) : tab === "deposit" ? (
          <DepositPanel vault={vault} pool={pool} />
        ) : tab === "withdraw" ? (
          <WithdrawPanel vault={vault} pool={pool} />
        ) : tab === "settle" ? (
          <SettlePanel vault={vault} />
        ) : (
          <CuratorPanel vault={vault} pool={pool} />
        )}
      </div>
    </div>
  );
}

function ConnectPrompt({ tab, vault, pool }: { tab: Tab; vault: VaultSummary; pool?: PoolState }) {
  const now = useNow(1000);
  const e = epochInfo(vault, now);
  const text: Record<Tab, string> = {
    deposit: "Connect a wallet to mint test tokens and deposit. Deposits are in kind (mUSDC + mWETH) in the first 5 minutes of an epoch.",
    withdraw: "Connect to see your shares and withdraw. Withdrawals are never blocked.",
    settle: e.due ? "This epoch is over: anyone can settle it now and earn 5% of the carry." : `Next settlement in ${fmtDuration(e.left)}. Anyone can call it.`,
    curator: "Connect the curator's wallet to post bond and rebalance.",
  };
  const dep = tab === "deposit" ? depositStatus(vault, now, pool ? markPrice(pool) : 0) : null;
  return (
    <div className="space-y-4">
      {dep && <Note tone={dep.tone}>{dep.text}</Note>}
      <p className="text-[14px] text-ink-2">{text[tab]}</p>
      <ConnectButton label="Connect wallet" showBalance={false} />
    </div>
  );
}

function Row({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-[13.5px]">
      <span className="text-ink-2">{k}</span>
      <span className="num text-right font-medium">{v}</span>
    </div>
  );
}

function Field({ label, hint, children, id }: { label: string; hint?: ReactNode; children: ReactNode; id: string }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[13px] font-medium">{label}</label>
        {hint && <span className="text-[12px] text-ink-2">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Faucet() {
  const { address } = useAccount();
  const tx = useTx();
  return (
    <div className="rounded-lg border border-dashed border-line-2 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[13px] font-semibold">Test token faucet</span>
        <span className="text-[12px] text-ink-2">mock tokens, free</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className={btn.ghost} disabled={tx.busy || !address} onClick={() => tx.run("Mint 10,000 mUSDC", { address: ADDR.usdc, abi: erc20Abi, functionName: "mint", args: [address!, 10_000n * 10n ** 6n] })}>
          Mint 10,000 mUSDC
        </button>
        <button className={btn.ghost} disabled={tx.busy || !address} onClick={() => tx.run("Mint 5 mWETH", { address: ADDR.weth, abi: erc20Abi, functionName: "mint", args: [address!, 5n * 10n ** 18n] })}>
          Mint 5 mWETH
        </button>
      </div>
      <TxStatus state={tx.state} className="mt-2" />
    </div>
  );
}

function DepositPanel({ vault, pool }: { vault: VaultSummary; pool: PoolState }) {
  const w = useWalletState(vault.address as Address);
  const tx = useTx();
  const now = useNow(1000);
  const e = epochInfo(vault, now);
  const [amt, setAmt] = useState("");
  const shares = parseAmt(amt, 18);
  const supply = BigInt(vault.totalSupply || "0");
  const nav = vault.nav ? BigInt(vault.nav) : 0n;
  const quote = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(shares && supply > 0n), refetchInterval: 12_000 },
    contracts: [{ chainId: CHAIN_ID, address: vault.address as Address, abi: vaultAbi, functionName: "previewDeposit", args: [shares ?? 0n] }],
  });
  const q = quote.data?.[0]?.status === "success" ? (quote.data[0].result as readonly [bigint, bigint]) : null;
  const max0 = q ? q[0] + q[0] / 100n + 1n : 0n;
  const max1 = q ? q[1] + q[1] / 100n + 1n : 0n;
  const valueWei = shares && supply > 0n ? (shares * nav) / supply : 0n;
  const bondValue = BigInt(vault.bondValue ?? vault.bond ?? "0");
  const capNav = vault.minBondBps > 0 ? (bondValue * 10_000n) / BigInt(vault.minBondBps) : 0n;
  const roomShares = nav > 0n && capNav > nav ? ((capNav - nav) * supply) / nav : 0n;

  const status = depositStatus(vault, now, markPrice(pool));
  const reasons: string[] = [];
  if (supply === 0n) reasons.push("The curator has not made the first deposit yet.");
  if (vault.status !== "FROZEN" && !vault.fired && shares && roomShares < shares) reasons.push(`Over capacity: this vault can take about ${fmtEth(roomShares)} more shares until the curator posts more bond.`);
  const blocking = [...reasons, ...(status?.blocked ? [status.text] : [])];
  const need0 = q ? q[0] > w.bal0 : false, need1 = q ? q[1] > w.bal1 : false;
  const approve0 = q ? w.allow0 < max0 : false, approve1 = q ? w.allow1 < max1 : false;

  return (
    <div className="space-y-4">
      {status && <Note tone={status.tone}>{status.text}</Note>}
      <div className={`flex items-center justify-between rounded-lg px-3 py-2 text-[13px] ${e.windowOpen ? "bg-good-soft" : "bg-bg-2"}`}>
        <span className="font-semibold">{e.windowOpen ? "Deposit window open" : "Deposit window closed"}</span>
        <span className="num text-ink-2">{e.windowOpen ? (e.due ? "epoch over: your deposit settles it first" : `${fmtDuration(e.windowLeft)} left`) : `opens in ${fmtDuration(e.left)}`}</span>
      </div>
      <Field id="dep-amt" label="Shares to buy" hint={<button type="button" className="underline-offset-2 hover:underline" onClick={() => setAmt(formatUnits(roomShares > 0n && roomShares < 10n ** 18n ? roomShares : 10n ** 17n, 18))}>use {roomShares > 0n && roomShares < 10n ** 18n ? "max capacity" : "0.1"}</button>}>
        <input id="dep-amt" inputMode="decimal" placeholder="0.10" className={inputCls} value={amt} onChange={(x) => setAmt(x.target.value.replace(/[^0-9.]/g, ""))} />
      </Field>
      <div className="rows rounded-lg border border-line px-3">
        <Row k="Value at NAV" v={shares ? `${fmtUsd((Number(valueWei) / 1e18) * markPrice(pool))} · ${fmtEth(valueWei)} mWETH` : "–"} />
        <Row k="You pay (quote)" v={q ? `${fmtToken(q[0], 6)} mUSDC + ${fmtEth(q[1])} mWETH` : quote.isFetching ? "quoting…" : "–"} />
        <Row k="Max with 1% slack" v={q ? `${fmtToken(max0, 6)} + ${fmtEth(max1)}` : "–"} />
        <Row k="Your balances" v={`${fmtToken(w.bal0, 6)} mUSDC · ${fmtEth(w.bal1)} mWETH`} />
      </div>
      {reasons.filter((r) => r !== status?.text && !/first deposit yet/.test(r)).map((r) => <Note key={r} tone="warn">{r}</Note>)}
      {(need0 || need1) && <Note tone="info">You need more {need0 && need1 ? "mUSDC and mWETH" : need0 ? "mUSDC" : "mWETH"}: mint some below.</Note>}
      <div className="flex flex-col gap-2">
        {approve0 && (
          <button className={btn.ghost} disabled={tx.busy} onClick={() => tx.run("Approve mUSDC", { address: ADDR.usdc, abi: erc20Abi, functionName: "approve", args: [vault.address as Address, maxUint256] })}>
            1 · Approve mUSDC
          </button>
        )}
        {approve1 && (
          <button className={btn.ghost} disabled={tx.busy} onClick={() => tx.run("Approve mWETH", { address: ADDR.weth, abi: erc20Abi, functionName: "approve", args: [vault.address as Address, maxUint256] })}>
            {approve0 ? "2" : "1"} · Approve mWETH
          </button>
        )}
        <button
          className={btn.primary}
          disabled={tx.busy || !shares || !q || blocking.length > 0 || need0 || need1 || approve0 || approve1}
          onClick={async () => {
            const rc = await tx.run("Deposit", { address: vault.address as Address, abi: vaultAbi, functionName: "deposit", args: [shares!, max0, max1] });
            if (rc) setAmt("");
            w.refetch();
          }}
        >
          {!shares ? "Enter shares" : blocking.length ? "Deposit unavailable" : approve0 || approve1 ? "Approve first" : "Deposit"}
        </button>
      </div>
      <TxStatus state={tx.state} />
      <Faucet />
    </div>
  );
}

function WithdrawPanel({ vault, pool }: { vault: VaultSummary; pool: PoolState }) {
  const w = useWalletState(vault.address as Address);
  const tx = useTx();
  const [amt, setAmt] = useState("");
  const shares = parseAmt(amt, 18);
  const supply = BigInt(vault.totalSupply || "0");
  const nav = vault.nav ? BigInt(vault.nav) : 0n;
  const myValue = supply > 0n ? (w.shares * nav) / supply : 0n;
  const quote = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(shares && supply > 0n), refetchInterval: 12_000 },
    contracts: [{ chainId: CHAIN_ID, address: vault.address as Address, abi: vaultAbi, functionName: "previewWithdraw", args: [shares ?? 0n] }],
  });
  const q = quote.data?.[0]?.status === "success" ? (quote.data[0].result as readonly [bigint, bigint]) : null;
  const tooMuch = shares != null && shares > w.shares;
  return (
    <div className="space-y-4">
      <div className="rows rounded-lg border border-line px-3">
        <Row k="Your shares" v={fmtEth(w.shares)} />
        <Row k="Share of vault" v={supply > 0n ? `${(Number((w.shares * 1_000_000n) / supply) / 10_000).toFixed(2)}%` : "–"} />
        <Row k="Value at NAV" v={`${fmtUsd((Number(myValue) / 1e18) * markPrice(pool))} · ${fmtEth(myValue)} mWETH`} />
      </div>
      <Field id="wd-amt" label="Shares to redeem" hint={<button type="button" className="hover:underline" onClick={() => setAmt(formatUnits(w.shares, 18))}>max</button>}>
        <input id="wd-amt" inputMode="decimal" placeholder="0.0" className={inputCls} value={amt} onChange={(x) => setAmt(x.target.value.replace(/[^0-9.]/g, ""))} />
      </Field>
      <div className="rows rounded-lg border border-line px-3">
        <Row k="You receive (approx.)" v={q ? `${fmtToken(q[0], 6)} mUSDC + ${fmtEth(q[1])} mWETH` : "–"} />
      </div>
      <Note tone="info">
        Paid out in kind, never blocked. Leaving mid-epoch forgoes this epoch&apos;s par guarantee; if the vault is ahead of par,
        your shares first pay their part of the pending bond refill and carry.
      </Note>
      {tooMuch && <Note tone="warn">You only have {fmtEth(w.shares)} shares.</Note>}
      <button
        className={btn.primary + " w-full"}
        disabled={tx.busy || !shares || tooMuch}
        onClick={async () => {
          const rc = await tx.run("Withdraw", { address: vault.address as Address, abi: vaultAbi, functionName: "withdraw", args: [shares!] });
          if (rc) setAmt("");
          w.refetch();
        }}
      >
        {!shares ? "Enter shares" : "Withdraw"}
      </button>
      <TxStatus state={tx.state} />
    </div>
  );
}

function SettlePanel({ vault }: { vault: VaultSummary }) {
  const tx = useTx();
  const now = useNow(1000);
  const e = epochInfo(vault, now);
  const needsPark = vault.fired && !vault.parked;
  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-bg-2 p-4 text-center">
        <div className="text-[12.5px] text-ink-2">{e.due ? "Epoch ended" : "Epoch ends in"}</div>
        <div className={`tnum mt-1 text-[28px] font-semibold tracking-tight ${e.due ? "text-bar-ink" : ""}`}>{e.due ? "Settle now" : fmtDuration(e.left)}</div>
        <div className="num mt-1 text-[12px] text-ink-2">epoch {fmtDuration(vault.epochSeconds)} · started {new Date(vault.epochStart * 1000).toISOString().slice(11, 16)} UTC</div>
      </div>
      <p className="text-[13.5px] leading-relaxed text-ink-2">
        <b className="font-semibold text-ink">settle()</b> is permissionless. It compares NAV with par: below par the bond pays depositors, above par the
        bond refills and the curator earns carry. If you are not the curator and the vault beat par, you receive{" "}
        <b className="font-semibold text-ink">{SETTLER_BOUNTY_BPS / 100}% of the carry</b> as shares (minted from the curator&apos;s cut, never from depositors).
      </p>
      <button className={btn.primary + " w-full"} disabled={tx.busy || !e.due} onClick={() => tx.run("Settle", { address: vault.address as Address, abi: vaultAbi, functionName: "settle", args: [] })}>
        {e.due ? "Settle epoch" : `Settle opens in ${fmtDuration(e.left)}`}
      </button>
      {needsPark && (
        <div className="space-y-2 border-t border-line pt-4">
          <p className="text-[13.5px] text-ink-2">This fired vault is not fully parked yet. Anyone can finish moving it to full range (same price checks as a rebalance).</p>
          <button className={btn.ghost + " w-full"} disabled={tx.busy} onClick={() => tx.run("Finish parking", { address: vault.address as Address, abi: vaultAbi, functionName: "rebalance", args: [0, 0] })}>
            Finish parking
          </button>
        </div>
      )}
      <TxStatus state={tx.state} />
    </div>
  );
}

function gate(vault: VaultSummary, pool: PoolState) {
  const dev = vault.maxTickDeviation;
  const near = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) <= dev;
  const checks = [
    { ok: near(pool.tick, pool.twap10Tick), label: `Spot vs 10-min TWAP`, d: pool.twap10Tick != null ? pool.tick - pool.twap10Tick : null, lim: dev },
    { ok: near(pool.tick, pool.referenceTick), label: `Spot vs block-open`, d: pool.referenceTick != null ? pool.tick - pool.referenceTick : null, lim: dev },
    { ok: near(pool.referenceTick, pool.twap10Tick), label: `Block-open vs 10-min TWAP`, d: pool.referenceTick != null && pool.twap10Tick != null ? pool.referenceTick - pool.twap10Tick : null, lim: dev },
    { ok: pool.twap10Tick != null && pool.twapTick != null && Math.abs(pool.twap10Tick - pool.twapTick) <= MAX_REBALANCES * dev, label: `10-min vs 30-min TWAP`, d: pool.twap10Tick != null && pool.twapTick != null ? pool.twap10Tick - pool.twapTick : null, lim: MAX_REBALANCES * dev },
  ];
  return { checks, ok: checks.every((c) => c.ok) };
}

export function GateStatus({ vault, pool }: { vault: VaultSummary; pool: PoolState }) {
  const g = gate(vault, pool);
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="mb-2 flex items-center justify-between text-[13px]">
        <span className="font-semibold">TWAP gate</span>
        <span className={g.ok ? "text-good" : "text-bad"}>{g.ok ? "passing: rebalance allowed" : "failing: rebalance would revert PriceDeviation"}</span>
      </div>
      <ul className="space-y-1 text-[12.5px]">
        {g.checks.map((c) => (
          <li key={c.label} className="num flex justify-between gap-2">
            <span className="text-ink-2">{c.label}</span>
            <span className={c.ok ? "text-good" : "text-bad"}>{c.d == null ? "n/a" : `${c.d > 0 ? "+" : ""}${c.d} ticks`} / ±{c.lim}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const PRESETS = [
  { id: "2", label: "±2%", w: 0.02 },
  { id: "5", label: "±5%", w: 0.05 },
  { id: "10", label: "±10%", w: 0.1 },
  { id: "25", label: "±25%", w: 0.25 },
  { id: "full", label: "Full", w: null },
] as const;

export function rangeForPreset(w: number | null, tick: number, spacing: number = 10) {
  if (w == null) return { lo: minUsableTick(), hi: maxUsableTick() };
  const p = usdPerEthFromTick(tick);
  const lo = alignTick(tickFromUsd(p * (1 + w)), spacing, "floor");
  const hi = alignTick(tickFromUsd(p * (1 - w)), spacing, "ceil");
  return { lo, hi };
}

export function RebalanceForm({ vault, pool, onDone }: { vault: VaultSummary; pool: PoolState; onDone?: () => void }) {
  const tx = useTx();
  const spacing = 10;
  const [preset, setPreset] = useState<string>("10");
  const [pLo, setPLo] = useState("");
  const [pHi, setPHi] = useState("");
  const [guard, setGuard] = useState(true);
  const range = useMemo(() => {
    if (preset !== "custom") return rangeForPreset(PRESETS.find((p) => p.id === preset)?.w ?? null, pool.tick, spacing);
    const a = Number(pLo), b = Number(pHi);
    if (!(a > 0 && b > a)) return null;
    return { lo: alignTick(tickFromUsd(b), spacing, "floor"), hi: alignTick(tickFromUsd(a), spacing, "ceil") };
  }, [preset, pLo, pHi, pool.tick]);
  const g = gate(vault, pool);
  const left = MAX_REBALANCES - vault.rebalancesThisEpoch;
  const blockers: string[] = [];
  if (!vault.fired && vault.status === "FROZEN") blockers.push("Bond below floor: post bond first (BondBelowFloor).");
  if (!vault.fired && left <= 0) blockers.push("All 4 rebalances used this epoch (TooManyRebalances).");
  if (BigInt(vault.totalSupply || "0") === 0n) blockers.push("No deposits yet: make the first deposit before ranging.");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" onClick={() => setPreset(p.id)} className={`rounded-md border px-3 py-1.5 text-[13px] font-medium ${preset === p.id ? "border-bar bg-bar-soft" : "border-line hover:bg-bg-2"}`}>
            {p.label}
          </button>
        ))}
        <button type="button" onClick={() => setPreset("custom")} className={`rounded-md border px-3 py-1.5 text-[13px] font-medium ${preset === "custom" ? "border-bar bg-bar-soft" : "border-line hover:bg-bg-2"}`}>
          Custom
        </button>
      </div>
      {preset === "custom" && (
        <div className="grid grid-cols-2 gap-2">
          <Field id="rb-lo" label="Min price (USDC/ETH)">
            <input id="rb-lo" inputMode="decimal" className={inputCls} value={pLo} placeholder={String(Math.round(pool.price * 0.9))} onChange={(e) => setPLo(e.target.value.replace(/[^0-9.]/g, ""))} />
          </Field>
          <Field id="rb-hi" label="Max price (USDC/ETH)">
            <input id="rb-hi" inputMode="decimal" className={inputCls} value={pHi} placeholder={String(Math.round(pool.price * 1.1))} onChange={(e) => setPHi(e.target.value.replace(/[^0-9.]/g, ""))} />
          </Field>
        </div>
      )}
      <RangeBar lo={vault.lo} hi={vault.hi} tick={pool.tick} twapTick={pool.twap10Tick} preview={range} liquidity={vault.liquidity} />
      {range && <p className="num text-[12.5px] text-ink-2">New range: ticks {range.lo} → {range.hi} (aligned to spacing {spacing}) · ${usdPerEthFromTick(range.hi).toFixed(0)} – ${usdPerEthFromTick(range.lo).toFixed(0)}</p>}
      <GateStatus vault={vault} pool={pool} />
      <label className="flex items-start gap-2 text-[13px]">
        <input type="checkbox" checked={guard} onChange={(e) => setGuard(e.target.checked)} className="mt-0.5 accent-[var(--bar)]" />
        <span>Revert if more than 2% of NAV stays idle (front-run guard; keeps the rebalance slot)</span>
      </label>
      {blockers.map((b) => <Note key={b} tone="warn">{b}</Note>)}
      <button
        className={btn.primary + " w-full"}
        disabled={tx.busy || !range || blockers.length > 0}
        onClick={async () => {
          const rc = await tx.run("Rebalance", {
            address: vault.address as Address,
            abi: vaultAbi,
            functionName: "rebalance",
            args: guard ? [range!.lo, range!.hi, 200] : [range!.lo, range!.hi],
          });
          if (rc) onDone?.();
        }}
      >
        {g.ok ? "Rebalance" : "Rebalance (gate failing, will revert)"} <span className="num text-[13px] font-normal opacity-70">{left}/{MAX_REBALANCES} left</span>
      </button>
      <TxStatus state={tx.state} />
    </div>
  );
}

export function PostBondForm({ vault, onDone }: { vault: VaultSummary; onDone?: () => void }) {
  const w = useWalletState(vault.address as Address);
  const tx = useTx();
  const nav = vault.nav ? BigInt(vault.nav) : 0n;
  const bv = BigInt(vault.bondValue ?? vault.bond ?? "0");
  const toFloor = (nav * BigInt(vault.minBondBps)) / 10_000n;
  const suggest = nav > 0n ? ((nav * BigInt(vault.minBondBps) * 3n) / 2n / 10_000n > bv ? (nav * BigInt(vault.minBondBps) * 3n) / 2n / 10_000n - bv : 0n) : 10n ** 17n;
  const [amt, setAmt] = useState("");
  const v = parseAmt(amt, 18);
  const needApprove = v != null && w.allow1 < v;
  return (
    <div className="space-y-3">
      <div className="rows rounded-lg border border-line px-3">
        <Row k="Bond now" v={`${fmtEth(bv)} mWETH`} />
        <Row k="Floor at current NAV" v={`${fmtEth(toFloor)} mWETH`} />
        <Row k="Your mWETH" v={fmtEth(w.bal1)} />
      </div>
      <Field id="bond-amt" label="Bond to post (mWETH)" hint={suggest > 0n ? <button type="button" className="hover:underline" onClick={() => setAmt(formatUnits(suggest, 18))}>suggest {fmtEth(suggest)} (1.5× floor)</button> : undefined}>
        <input id="bond-amt" inputMode="decimal" className={inputCls} placeholder="0.1" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
      </Field>
      {v != null && v > w.bal1 && <Note tone="warn">Not enough mWETH: mint some on the Deposit tab faucet.</Note>}
      {needApprove ? (
        <button className={btn.ghost + " w-full"} disabled={tx.busy} onClick={async () => { await tx.run("Approve mWETH", { address: ADDR.weth, abi: erc20Abi, functionName: "approve", args: [vault.address as Address, maxUint256] }); w.refetch(); }}>
          Approve mWETH
        </button>
      ) : (
        <button className={btn.primary + " w-full"} disabled={tx.busy || !v || v > w.bal1 || vault.fired} onClick={async () => { const rc = await tx.run("Post bond", { address: vault.address as Address, abi: vaultAbi, functionName: "postBond", args: [v!] }); if (rc) { setAmt(""); onDone?.(); } w.refetch(); }}>
          {vault.fired ? "Fired: no bond needed" : "Post bond"}
        </button>
      )}
      <TxStatus state={tx.state} />
    </div>
  );
}

function CuratorPanel({ vault, pool }: { vault: VaultSummary; pool: PoolState }) {
  const tx = useTx();
  const now = useNow(1000);
  const canReclaim = vault.fired && vault.parked && now >= vault.firedAt + vault.epochSeconds;
  return (
    <div className="space-y-6">
      {vault.fired ? (
        <div className="space-y-3">
          <Note tone="bad">
            You were fired at {new Date(vault.firedAt * 1000).toUTCString().slice(5, 22)} UTC. The vault is {vault.parked ? "parked full range" : "being parked"}.
            One epoch after firing you can reclaim what is left of the bond.
          </Note>
          <button className={btn.primary + " w-full"} disabled={tx.busy || !canReclaim} onClick={() => tx.run("Reclaim bond", { address: vault.address as Address, abi: vaultAbi, functionName: "reclaimBond", args: [] })}>
            {canReclaim ? "Reclaim bond" : !vault.parked ? "Reclaim after parking completes" : `Reclaim in ${fmtDuration(vault.firedAt + vault.epochSeconds - now)}`}
          </button>
          <TxStatus state={tx.state} />
        </div>
      ) : (
        <>
          <section>
            <h3 className="mb-3 text-[14px] font-semibold">Post bond</h3>
            <PostBondForm vault={vault} />
          </section>
          <section className="border-t border-line pt-5">
            <h3 className="mb-3 text-[14px] font-semibold">Rebalance</h3>
            <RebalanceForm vault={vault} pool={pool} />
          </section>
        </>
      )}
    </div>
  );
}
