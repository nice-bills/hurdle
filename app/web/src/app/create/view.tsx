"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { decodeEventLog, isAddress, maxUint256, parseUnits, type Address } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { erc20Abi, factoryAbi, vaultAbi } from "@/shared/abis";
import { ADDR, CHAIN_ID, POOL_KEY } from "@/lib/chain";
import { useVaultDetail } from "@/lib/hooks";
import { fmtEth, fmtNum, fmtToken, short } from "@/lib/format";
import { usdPerEthFromTick } from "@/lib/math";
import { TxStatus, useTx } from "@/lib/tx";
import type { PoolState, VaultSummary } from "@/lib/types";
import { PostBondForm, RebalanceForm } from "@/components/actions";
import { Address as Addr, Note, btn, inputCls } from "@/components/ui";
import { IconArrow, IconCheck } from "@/components/icons";

type Params = { carry: string; minBond: string; dev: string; epoch: string };
const DEFAULTS: Params = { carry: "20", minBond: "2", dev: "50", epoch: "3600" };

function validate(p: Params) {
  const carry = Math.round(Number(p.carry) * 100), minBond = Math.round(Number(p.minBond) * 100), dev = Math.round(Number(p.dev)), epoch = Math.round(Number(p.epoch));
  const errs: Partial<Record<keyof Params, string>> = {};
  if (!(carry >= 0 && carry <= 5000)) errs.carry = "Between 0% and 50%.";
  if (!(minBond >= 100 && minBond <= 5000)) errs.minBond = "Between 1% and 50%.";
  if (!(dev > 0)) errs.dev = "Must be above 0.";
  else if (4 * dev > minBond) errs.dev = `4 × deviation must be ≤ minBond in bps (${minBond}): max ${Math.floor(minBond / 4)}.`;
  if (!(epoch >= 600)) errs.epoch = "At least 600 seconds.";
  return { carry, minBond, dev, epoch, errs, ok: Object.keys(errs).length === 0 };
}

export function CreateView() {
  const sp = useSearchParams();
  const vault = sp.get("vault");
  const { address } = useAccount();
  return (
    <div className="pt-10">
      <h1 className="text-[32px] font-bold tracking-[-0.03em]">Create a vault</h1>
      <p className="mt-1 max-w-[66ch] text-ink-2">
        You become the curator: you set the range, you guarantee par, your bond pays any miss. Four steps, all on the canonical Hurdle
        mUSDC/mWETH pool.
      </p>
      {!address && (
        <div className="mt-6 flex flex-wrap items-center gap-4 rounded-xl border border-line bg-bg-2 p-4">
          <span className="text-[14px]">Connect the wallet that will curate this vault.</span>
          <ConnectButton label="Connect wallet" showBalance={false} />
        </div>
      )}
      {vault && isAddress(vault) ? <Steps vault={vault} /> : <Steps vault={null} />}
    </div>
  );
}

function Step({ n, title, state, children }: { n: number; title: string; state: "done" | "active" | "todo"; children?: ReactNode }) {
  return (
    <li className="relative pl-12">
      <span
        className={`num absolute left-0 top-0 grid h-8 w-8 place-items-center rounded-full border text-[13px] font-semibold ${
          state === "done" ? "border-good bg-good-soft text-good" : state === "active" ? "border-bar bg-bar text-on-bar" : "border-line text-ink-3"
        }`}
      >
        {state === "done" ? <IconCheck size={15} strokeWidth={2.4} /> : n}
      </span>
      <h2 className={`pt-1 text-[17px] font-semibold ${state === "todo" ? "text-ink-3" : ""}`}>{title}</h2>
      {state === "active" && <div className="fade-in mt-4">{children}</div>}
    </li>
  );
}

