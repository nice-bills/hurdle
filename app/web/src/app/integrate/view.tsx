"use client";

import { useState } from "react";
import { D, EXPLORER, POOL_ID } from "@/lib/chain";
import { ERROR_TEXT } from "@/lib/errors";
import { Address as Addr } from "@/components/ui";
import { Code, CopyButton } from "@/components/code";
import { IconDownload } from "@/components/icons";

const ADDRS: { name: string; value: string; note: string }[] = [
  { name: "HurdleHook", value: D.hook, note: "Uniswap v4 hook: TWAP oracle and price gate (par math lives in the vault)" },
  { name: "HurdleVaultFactory", value: D.factory, note: "create(), isVault(), VaultCreated events" },
  { name: "Patient vault", value: D.patientVault, note: "±10% range, re-centered by the demo bot near its edges" },
  { name: "Chaser vault", value: D.chaserVault, note: "±2% range, re-centered by the demo bot" },
  { name: "Reckless vault", value: D.recklessVault, note: "±1% range, 2.5% bond, built to get fired" },
  { name: "mUSDC (currency0)", value: D.mUSDC, note: "6 decimals, public mint()" },
  { name: "mWETH (currency1)", value: D.mWETH, note: "18 decimals, the bond token, public mint()" },
  { name: "PoolManager", value: D.poolManager, note: "Uniswap v4 singleton" },
  { name: "PoolSwapTest", value: D.swapRouter, note: "swap router used by /swap and the keeper" },
];

const ABIS = [
  { file: "HurdleVault.json", note: "vault views, deposit / withdraw / settle / rebalance, events and errors" },
  { file: "HurdleVaultFactory.json", note: "create() and VaultCreated" },
  { file: "HurdleHook.json", note: "oracle views (consult, twapTick, referenceTick, referenceFeeGrowth, oracleState) and hook errors" },
  { file: "PoolSwapTest.json", note: "swap router" },
  { file: "MockERC20.json", note: "mUSDC / mWETH incl. public mint" },
  { file: "deployment-1301.json", note: "every address above, plus fee, tickSpacing and the start block" },
];

const SETUP = `
import { createPublicClient, createWalletClient, http, parseUnits, maxUint256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";
import vaultAbi from "./HurdleVault.json";        // download links above
import factoryAbi from "./HurdleVaultFactory.json";
import erc20Abi from "./MockERC20.json";

export const unichainSepolia = defineChain({
  id: 1301,
  name: "Unichain Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia.unichain.org"] } },
});

export const VAULT = "${D.patientVault}";
export const USDC = "${D.mUSDC}";   // currency0, 6 decimals
export const WETH = "${D.mWETH}";   // currency1, 18 decimals, also the bond token

export const publicClient = createPublicClient({ chain: unichainSepolia, transport: http() });
export const account = privateKeyToAccount(process.env.PRIVATE_KEY as \`0x\${string}\`);
export const wallet = createWalletClient({ account, chain: unichainSepolia, transport: http() });

// One helper: simulate first (decodes custom errors for free), then send, then wait.
export async function send(req: Parameters<typeof publicClient.simulateContract>[0]) {
  const { request } = await publicClient.simulateContract({ ...req, account });
  const hash = await wallet.writeContract(request);
  return publicClient.waitForTransactionReceipt({ hash });
}
`;

const READ = `
// Everything is a view call. Amounts are raw integers: shares and mWETH have 18 decimals, mUSDC has 6.
const [nav, bondValue, deficit, fired, supply] = await Promise.all([
  publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "nav" }),        // mWETH wei
  publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "bondValue" }),  // bond in mWETH wei
  publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "deficit" }),
  publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "fired" }),
  publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "totalSupply" }),
]);

const bondPctOfNav = Number((bondValue * 10_000n) / nav) / 100;   // floor is minBondBps / 100 %
const [lo, hi, liquidity] = await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "position" });
`;

