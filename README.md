# Hurdle

**Portable alpha for curated liquidity.** A Uniswap v4 hook and vault where an LP curator guarantees
depositors at least the return of a passive full-range LP ("par"), pays any shortfall from a posted
bond, and keeps a carry on returns above it. The pool computes par itself, so there is no oracle and
no self-reported performance. A curator whose bond runs out is fired and the vault parks passive.

UHI11 Hookathon, theme: Active Management and Curated Liquidity. Pitch and design log: [IDEA.md](IDEA.md).

**App (testnet dApp):** https://hurdle-app.onrender.com — connect a wallet on Unichain Sepolia, mint test tokens, deposit, settle, run a curator vault, swap; developer docs at [/integrate](https://hurdle-app.onrender.com/integrate). Indexer + 24/7 keeper (plus an optional curator bot that re-centers the demo vaults' ranges when `CURATOR_PRIVATE_KEY` is set): [health](https://hurdle-worker.onrender.com/healthz).

**Static replay demo:** https://nice-bills.github.io/hurdle/ (real-swap replays: [range week](https://nice-bills.github.io/hurdle/?s=range-week#play), [ETH −14% week](https://nice-bills.github.io/hurdle/?s=down-week#play); the Live panel reads the Sepolia vaults).

## How it works

- **Par, onchain, in closed form.** For a full-range position of liquidity L between two snapshots:
  `value1 = L·(2·s1 + dfg0·P1 + dfg1)`, where `s = sqrtPrice`, `P = s²` and `dfg` is the
  `feeGrowthGlobal` delta. It is path-independent, so the swap path pays nothing for it.
  Derivation: [research/benchmark-math.md](research/benchmark-math.md). The formula matches a real v4
  full-range position to ~2.5e-18 of capital ([research/phase2-harness.md](research/phase2-harness.md)),
  and on the real-swap replay the on-chain par matches an exact offchain computation (same fee cap) to
  within 0.001 bp at every hourly settlement, both weeks (e2e gate: 0.01 bp)
  (`python3 data/par_check.py data/weeks/2026-10-31.csv demo/out/range-week.csv --twap`).
- **Manipulation-resistant price.** `HurdleHook` (flags `afterInitialize | beforeSwap | beforeDonate`)
  writes a tick accumulator in `beforeSwap`, before the price moves, so same-block manipulation has zero
  weight. All NAV and par valuations use the TWAP, which reverts until the pool has 10 minutes of
  history. Donations are blocked (they would inflate par). Overhead is ~40k gas on the first swap of each block in steady state (~12k TWAP write + ~28k block-open fee-growth snapshot); later swaps in the same block skip both writes
  ([research/phase3-twap.md](research/phase3-twap.md)).
- **Par is fee-capped and wash-proof within a block.** `benchmark(..., elapsed)` credits at most `maxFeeAprBps` APR
  of the epoch's starting NAV in fees (80% on the 0.05% tier it was calibrated on; scaled linearly by the pool's fee tier, see Limits), scaled by the real time elapsed since the epoch started (so a late settlement widens the cap; see Limits), and the vault reads fee growth as of the block's first swap
  (`HurdleHook.referenceFeeGrowth`), so same-block wash swaps cannot move par at all.
- **Settlement** (`HurdleVault.settle`, once per epoch):
  - beat par: the excess first refills the bond up to past shortfalls, then the curator earns
    `carryBps` of the rest as new shares;
  - miss par: the bond pays depositors up to par;
  - a miss that leaves the bond below half of `minBondBps` of NAV: the curator is fired, the vault swaps
    to 50/50 and parks full range. Beating par never fires a curator.
  - bond below `minBondBps` of NAV without such a miss (NAV grew): deposits and curator rebalances are
    blocked until the curator tops up with `postBond`.