function Steps({ vault }: { vault: string | null }) {
  const q = useVaultDetail(vault ?? "0x0000000000000000000000000000000000000000");
  const d = vault ? q.data : undefined;
  const v = d?.vault;
  const { address } = useAccount();
  const bonded = v ? BigInt(v.bond) > 0n : false;
  const deposited = v ? BigInt(v.totalSupply) > 0n : false;
  const ranged = v ? BigInt(v.liquidity) > 0n : false;
  const notCurator = v && address && v.curator.toLowerCase() !== address.toLowerCase();
  const state = (i: number): "done" | "active" | "todo" => {
    const done = [Boolean(v), bonded, deposited, ranged];
    if (done[i]) return "done";
    return done.slice(0, i).every(Boolean) ? "active" : "todo";
  };
  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
      <ol className="space-y-8 border-l border-line pl-0 [&>li]:-ml-4">
        <Step n={1} title="Set the terms" state={vault && !v && q.isLoading ? "active" : state(0)}>
          {vault && q.isLoading ? <p className="text-ink-2">Loading vault {short(vault)}…</p> : <CreateForm />}
        </Step>
        <Step n={2} title="Post a bond" state={state(1)}>
          {v && <BondStep v={v} />}
        </Step>
        <Step n={3} title="Make the first deposit" state={state(2)}>
          {v && d && <FirstDeposit v={v} pool={d.pool} />}
        </Step>
        <Step n={4} title="Deploy the first range" state={state(3)}>
          {v && d && <RebalanceForm vault={v} pool={d.pool} onDone={() => q.refetch()} />}
        </Step>
        {v && ranged && (
          <li className="pl-12">
            <Note tone="good">
              The vault is live. Settle runs every {fmtNum(v.epochSeconds / 60, 0)} minutes; open deposits to others in each window.{" "}
              <Link href={`/vaults/${v.address}`} className="font-semibold underline">Open the vault page</Link>
            </Note>
          </li>
        )}
      </ol>
      <aside className="space-y-4 text-[13.5px] text-ink-2 lg:sticky lg:top-20 lg:self-start">
        {v && (
          <div className="rounded-xl border border-line bg-surface p-4 text-ink">
            <div className="text-[12.5px] text-ink-2">Your vault</div>
            <Addr value={v.address} className="mt-1" />
            <div className="num mt-2 text-[13px] text-ink-2">carry {v.carryBps / 100}% · floor {v.minBondBps / 100}% · dev {v.maxTickDeviation} · epoch {v.epochSeconds}s</div>
          </div>
        )}
        {notCurator && <Note tone="warn">The connected wallet is not this vault&apos;s curator ({short(v!.curator)}). Steps 2–4 are curator-only.</Note>}
        <div className="rounded-xl border border-line p-4">
          <h3 className="mb-2 text-[13.5px] font-semibold text-ink">What you are signing up for</h3>
          <ul className="space-y-2">
            <li>Each epoch the vault settles against par. A miss is paid from your bond.</li>
            <li>A miss that leaves the bond under half the floor fires you; the vault parks passive. You reclaim what is left one epoch later.</li>
            <li>Capacity is bond ÷ floor: a 0.1 mWETH bond at 2% caps the vault at 5 mWETH of NAV.</li>
          </ul>
        </div>
      </aside>
    </div>
  );
}

function NumField({ id, label, unit, value, onChange, err, help }: { id: string; label: string; unit: string; value: string; onChange: (s: string) => void; err?: string; help: string }) {
  return (
    <div>
      <label htmlFor={id} className="text-[13px] font-medium">{label}</label>
      <div className="relative mt-1.5">
        <input id={id} inputMode="decimal" aria-invalid={Boolean(err)} aria-describedby={`${id}-h`} className={inputCls + (err ? " border-bad focus:border-bad" : "") + " pr-16"} value={value} onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))} />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-ink-2">{unit}</span>
      </div>
      <p id={`${id}-h`} className={`mt-1 text-[12.5px] ${err ? "text-bad" : "text-ink-2"}`}>{err ?? help}</p>
    </div>
  );
}