const DEPOSIT = `
// Deposits are in kind (mUSDC + mWETH), priced pro rata to what the vault holds.
// Window: the first 5 minutes of an epoch (DEPOSIT_WINDOW = 300 s). A deposit at or after the epoch end settles it first.
const shares = parseUnits("0.1", 18);

const [need0, need1] = await publicClient.readContract({
  address: VAULT, abi: vaultAbi, functionName: "previewDeposit", args: [shares],
});
const max0 = need0 + need0 / 100n + 1n;   // 1% slack
const max1 = need1 + need1 / 100n + 1n;

// Approve once per token (the vault pulls with transferFrom).
await send({ address: USDC, abi: erc20Abi, functionName: "approve", args: [VAULT, maxUint256] });
await send({ address: WETH, abi: erc20Abi, functionName: "approve", args: [VAULT, maxUint256] });

// Reverts: DepositWindowClosed, DeficitOutstanding, NotParked (fired vault not parked yet), CapacityExceeded, Slippage, ZeroShares, PriceDeviation, InsufficientHistory.
await send({ address: VAULT, abi: vaultAbi, functionName: "deposit", args: [shares, max0, max1] });
`;

const WITHDRAW = `
// Withdrawals are pro rata in kind, never blocked by the price gate or the epoch.
const mine = await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "balanceOf", args: [account.address] });
const [out0, out1] = await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "previewWithdraw", args: [mine] });
await send({ address: VAULT, abi: vaultAbi, functionName: "withdraw", args: [mine] });
`;

const SETTLE = `
// settle() is permissionless once epochStart + epochSeconds has passed.
// If you are not the curator and the vault beat par you are paid 5% of the carry, minted as vault shares.
const [epochStart, epochSeconds] = await Promise.all([
  publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "epochStart" }),
  publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "epochSeconds" }),
]);
const block = await publicClient.getBlock();
if (block.timestamp >= epochStart + BigInt(epochSeconds)) {
  await send({ address: VAULT, abi: vaultAbi, functionName: "settle" });   // reverts EpochNotOver if early
}
`;

const CREATE = `
// Anyone can create a vault; the caller becomes its curator.
const poolKey = {
  currency0: "${D.currency0}",
  currency1: "${D.currency1}",
  fee: ${D.fee},
  tickSpacing: ${D.tickSpacing},
  hooks: "${D.hook}",
};
//                carryBps  minBondBps  maxTickDeviation  epochSeconds
const args = [poolKey, 2000,     200,         50,               3600];
//  carry 20% (max 50%) · bond floor 2% of NAV (1%..50%) · 4 * maxTickDeviation <= minBondBps · epoch >= 600 s

const rc = await send({ address: "${D.factory}", abi: factoryAbi, functionName: "create", args });
// The new vault address is the first topic after the event signature (topics[1]) of VaultCreated(vault, curator, poolId) in the receipt,
// or decodeEventLog(...).args.vault.

// Then, as the curator:
//   1. postBond(amount1)                     mWETH, approve first. The bond is what pays a miss.
//   2. firstDeposit(amount0, amount1, you)   seeds the vault. The curator is the only one who can.
//   3. rebalance(tickLower, tickUpper)       choose the range. Ticks must be multiples of ${D.tickSpacing}.
`;

const BOT = `
// A curator bot is a loop around three questions: is the epoch over, is my range stale, is the price gate open?
import { parseAbiItem } from "viem";

const POOL_ID = "${POOL_ID}";

async function tick() {
  const [epochStart, epochSeconds, fired, rebalances] = await Promise.all([
    publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "epochStart" }),
    publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "epochSeconds" }),
    publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "fired" }),
    publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "rebalancesThisEpoch" }),
  ]);
  const { timestamp } = await publicClient.getBlock();

  // 1. Settle first. It resets the rebalance counter and books carry or pays the bond.
  if (timestamp >= epochStart + BigInt(epochSeconds)) await send({ address: VAULT, abi: vaultAbi, functionName: "settle" });
  if (fired) return;

  // 2. Re-center when spot leaves the middle of your range. 4 rebalances per epoch.
  const [lo, hi] = await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "position" });
  const tick = await currentTick();   // slot0 of the PoolManager, see StateLibrary.getSlot0
  const edge = (hi - lo) / 4;
  if (rebalances < 4 && (tick < lo + edge || tick > hi - edge)) {
    const width = Math.round((hi - lo) / 2 / ${D.tickSpacing}) * ${D.tickSpacing};
    const center = Math.round(tick / ${D.tickSpacing}) * ${D.tickSpacing};
    try {
      // the third argument bounds idle value after the swap, in bps of NAV (200 = 2%): a built-in front-run guard
      await send({ address: VAULT, abi: vaultAbi, functionName: "rebalance", args: [center - width, center + width, 200] });
    } catch (e) {
      // PriceDeviation: spot, block-open price and the 10-min TWAP disagree. Wait and retry next tick, do not force it.
      console.warn("rebalance skipped:", (e as Error).message);
    }
  }

  // 3. Keep the bond above the floor (minBondBps of NAV), or deposits freeze and then the vault is fired.
  const bondValue = await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "bondValue" });
  const nav = await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "nav" });
  const minBondBps = await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "minBondBps" });
  if (bondValue * 10_000n < nav * BigInt(minBondBps)) {
    await send({ address: VAULT, abi: vaultAbi, functionName: "postBond", args: [nav * BigInt(minBondBps) / 10_000n / 2n] });
  }
}

setInterval(() => tick().catch(console.error), 60_000);
`;