- **Deposits** are in kind, in the first 5 minutes of an epoch (`DEPOSIT_WINDOW`): the curator makes the
  first deposit (`firstDeposit(amount0, amount1, receiver)`, valued at TWAP, shares to `receiver`) to
  start the vault; later ones are `deposit(shares, max0, max1)`, paying exactly what `withdraw(shares)`
  pays out, so no price is used (`previewDeposit` quotes it, never under). A deposit first re-baselines
  par to its block (settling the gap so far, same epoch clock), so a newcomer neither pays for nor
  collects earlier performance. Deposits also need spot, block-open price and TWAP to agree, and no
  unrecouped bond payout (`deficit` ≤ 1 bp of the depositors' NAV), so a newcomer never repays
  compensation that went to others. A fired vault takes deposits only while it is parked full range
  (`NotParked` otherwise), since an unparked fired vault holds the fired curator's range with no bond. The curator can clear `deficit` at any time by posting fresh bond (`postBond` pays it down
  first), so one bad epoch does not close the vault until the curator beats par again.
- **Rebalances** (curator only, max 4 per epoch, bond at or above the floor) revert `PriceDeviation`
  unless spot, the block-open price and the **10-minute** TWAP are within `maxTickDeviation` (50 ticks)
  of each other and the 10- and 30-minute TWAPs agree within 4 × that; the swap is bounded by all three
  (block-open, 10-min, 30-min ± 50 ticks), so a fast re-range after a real move never trades far from
  the price NAV is marked at. `rebalance(lo, hi, maxIdleBps)` reverts `RebalanceIncomplete` (keeping the
  slot) if a front-run left more than `maxIdleBps` of NAV unswapped.
- **Keepers are paid.** `settle()` is permissionless; a third party calling it on schedule gets 5% of
  that epoch's carry (`SETTLER_BOUNTY_BPS`, minted out of the curator's carry, never from depositors). A
  `deposit` or `withdraw` that happens to settle a finished epoch pays the same bounty to its caller, so a
  1-share withdraw cannot front-run the keeper and keep the whole carry.
- **After firing**, anyone can finish the park (uncounted calls, strict 30-minute gate); one epoch after
  the park the curator can `reclaimBond()` what is left, since the parked vault holds exactly the
  passive position par describes.
- **Factory.** `HurdleVaultFactory` only creates vaults on pools whose hook is the canonical
  `HurdleHook`, and records them in `isVault`, so depositors check one flag instead of the pool's hook.
- **Capacity:** deposits are capped at `bond / minBondBps`.
- **Deficit is owed by depositor shares only.** A shortfall is paid to depositors, not to the locked bond
  shares or the curator's own free shares, so a recoup is grossed up to dilute depositors by exactly the
  `deficit` it clears, and the deposit gate, `crystallize` and withdrawals all measure `deficit` against
  depositor shares. A miss followed by an equal beat is therefore neutral between curator and depositors
  (audit 3, finding A). The curator's own withdrawals neither take nor forgive any `deficit`.
- **Withdrawals** take the withdrawer's pro-rata share of `deficit` (of depositor shares) with them
  (recouped if ahead of par, forgiven otherwise), so the remaining holders' per-share charge never grows.

## Results on real swaps

Every swap of two real weeks of mainnet ETH/USDC (Uniswap v3, 0.05%) replayed through the hook and two
vaults with hourly settlement (`test/Replay.t.sol`). Patient holds ±10%; Chaser re-centers ±2% whenever
price leaves its range (the strategy most curators lose with), and tops up its bond if refused for being
under the floor. Values in USD; "vs par" is the gap in points of starting capital (as in the UI).

| Week | Vault | Strategy vs par | Depositor vs par | Bond paid (gross) | Carry | Fired |
|---|---|---|---|---|---|---|
| Range (Oct 31 – Nov 6) | Patient | +1.92% | +1.56% | 2.63% | 0.40% | no |
| | Chaser | +0.65% | +2.57% | 8.83% | 0.69% | no |
| ETH −14% (Nov 7 – 13) | Patient | −3.93% | +0.10% | 8.77% | 0.05% | day 6.2 |
| | Chaser | −2.04% | +0.48% | 9.91% | 0.19% | no (1 top-up) |