function CreateForm() {
  const router = useRouter();
  const tx = useTx();
  const { address } = useAccount();
  const [p, setP] = useState<Params>(DEFAULTS);
  const val = validate(p);
  const set = (k: keyof Params) => (s: string) => setP((x) => ({ ...x, [k]: s }));
  return (
    <div className="space-y-5 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <NumField id="c-carry" label="Carry" unit="%" value={p.carry} onChange={set("carry")} err={val.errs.carry} help="Your share of returns above par, after refilling any bond paid out." />
        <NumField id="c-bond" label="Bond floor (minBond)" unit="% NAV" value={p.minBond} onChange={set("minBond")} err={val.errs.minBond} help="Below this, deposits and rebalances freeze. Half of it is the fire line." />
        <NumField id="c-dev" label="Max tick deviation" unit="ticks" value={p.dev} onChange={set("dev")} err={val.errs.dev} help="How far spot, block-open price and TWAP may differ when you rebalance (50 ≈ 0.5%)." />
        <NumField id="c-epoch" label="Epoch" unit="seconds" value={p.epoch} onChange={set("epoch")} err={val.errs.epoch} help="Settlement period. Deposits open for the first 5 minutes of each." />
      </div>
      <div className="rounded-lg bg-bg-2 px-3 py-2.5 font-mono text-[12px] text-ink-2 break-all">
        factory.create(poolKey, {val.carry}, {val.minBond}, {val.dev}, {val.epoch})
      </div>
      <button
        className={btn.primary + " w-full sm:w-auto"}
        disabled={!val.ok || tx.busy || !address}
        onClick={async () => {
          const rc = await tx.run("Create vault", { address: ADDR.factory, abi: factoryAbi, functionName: "create", args: [POOL_KEY, val.carry, val.minBond, val.dev, val.epoch] });
          if (!rc) return;
          for (const log of rc.logs) {
            try {
              const ev = decodeEventLog({ abi: factoryAbi, data: log.data, topics: log.topics });
              if (ev.eventName === "VaultCreated") {
                router.replace(`/create?vault=${(ev.args as { vault: string }).vault}`, { scroll: false });
                return;
              }
            } catch {}
          }
        }}
      >
        Create vault <IconArrow size={16} />
      </button>
      <TxStatus state={tx.state} />
    </div>
  );
}

function BondStep({ v }: { v: VaultSummary }) {
  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <p className="text-[13.5px] text-ink-2">
        The bond is posted in mWETH and is what pays depositors when you miss par. It also sets your capacity: plan the first deposit at most bond ÷ {v.minBondBps / 100}%.
        Need mWETH? Mint it on any vault&apos;s Deposit tab or on the swap page.
      </p>
      <PostBondForm vault={v} />
    </div>
  );
}