const EVENTS = `
// Index the track record from events. Settled is the scoreboard: it carries NAV and par (bench) for each epoch.
const head = await publicClient.getBlockNumber();
const logs = [];
for (let from = ${D.factoryStartBlock}n; from <= head; from += 1000n) {
  const to = from + 999n < head ? from + 999n : head;
  logs.push(...(await publicClient.getContractEvents({ address: VAULT, abi: vaultAbi, eventName: "Settled", fromBlock: from, toBlock: to })));
}
// Settled(nav, bench, take, shortfallPaid, bond, sqrtPriceX96)
//   nav vs bench is the epoch's result against par. shortfallPaid > 0 means the bond paid depositors.
// The loop pages in windows of at most 1,000 blocks: the public RPC rejects wider ranges.
`;

const TABS = [
  { id: "setup", label: "Setup", code: SETUP, title: "client.ts", blurb: "A typed viem client, plus one helper that simulates before sending so every custom error is decoded." },
  { id: "read", label: "Read a vault", code: READ, title: "read.ts", blurb: "Every number on the vault page is a plain view call." },
  { id: "deposit", label: "Deposit", code: DEPOSIT, title: "deposit.ts", blurb: "previewDeposit quotes the exact mUSDC and mWETH; approve once; deposit with 1% slack." },
  { id: "withdraw", label: "Withdraw", code: WITHDRAW, title: "withdraw.ts", blurb: "Pro-rata in kind. Never blocked." },
  { id: "settle", label: "Settle", code: SETTLE, title: "settle.ts", blurb: "Permissionless. The settler earns 5% of any carry." },
  { id: "create", label: "Create a vault", code: CREATE, title: "create.ts", blurb: "One factory call makes you a curator." },
  { id: "bot", label: "Curator bot", code: BOT, title: "bot.ts", blurb: "A minimal loop that settles, re-centers, and keeps the bond healthy." },
  { id: "events", label: "Events", code: EVENTS, title: "events.ts", blurb: "How to rebuild a vault's track record." },
] as const;