Depositors are never below par at any of the 166 hourly settlements, in either week (minimum depositor/par
1.00004 over both weeks). Numbers moved slightly with the audit 3 accounting fix (deficit owed by depositor
shares only): depositor-vs-par by at most 0.01 point, carry up by 0.01–0.08 point (the curator's recoup now
repays depositors' deficit only), the bond paid and fire day unchanged. On-chain par
matches an independent offchain computation within 0.001 bp at every settlement (e2e gate: 0.01 bp)
(`data/par_check.py --twap`); the fee cap never binds on these two weeks. "Bond paid" is gross: misses are paid per epoch
and later excess refills the bond before any carry.

## Unichain Sepolia (1301)

**Live (v6, deployed 2026-11-26, block 68869576):**

| Contract | Address |
|---|---|
| HurdleHook | [`0x7deB3F0A5218a7eD540EC55D8fbe1d59060E10A0`](https://sepolia.uniscan.xyz/address/0x7deB3F0A5218a7eD540EC55D8fbe1d59060E10A0) |
| HurdleVaultFactory | [`0xC39f0C0979dc16d26Af834bcadcc81d6638A74A3`](https://sepolia.uniscan.xyz/address/0xC39f0C0979dc16d26Af834bcadcc81d6638A74A3) |
| Patient vault (±10%) | [`0x22e97BDB1E4B29033b729B0B7B6D59B56C9d095B`](https://sepolia.uniscan.xyz/address/0x22e97BDB1E4B29033b729B0B7B6D59B56C9d095B) |
| Chaser vault (±2%) | [`0xaCd6a6228D29a099BA269B2b3d39745b24C3fD24`](https://sepolia.uniscan.xyz/address/0xaCd6a6228D29a099BA269B2b3d39745b24C3fD24) |
| Reckless vault (±1%, 2.5% bond, built to get fired) | [`0x45ADcEcE45Cade3f8850019fAcf34ed99D0DF82D`](https://sepolia.uniscan.xyz/address/0x45ADcEcE45Cade3f8850019fAcf34ed99D0DF82D) |
| mWETH (currency0) | `0x2B9e6d4312673e34d8df5fa239dfb4da89c8324F` |
| mUSDC (currency1, bond / NAV token) | `0xd256e8097Eda8785449Fc50BA2d15357b72b3bac` |
| Liquidity / swap routers | `0x13f75772a65Ef4eBD8Ae855D1C05c38F0d14199D` / `0xae190c96b3E1369f4610831CC2f033A57F9741B7` |
| Depositor (holds the vault shares; not the curator, so the bond covers it) | `0xE1cCCD969F34E0f7d435CeA96C63c4d78E95aD03` |

Three vaults, created through the factory (`isVault` true); factory deployed at block 68869576. Full output: `script/out/deploy-1301.json`.
**Token order (same as v5, flipped from v4):** the mocks sort so currency0 is mWETH and currency1 is mUSDC (`wethIs0 = true`). The bond, NAV, par and vault shares are all in token1, so in v5/v6 they are mUSDC (6 decimals); in v4 they were mWETH. The app, worker and keeper read the order from the deployment (no hard-coded order).
The app, worker and keeper (the Render worker, plus `script/Keeper.s.sol` for scripted moves) run against v6 (the keeper's arbitrage target tick comes from `keeperTargetTick` in `app/shared/deployment-1301.json`: -196800, the post-move tick). The curator bot only re-centres Patient and Chaser: Reckless is deliberately unmanaged so it gets fired.

**v6 live story (2026-11-26, all UTC, testnet, synthetic flow):**
- 19:42:58, block 68869750: a scripted swap moved the price by −555 ticks (about −5.4%), to tick −196800 ([tx `0x402b94…`](https://sepolia.uniscan.xyz/tx/0x402b945d81e588353cca92c34cb009ab4defa46b5d9d2c2f52ca48637a3d8974)). The keeper then held spot at that target.
- 20:41 settle: Reckless (±1%, out of range) missed par by 144.9 mUSDC; its bond paid, and it was `Fired` and parked full range in the same transaction ([tx `0xdf4810…`](https://sepolia.uniscan.xyz/tx/0xdf4810ad8b49326d66bbe131f4b769f8bff84c7d16d9130b077f10b1c0df25ae)); `rebalance(0,0)` now reverts `AlreadyParked`.
- Patient and Chaser missed too; their bonds paid 50.3 and 102.9 mUSDC. The curator bot repaid both deficits (`postBond`) at about 20:50:41 ([Patient](https://sepolia.uniscan.xyz/tx/0xfc720161e75786a3a1c390a2b23d4b385115ed47c197b1dba7b839b78285d0f4), [Chaser](https://sepolia.uniscan.xyz/tx/0xd6b8eeb8c638dcee234a8f30fe7f5b86aa82c32a560f15fb010c3dfcaf62c030)). That was after the 300 s deposit window, so the worker now checks deficits every 60 s and right after each settle.
- ~21:00: Chaser was re-centred (it had been out of range since 19:42; the bot's single strict `rebalance(.., 200)` kept reverting `RebalanceIncomplete`). Done by hand in two steps, `rebalance(c−200, c+200, 10000)` then `(…, 200)`; the bot now does the same two steps.
- From 22:42 every hourly settle beat par: Chaser's curator kept ~0.35 mUSDC carry per hour, Patient's ~0.07, depositors ended above par, and the keeper was paid its settler bounty (`SettlerPaid`) each time ([Chaser settle 01:45 UTC](https://sepolia.uniscan.xyz/address/0xaCd6a6228D29a099BA269B2b3d39745b24C3fD24#events)). This is the reward side running live, with no human input.
- Carry has not shown yet on any deployment: v6 spent its first epochs out of range. The keeper's flow was raised to 2 mWETH per round trip so an in-range Chaser earns carry (see the worker README); the replays on real swap data are the carry evidence.

**History (details and addresses: [research/deploy.md](research/deploy.md#deployment-history), `script/out/deploy-1301-v*.json`):**
- v5 (2026-11-26, factory `0x77d21c4464290826651583eF6cF43dC1018d9e74`): a scripted −593-tick move at 15:00 fired Reckless at the 15:58 settle; Patient and Chaser paid 50 / 40 mUSDC and were refilled. Kept read-only in the app.
- v4 (2026-11-22): a +544-tick move fired Reckless at the 16:39 settle (missed by 2.4% of NAV); the curator reopened Patient and Chaser deposits with `postBond`. Pool depth added with `script/AddDepth.s.sol` so the park could finish. mWETH was the bond token.
- v3 (2026-11-21): two −9.5% legs fired Patient v3 at the 11:02 settle on 2026-11-22; its 5% bond did not cover two 9.5% drops on the thin pool (depositors ended 0.77% below par: the guarantee is par while the bond lasts).
- Earlier audit-fix and pre-audit deployments are superseded; addresses are in research/deploy.md.

## Layout

| Path | What |
|---|---|
| `src/HurdleHook.sol` | v4 hook: TWAP observations, block-open reference tick, donate block |
| `src/HurdleVault.sol` | curator vault: settlement, bond, carry, fire rule |
| `src/HurdleVaultFactory.sol` | creates vaults only on canonical-hook pools; `isVault` registry |
| `test/` | unit tests, v2/v3/v4 feature tests, audit regression tests (`test/audit/`), stateful invariants (`test/invariant/`), benchmark harness vs real v4 accounting, real-swap replay |
| `data/` | five weeks of real ETH/USDC swaps (Uniswap v3 mainnet) + Python reference (`par_check.py`) |
| `demo/` | replay → JSON (`build_json.py`) and the chart UI (`ui/`) |
| `script/` | Unichain Sepolia deploy, two steps: `DeployHurdleHook.s.sol` (hook, mocks, routers, pool), `DeployVaults.s.sol` (vaults, 10+ min later) ([research/deploy.md](research/deploy.md)) |
| `research/` | math, harness, audits ([audit-independent.md](research/audit-independent.md), [audit-fixes.md](research/audit-fixes.md), [audit2.md](research/audit2.md)), deploy notes |

## Run

```sh
./e2e.sh                                       # everything: build/size, all tests + invariants, both replays, par check, UI data, UI smoke (E2E_LIVE=1 adds a read-only testnet check; E2E_APP=1 the dApp smoke)
forge test                                     # all suites; the replay is skipped without REPLAY_CSV
# replay a real week through the hook + two vaults (30–60 s), check par against the offchain reference, build the UI data
REPLAY_CSV=data/weeks/2026-10-31.csv REPLAY_OUT=demo/out/range-week.csv forge test --match-contract ReplayTest -vv
python3 data/par_check.py data/weeks/2026-10-31.csv demo/out/range-week.csv --twap
python3 demo/build_json.py demo/out/range-week.csv "Range-bound week (Oct 31 – Nov 6)"
# second week: data/weeks/2026-11-07.csv -> demo/out/down-week.csv, "ETH −14% week (Nov 7 – 13)"
cd demo && python3 -m http.server 8000         # open http://localhost:8000/ui/
```

## Limits (known, documented)

- The TWAP ring holds 32 entries written at least 60 s apart (so it spans at least ~31 minutes, more in
  sparse trading), and `twapTick` reverts until the pool has 10 minutes of history. A young pool cannot
  be used until then, so deployment is two steps.
- Deposits are in kind and only in the first `DEPOSIT_WINDOW` (5 min) of an epoch; later they revert
  `DepositWindowClosed`. Depositors wait for the next epoch (1 h in the demo). Only the first deposit is
  valued (at TWAP) and sits idle until the curator rebalances.
- A withdrawal mid-epoch leaves without that partial epoch's guarantee. If the vault is ahead of par,
  the withdrawn shares first pay their pro-rata share of the pending recoup and carry. Withdrawals
  never wait on settlement: if settling or the price read reverts, they pay out in kind without it.
- NAV and par are valued at TWAP, which matters only at settlement and for crystallized carry.
- Fee-cap residual (wash-fee bound): same-block washing has no effect, but wash swaps spread across blocks can still
  inflate par, and drain the bond, by up to the cap: 80% APR × the real elapsed time on the 0.05% tier, i.e. ≤ 0.91 bp of NAV
  per hour (~22 bp per day). The cap is calibrated on the 0.05% tier but the factory accepts any canonical-hook pool, so
  the vault constructor scales it by fee tier: `maxFeeAprBps = 8_000 × key.fee / 500`, at most 100_000 (1000% APR,
  reached at 6_250 pips). The bound per hour scales the same way: 0.91 bp/h at 0.05%, 5.5 bp/h at 0.3% (measured in
  `test/FeeCapAttack.t.sol`, which runs on a 0.3% pool), and a vault on a 1% tier or a dynamic-fee pool is held to
  the 1000% ceiling (~11.4 bp/h). Real fee APR scales with the tier too, so the cap clips real hours no more
  often than on 0.05%. It is a per-vault immutable (`maxFeeAprBps()`), so depositors can read it; to pick a
  different calibration, change the base `MAX_FEE_APR_BPS` and the ceiling at deploy time ([research/fee-cap.md](research/fee-cap.md) section 6). The cap is a rate, so settling late does not widen the per-hour exposure and no
  maximum settlement interval is needed (a one-epoch clamp was tried and dropped: a late settle then handed
  real fees to the curator as excess). Worst case, an attacker who is the dominant LP (recycling the fees it
  pays) washing every block drains a 10% bond in ~46 days, down from ~12 days at the old 300% cap; the
  attack test `test/FeeCapAttack.t.sol` measures exactly the cap per epoch.
  Only an idle or out-of-range vault is exposed. An in-range vault is a real LP in the wash: in
  `test_attack_inRangeVaultIsNotDrained` (same wash, vault re-centred at +-120 ticks) it earns +10.6% of NAV in one
  epoch against par's uncapped fee credit of 0.063% (168x, its concentration factor), so no shortfall arises and
  the bond is untouched. The curator's defence is to stay in range (the live curator bot re-centres); a
  vault left idle or out of range for days is the exposed case.
  80% is ~2x the p99 of par's
  uncapped hourly fee credit on the two real weeks (p99 40%, max 60%), so it never binds there; a real hour above
  the cap counts as curator excess (6 of 831 hourly settlements over five weeks, all in the 138%-vol Oct 24 week;
  [research/fee-cap.md](research/fee-cap.md)).
- TWAP lag still blocks some rebalances. Against the 30-minute TWAP alone, |spot − TWAP| > 50 ticks in
  2.6–4.6% of minutes per real week (3.4% over five weeks); the 10-minute gate cuts Chaser's refused
  re-centers from 24 to 19 (range week) and 19 to 12 (down week). Moving the gate needs the price held
  ~10 minutes, not 30, but the swap stays within 50 ticks of the 30-minute mark, so it cannot trade
  further from the valuation price. The fired-vault park keeps the strict 30-minute gate.
- Griefing: an attacker can push spot to the swap-band edge in the curator's block so a rebalance swaps
  little. With `maxIdleBps` the call reverts instead (slot kept), so this only delays the curator, at the
  attacker's cost. Fired-vault parks are uncounted, so they cannot be exhausted.
- A curator whose bond drifts under the floor (NAV grew) keeps its range but cannot rebalance or take
  deposits until it tops up; a later miss that takes the bond below half the floor fires it, even a
  miss of a few wei once the bond has drifted below half the floor without a top-up.
- F2 cross-block residual: rebalances need spot, the block-open price and TWAP within
  `maxTickDeviation` of each other, and the swap is bounded by both bands, so a single block's
  sandwich costs at most ~50 bp. A price held off-market across a block boundary passes every check, at
  the cost of a block of arbitrage exposure to the attacker.
- The curator cannot withdraw the bond or bond shares while it manages the vault; only after being fired
  and parked for an epoch (`reclaimBond`).
- Shares are non-transferable internal balances (no ERC20): a deliberate scope limit, since the
  shortfall math must know which shares are the curator's. No secondary market or integrations yet.
- Par is endogenous to the vault's own depth: fee growth is per unit of in-range liquidity, so a vault
  that is most of the pool's in-range liquidity dilutes the fee growth par is credited with. With the
  vault at 85% of in-range liquidity, par undercounts a real full-range LP by 23 bp over the test
  (`test_endogenousPar`), in the curator's favour. Negligible on deep pools; a risk on thin ones.
- Settler bounty shares, once minted, are ordinary non-curator shares and are covered by the bond. A
  curator settling from a second address collects its own 5% as covered shares (no deposit window or
  capacity check; bounded at 5% of carry, the same as the known withdraw-and-redeposit route).
- Audit 3 residuals (research/audit3-accounting.md, Resolution column): carry is still charged on the bond
  shares' own excess (curator-to-curator); reclaim does not cover the partial epoch it lands in; the dead
  shares count as a depositor, so the bond pays their 1000-wei slice of a miss. The covered-settle
  guarantee: when the bond is worth what it takes to make depositors whole, they end at par in that same
  settlement, even with the curator holding free shares. Bond tokens that enter the vault are shared with
  every share, so the payout is grossed up by `t / depositorShares` and the curator's lift is re-locked as
  bond shares. "Covered" means bond value >= `owed * (t - b) / (t - x)` (at most the whole shortfall, `b` =
  bond shares, `x` = bond shares + curator free shares); a bond worth only the depositors' slice `owed`
  falls short by about the curator's fraction (`test/audit/ShortfallPayout.t.sol`, 20% free shares).
- After firing, `rebalance` is permissionless and swaps to 50/50, with the same price bounds.
- The curator's own free shares are not covered by its bond: on a miss they take their share of the loss.
  The live demo vaults therefore mint the first deposit's shares to a separate depositor address.
- Plain ERC20 pools only: native ETH and fee-on-transfer tokens are unsupported. Vaults deployed
  directly (not via the factory) are not registered; depositors should check `factory.isVault`.
- Par is valued at the TWAP, not spot. Over the ETH −14% week the two differ by up to ~84 bp at a single settlement (28 bp at the
  week end; `data/par_check.py` without `--twap`).
- **Model audits only, no external human audit.** The final source has had model-based audits (audit2, audit3,
  research/) and a multi-model review council, but no independent human Solidity review. The custom accounting
  (shares, bond, deficit, shortfall gross-up, carry) is high-impact; do not rely on the depositor guarantee with
  meaningful funds before an external audit. Testnet only (mock tokens).
- **Live flow is synthetic.** The testnet pool has no organic traders. All volume comes from the worker keeper's
  round trips (size set by `ROUNDTRIP_WETH`, default 2 mWETH per leg, every 10 min), and the keeper also acts as the
  arbitrageur that returns spot to a reference tick after park/re-centre swaps. Carry, fees and the depositor-vs-par line on the live
  vault pages therefore reflect that script, not market demand: expect fees on the order of 3 bp of NAV per hour on an in-range ±2% vault (2 mWETH per leg on the v6 pool depth), and bond drains on the passive/out-of-range ones. The replays on real swap data (above) are the evidence for the mechanism.
