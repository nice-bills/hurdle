# Hurdle app: spec

A real dApp for the Hurdle Uniswap v4 hook + curator vaults on **Unichain Sepolia (chain 1301)**, deployed on
Render (paid plans). Two services plus Postgres, one repo dir each:

- `app/web`: Next.js 15 (App Router, TypeScript), wagmi v2 + viem v2 + RainbowKit (or ConnectKit), Tailwind.
  Pinned exact versions. Server routes read Postgres; the browser writes to chain through the wallet.
- `app/worker`: Node 22 + TypeScript + viem. Three loops in one process: **indexer**, **keeper** and an optional **curator bot** (CURATOR_PRIVATE_KEY).
  The curator bot acts on an explicit allow-list only: `patientVault` and `chaserVault` from `shared/deployment-1301.json` (`curatorVaults()` in `src/curator.ts`). `recklessVault` (deliberately unmanaged, built to get fired) and third-party vaults are never touched; the keeper still settles/parks all vaults.
- Postgres (Render): tables below. Schema in `app/worker/schema.sql`; the worker applies it at boot (idempotent).

Shared: `app/shared/abi/*.json` (HurdleVault, HurdleVaultFactory, HurdleHook, PoolSwapTest, MockERC20 ABIs,
exported from the Foundry build) and `app/shared/deployment-1301.json` (addresses: hook, factory, patientVault,
chaserVault, mUSDC, mWETH, currency0/1, fee, tickSpacing, swapRouter, liquidityRouter, poolManager,
factoryStartBlock, rpc, explorer; plus recklessVault and a `legacy` block with the v3 addresses). Never hardcode addresses elsewhere.

## Contracts (read src/ for exact semantics; README.md explains the mechanism)

- Factory `create(PoolKey key, uint16 carryBps, uint16 minBondBps, int24 maxTickDeviation, uint32 epochSeconds)`;
  caller becomes curator; `VaultCreated(vault, curator, poolId)`; `isVault(addr)`.
- Vault views: `nav()`, `bond()`, `bondValue()`, `bondShares()`, `deficit()`, `fired()`, `firedAt()`, `curator()`,
  `start()` (timestamp, sqrtPriceX96, fg0, fg1, nav), `epochStart()`, `epochSeconds()`, `DEPOSIT_WINDOW()`,
  `position()` (lo, hi, liq), `balanceOf(a)`, `totalSupply()`, `carryBps()`, `minBondBps()`, `maxTickDeviation()`,
  `rebalancesThisEpoch()`, `previewDeposit(shares)`, `previewWithdraw(shares)`, `benchmark(...)`.
- Vault writes: `firstDeposit(a0,a1,receiver)` (curator), `deposit(shares,max0,max1)` (first 5 min of an epoch),
  `withdraw(shares)`, `postBond(amount1)` (curator), `rebalance(lo,hi)` / `rebalance(lo,hi,maxIdleBps)` (curator;
  anyone after fired), `settle()` (anyone, after epoch end; non-curator earns 5% of carry), `reclaimBond()`.
- Events: `Settled(nav,bench,take,shortfallPaid,bond,sqrtPriceX96)`, `Fired(bond,nav)`, `Deposited`, `Withdrawn`,
  `Rebalanced(lo,hi,liq)`, `BondPosted`, `SettlerPaid(settler,shares)`, `BondReclaimed` — check the ABI for exact fields.
- Mock tokens: solmate MockERC20, `mint(to, amount)` is public (faucet). currency0 = mUSDC (6 dec),
  currency1 = mWETH (18 dec, the bond token). Price helpers: tick/sqrtPrice -> USDC per ETH.
- Pool swaps: `PoolSwapTest.swap(key, (zeroForOne, amountSpecified, sqrtPriceLimitX96), (false,false), "")`.

## Postgres tables (worker writes, web reads)

- `vaults(address pk, curator, pool_id, created_block, created_tx, carry_bps, min_bond_bps, max_tick_dev, epoch_seconds, label)`
- `events(id pk, vault, block, tx, log_index, ts, name, args jsonb, unique(tx,log_index))`
- `snapshots(vault, block, ts, nav numeric, bond numeric, bond_value numeric, deficit numeric, fired bool, total_supply numeric, lo int, hi int, tick int, pk(vault,block))` every ~2 min
- `pool_ticks(block pk, ts, tick, sqrt_price numeric)`
- `keeper_runs(id pk, ts, action, vault, tx, ok bool, skipped bool, note)`
- `cursor(name pk, block)`