export function IntegrateView() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("setup");
  const active = TABS.find((t) => t.id === tab)!;
  const allAddrs = ADDRS.map((a) => `${a.name}: ${a.value}`).join("\n");
  return (
    <div className="pt-10">
      <p className="text-[12.5px] font-semibold uppercase tracking-[0.1em] text-bar-ink">Developers</p>
      <h1 className="mt-1 text-[32px] font-bold tracking-[-0.03em] sm:text-[40px]">Integrate Hurdle</h1>
      <p className="mt-2 max-w-[68ch] text-[16px] text-ink-2">
        Everything here is on Unichain Sepolia (chain 1301). Vaults are plain contracts: read them, deposit into them, settle them, or run one.
        No SDK, no API key. The ABIs and addresses below are the ones this app uses.
      </p>

      <nav aria-label="On this page" className="mt-5 flex flex-wrap gap-2 text-[13.5px]">
        {[["#addresses", "Addresses"], ["#abis", "ABIs"], ["#snippets", "Snippets"], ["#errors", "Errors"], ["#rpc", "Network"]].map(([h, l]) => (
          <a key={h} href={h} className="rounded-full border border-line px-3 py-1 text-ink-2 hover:border-line-2 hover:text-ink">{l}</a>
        ))}
      </nav>

      <section id="addresses" className="mt-10 scroll-mt-24">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-[20px] font-semibold">Addresses</h2>
          <CopyButton text={allAddrs} label="Copy all" />
        </div>
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <ul className="rows">
            {ADDRS.map((a) => (
              <li key={a.name} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold">{a.name}</div>
                  <div className="text-[12.5px] text-ink-2">{a.note}</div>
                </div>
                <Addr value={a.value} chars={6} className="shrink-0" />
              </li>
            ))}
          </ul>
        </div>
        <p className="mt-2 text-[13px] text-ink-2">
          Pool key: fee {D.fee} ({(D.fee / 10000).toFixed(2)}%), tickSpacing {D.tickSpacing}, hooks = HurdleHook. Pool id{" "}
          <span className="break-all font-mono text-[12px]">{POOL_ID}</span>.
        </p>
      </section>

      <section id="abis" className="mt-12 scroll-mt-24">
        <h2 className="mb-3 text-[20px] font-semibold">ABIs</h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {ABIS.map((a) => (
            <li key={a.file}>
              <a
                href={`/abi/${a.file}`}
                download={a.file}
                className="group flex h-full items-start gap-3 rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-2 hover:bg-bg-2"
              >
                <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-bar-soft text-bar-ink"><IconDownload size={16} /></span>
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[13.5px] font-semibold">{a.file}</span>
                  <span className="block text-[12.5px] leading-snug text-ink-2">{a.note}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section id="snippets" className="mt-12 scroll-mt-24">
        <h2 className="mb-1 text-[20px] font-semibold">Snippets</h2>
        <p className="mb-4 text-[14px] text-ink-2">viem v2, TypeScript. Copy, set PRIVATE_KEY, run.</p>
        <div role="tablist" aria-label="Snippets" className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="snippet-panel"
              onClick={() => setTab(t.id)}
              className={`relative shrink-0 px-3 py-3 text-[14px] font-medium transition-colors ${tab === t.id ? "text-ink" : "text-ink-2 hover:text-ink"}`}
            >
              {t.label}
              {tab === t.id && <span className="bar-hatch absolute inset-x-2 -bottom-px h-[3px] rounded-full" />}
            </button>
          ))}
        </div>
        <div id="snippet-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="mt-4 space-y-3">
          <p className="text-[14px] text-ink-2">{active.blurb}</p>
          <Code key={active.id} code={active.code} title={active.title} />
        </div>
      </section>

      <section id="errors" className="mt-12 scroll-mt-24">
        <h2 className="mb-1 text-[20px] font-semibold">Revert reasons</h2>
        <p className="mb-3 text-[14px] text-ink-2">Custom errors in the ABIs. Simulate first and viem names them for you; this app does exactly that.</p>
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <ul className="rows">
            {Object.entries(ERROR_TEXT).map(([name, text]) => (
              <li key={name} className="grid gap-1 px-4 py-3 sm:grid-cols-[210px_1fr] sm:gap-6">
                <code className="font-mono text-[13px] font-semibold">{name}</code>
                <span className="text-[13.5px] leading-snug text-ink-2">{text}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section id="rpc" className="mt-12 scroll-mt-24">
        <h2 className="mb-3 text-[20px] font-semibold">Network</h2>
        <div className="rows overflow-hidden rounded-xl border border-line bg-surface text-[14px]">
          {[
            ["Chain", "Unichain Sepolia, id 1301"],
            ["RPC", D.rpc],
            ["Explorer", EXPLORER],
            ["First factory block", D.factoryStartBlock.toLocaleString("en-US")],
          ].map(([k, v]) => (
            <div key={k} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:justify-between">
              <span className="text-ink-2">{k}</span>
              <span className="break-all font-mono text-[13px] sm:text-right">{k === "Explorer" ? <a className="hover:underline" href={EXPLORER} target="_blank" rel="noreferrer">{v}</a> : v}</span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[13px] text-ink-2">
          The public RPC caps eth_getLogs at 1,000 blocks per call. Mock tokens have a public mint(to, amount), so there is no faucet to wait on.
        </p>
      </section>
    </div>
  );
}