function FirstDeposit({ v, pool }: { v: VaultSummary; pool: PoolState }) {
  const tx = useTx();
  const { address } = useAccount();
  const [a0s, setA0] = useState("3000");
  const [a1s, setA1] = useState("1");
  const [recv, setRecv] = useState("");
  const toAmt = (s: string, dec: number) => { try { return s ? parseUnits(s as `${number}`, dec) : 0n; } catch { return 0n; } };
  const a0 = toAmt(a0s, 6), a1 = toAmt(a1s, 18);
  const receiver = (recv && isAddress(recv) ? recv : address) as Address | undefined;
  const me = address ?? ADDR.factory;
  const r = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(address), refetchInterval: 10_000 },
    contracts: [
      { chainId: CHAIN_ID, address: ADDR.usdc, abi: erc20Abi, functionName: "balanceOf", args: [me] },
      { chainId: CHAIN_ID, address: ADDR.weth, abi: erc20Abi, functionName: "balanceOf", args: [me] },
      { chainId: CHAIN_ID, address: ADDR.usdc, abi: erc20Abi, functionName: "allowance", args: [me, v.address as Address] },
      { chainId: CHAIN_ID, address: ADDR.weth, abi: erc20Abi, functionName: "allowance", args: [me, v.address as Address] },
    ],
  });
  const g = (i: number) => (r.data?.[i]?.status === "success" ? (r.data[i].result as bigint) : 0n);
  const [b0, b1, al0, al1] = [g(0), g(1), g(2), g(3)];
  const price = pool.twapTick != null ? usdPerEthFromTick(pool.twapTick) : pool.price;
  const valueEth = Number(a0) / 1e6 / price + Number(a1) / 1e18;
  const bondEth = Number(v.bondValue ?? v.bond) / 1e18;
  const capEth = bondEth / (v.minBondBps / 1e4);
  const over = valueEth > capEth;
  const self = receiver && receiver.toLowerCase() === v.curator.toLowerCase();
  const needs = useMemo(() => [a0 > al0 && "usdc", a1 > al1 && "weth"].filter(Boolean) as string[], [a0, a1, al0, al1]);
  return (
    <div className="space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <p className="text-[13.5px] text-ink-2">Valued at the TWAP and left idle until your first rebalance. Later deposits from anyone are in kind, in each epoch&apos;s window.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="fd-0" className="text-[13px] font-medium">mUSDC</label>
          <input id="fd-0" inputMode="decimal" className={inputCls + " mt-1.5"} value={a0s} onChange={(e) => setA0(e.target.value.replace(/[^0-9.]/g, ""))} />
          <p className="num mt-1 text-[12px] text-ink-2">balance {fmtToken(b0, 6)}</p>
        </div>
        <div>
          <label htmlFor="fd-1" className="text-[13px] font-medium">mWETH</label>
          <input id="fd-1" inputMode="decimal" className={inputCls + " mt-1.5"} value={a1s} onChange={(e) => setA1(e.target.value.replace(/[^0-9.]/g, ""))} />
          <p className="num mt-1 text-[12px] text-ink-2">balance {fmtEth(b1)}</p>
        </div>
      </div>
      <div>
        <label htmlFor="fd-r" className="text-[13px] font-medium">Shares go to</label>
        <input id="fd-r" className={inputCls + " mt-1.5 font-mono text-[13px]"} placeholder={address ?? "0x…"} value={recv} onChange={(e) => setRecv(e.target.value.trim())} />
        <p className="mt-1 text-[12.5px] text-ink-2">Default: you. A separate depositor address is covered by your bond; your own shares are not.</p>
      </div>
      <div className="rows rounded-lg border border-line px-3 text-[13.5px]">
        <div className="flex justify-between py-1.5"><span className="text-ink-2">Value at TWAP (${fmtNum(price, 0)})</span><span className="num font-medium">{fmtNum(valueEth, 4)} mWETH</span></div>
        <div className="flex justify-between py-1.5"><span className="text-ink-2">Capacity from bond</span><span className={`num font-medium ${over ? "text-bad" : ""}`}>{fmtNum(capEth, 4)} mWETH</span></div>
      </div>
      {over && <Note tone="warn">Over capacity: this would revert CapacityExceeded. Lower the amounts or post more bond.</Note>}
      {self && <Note tone="info">Shares to the curator are not covered by the bond: on a miss they take their part of the loss.</Note>}
      {(a0 > b0 || a1 > b1) && (
        <div className="flex flex-wrap gap-2">
          {a0 > b0 && <button className={btn.ghost} disabled={tx.busy} onClick={() => tx.run("Mint mUSDC", { address: ADDR.usdc, abi: erc20Abi, functionName: "mint", args: [address!, a0 - b0 + 10n ** 6n] })}>Mint mUSDC</button>}
          {a1 > b1 && <button className={btn.ghost} disabled={tx.busy} onClick={() => tx.run("Mint mWETH", { address: ADDR.weth, abi: erc20Abi, functionName: "mint", args: [address!, a1 - b1 + 10n ** 16n] })}>Mint mWETH</button>}
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        {needs.includes("usdc") && <button className={btn.ghost} disabled={tx.busy} onClick={async () => { await tx.run("Approve mUSDC", { address: ADDR.usdc, abi: erc20Abi, functionName: "approve", args: [v.address as Address, maxUint256] }); r.refetch(); }}>Approve mUSDC</button>}
        {needs.includes("weth") && <button className={btn.ghost} disabled={tx.busy} onClick={async () => { await tx.run("Approve mWETH", { address: ADDR.weth, abi: erc20Abi, functionName: "approve", args: [v.address as Address, maxUint256] }); r.refetch(); }}>Approve mWETH</button>}
        <button
          className={btn.primary}
          disabled={tx.busy || !receiver || over || needs.length > 0 || a0 > b0 || a1 > b1 || a0 + a1 === 0n}
          onClick={() => tx.run("First deposit", { address: v.address as Address, abi: vaultAbi, functionName: "firstDeposit", args: [a0, a1, receiver!] })}
        >
          Deposit and start the vault
        </button>
      </div>
      <TxStatus state={tx.state} />
    </div>
  );
}