## Web pages

1. `/` landing: what Hurdle is in one screen (par = passive full-range LP computed by the pool; bond pays misses;
   carry only above par; fired → parked passive), live stats (vaults, TVL, total shortfall paid, carry paid),
   CTA "Try it on testnet".
2. `/vaults` explorer: all factory vaults with status (ACTIVE / FROZEN below 2% floor / FIRED), NAV, bond % of NAV,
   vs-par last epoch, epoch countdown, deposit window open/closed.
3. `/vaults/[address]`: chart NAV vs par per settlement (from Settled events: cumulative product of nav/startNav vs
   bench/startNav), bond meter with the 2% floor and 1% fire line, position range vs current tick, event feed with
   explorer links, and action panels:
   - Depositor: faucet (mint mUSDC/mWETH), approve, deposit (shares input → previewDeposit amounts, max with 1% slack;
     disabled with reason outside the window / deficit outstanding / frozen), withdraw (previewWithdraw), my position.
   - Keeper: Settle (shows when due, explains bounty).
   - Curator (connected wallet == curator): post bond, rebalance with a range picker (ticks aligned to tickSpacing,
     shows TWAP gate status), reclaim bond after firing.
4. `/create`: create a vault via the factory (params with explanations and safe defaults: carry 20%, minBond 2%,
   maxTickDeviation 50, epoch 3600), then guided steps: post bond → first deposit → first rebalance.
5. `/swap`: swap on the hooked pool (to move price / generate fees), shows TWAP vs spot.
6. `/replay`: the two real-week replays (port demo/ui charts; data in demo/out/*.json).
7. `/integrate`: developer docs: addresses, ABIs download, code snippets (viem) for deposit/withdraw/settle,
   how to build a curator bot against the vault.

Quality bar: this is a hackathon-winning product UI. Distinctive, polished, fast, accessible, light/dark, works at
390 px. Every write shows pending / confirmed / failed with the explorer link and decoded revert reasons
(custom errors from the ABI: PriceDeviation, DepositWindowClosed, DeficitOutstanding, BondBelowFloor, etc.,
with human explanations).

## Worker

- Indexer: from `factoryStartBlock`, VaultCreated → vaults; all vault events → events (chunk eth_getLogs ≤ 1000
  blocks, the public RPC limit; back off on -32016); snapshots every ~2 min; reorg-safe (confirmations 3).
- Keeper (env `KEEPER_PRIVATE_KEY`, its own funded wallet, never logged): every 10 min a small round-trip swap on the
  pool (volume, fees, fresh TWAP); for every vault with `block.timestamp >= epochStart+epochSeconds` call `settle()`;
  for fired vaults not parked call `rebalance(0,0)`. Log to keeper_runs. Mint mocks to itself as needed.
- Keeper arbitrage target: spot is swapped back toward a target tick. Order: env `TARGET_TICK`, then `keeperTargetTick`
  in `shared/deployment-1301.json` (optional, per deployment/pool; use it to hold a scripted move, e.g. v6 = -196800),
  then the value stored in `cursor` (`target_tick:<hook>`, keyed per pool so an old pool's target never applies to a new
  one), then the 1 h TWAP at startup. `/healthz` shows the active `targetTick`.
- Curator bot (env `CURATOR_PRIVATE_KEY`, optional; module `curator.ts`): every 10 min, for each current non-fired
  vault whose `curator()` is that key's address, if spot is outside the range or within 20% of the half-width of an
  edge, simulate then call `rebalance(lo, hi, 200)` re-centered on the spot tick with the same half-width (tick-spacing
  aligned). PriceDeviation, TooManyRebalances, BondBelowFloor and EpochNotOver are recorded as skipped. Rows go to
  keeper_runs as `curator_*` and show labelled "curator" in the keeper runs view; `/healthz` has a `curator` section.
- Health endpoint on $PORT (`/healthz`) so it can run as a Render web service or background worker.

## Env

web: `DATABASE_URL`, `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (optional; injected wallets must work without it).
worker: `DATABASE_URL`, `KEEPER_PRIVATE_KEY`, `CURATOR_PRIVATE_KEY` (optional), `RPC_URL` (default https://sepolia.unichain.org).

## Snapshots

Commit and `git push` after every working milestone (small commits). Never commit secrets or .env files.
