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

**Live (v5, deployed 2026-11-26, block 68852678):**

| Contract | Address |
|---|---|
| HurdleHook | [`0x3FB6cbbAA8c703830c126F59416DBe249d5D50A0`](https://sepolia.uniscan.xyz/address/0x3FB6cbbAA8c703830c126F59416DBe249d5D50A0) |
| HurdleVaultFactory | [`0x77d21c4464290826651583eF6cF43dC1018d9e74`](https://sepolia.uniscan.xyz/address/0x77d21c4464290826651583eF6cF43dC1018d9e74) |
| Patient vault (±10%) | [`0xE4192E10c36d46bfBE8aCD7dDe5e1e0978410c50`](https://sepolia.uniscan.xyz/address/0xE4192E10c36d46bfBE8aCD7dDe5e1e0978410c50) |
| Chaser vault (±2%) | [`0xd4D69331910E6753B26984d6a082bb16Aa972398`](https://sepolia.uniscan.xyz/address/0xd4D69331910E6753B26984d6a082bb16Aa972398) |
| Reckless vault (±1%, 2.5% bond, built to get fired) | [`0x594560B41d30DC10D82a2633757036b840C07075`](https://sepolia.uniscan.xyz/address/0x594560B41d30DC10D82a2633757036b840C07075) |
| mWETH (currency0) | `0x0Df1c576d01f4AD434B13b28B5d7F7e78e129AD0` |
| mUSDC (currency1, bond / NAV token) | `0xabE4E10B0B42d0A9f8c2D8f55Be6848a42abf97a` |
| Liquidity / swap routers | `0xA97298DDf3676B6fd3002E5404c8345f36b4c479` / `0xa33a2d3271ff358d5F62999D3148B00940F7fC54` |
| Depositor (holds the vault shares; not the curator, so the bond covers it) | `0xE1cCCD969F34E0f7d435CeA96C63c4d78E95aD03` |

Three vaults, created through the factory (`isVault` true); factory deployed at block 68852678. Full output: `script/out/deploy-1301.json`.
**Token order changed in v5:** the new mocks sort the other way, so currency0 is mWETH and currency1 is mUSDC (`wethIs0 = true`). The bond, NAV, par and vault shares are all in token1, so in v5 they are mUSDC (6 decimals); in v4 they were mWETH. The app, worker and keeper read the order from the deployment (no hard-coded order).
The app, worker and keeper (the Render worker, plus `script/Keeper.s.sol` for scripted moves) run against v5. The curator bot only re-centres Patient and Chaser: Reckless is deliberately unmanaged so it gets fired.

**Earlier deployment (v4, 2026-11-22): Reckless was fired on-chain.** Kept read-only in the app ("Earlier deployment" section); full output: `script/out/deploy-1301-v4.json`. Factory `0x17a372d93D5c11dfadfe453325315b9Dcfc98FdE` (start block 68509070), hook `0x9375e143A60547FAFaa22b53e5777A33667550A0`, Patient `0x5126c9Ebf2cF62e9f121F55886c57075a190b22d`, Chaser `0x1f4Db529B5a7a766D859E9EC25Dba3C01BeF0985`, Reckless `0x711fAb3A68aEAFbFE6Df493e676070D550ac5EEC`, mUSDC (currency0) `0x19e9DC387bbFf0c035d12dEFceEFF1fc0D859C49`, mWETH (currency1, bond token) `0x4F4C59E9089C43785ecc2B8780F61Ca349946bb4`.

The v4 vaults were deployed before the "fired vaults skip the deficit gate" fix, so the fired Reckless deficit was cleared by the curator's `reclaimBond` (done 2026-11-23, after the park completed). Pool depth was added with `script/AddDepth.s.sol` so the park could finish: before that, each park step converted only ~5% on the thin pool. A fresh deployment needs neither step.

What happened on-chain (v4). At 2026-11-22 15:46 UTC a scripted trade moved the price up 544 ticks (~5.6%),
out of Reckless's ±1% range (rehearsed on a fork first). At the 16:39 UTC settlement (block 68513152):
- Reckless missed par by 0.0487 mWETH (2.4% of NAV); its bond paid it, fell below ½ of the 2% floor, and the
  curator was fired in the same transaction (`Settled`, `Fired`, `Rebalanced` to full range). One hour later
  the last 0.0013 mWETH of bond paid the next shortfall; since then the vault tracks par passively.
- Patient and Chaser stayed in charge: their 10% bonds paid shortfalls of 0.014 and 0.012 mWETH. On
  2026-11-23 the curator posted that amount back (`postBond` pays the deficit down first), which reopened
  deposits on both.

**Earlier still (v3, 2026-11-21): Patient v3 was fired on-chain.** History only (no longer shown in the app); full output: `script/out/deploy-1301-v3.json`.

| Contract | Address |
|---|---|
| HurdleHook | [`0x7EECdD6507E77db3247C9E9bccFA0AcFf5F410a0`](https://sepolia.uniscan.xyz/address/0x7EECdD6507E77db3247C9E9bccFA0AcFf5F410a0) |
| HurdleVaultFactory | [`0x6afcE6f48644eECBA68d0b88E45496953720A904`](https://sepolia.uniscan.xyz/address/0x6afcE6f48644eECBA68d0b88E45496953720A904) |
| Patient vault (±10%), fired on-chain | [`0xa8F0dbf46b7C87477E6fe8FB4aE9474F7AF3Ba7D`](https://sepolia.uniscan.xyz/address/0xa8F0dbf46b7C87477E6fe8FB4aE9474F7AF3Ba7D) |
| Chaser vault (±2%) | [`0xB66277b0C38B99afcbeD6AB5554d2C3505E5749e`](https://sepolia.uniscan.xyz/address/0xB66277b0C38B99afcbeD6AB5554d2C3505E5749e) |
| mUSDC / mWETH | `0x16dED02f19B86f66335f0d05448D8EBAf2BBC18b` / `0x6Fe21Df36b9f00E9279640B0C5a2006d3a92F318` |

Both vaults: bond 5% of the deposit (0.1 mWETH), 1 mWETH + 3000 mUSDC deposited. What happened on-chain (events visible in the app and on Uniscan):


- 2026-11-21 19:46 UTC: scripted ETH −9.5% move. Both vaults missed par at the next settlements; their bonds
  paid depositors (Patient 0.054 mWETH, Chaser 0.031 mWETH).
- 2026-11-22 10:50 UTC: a second −9.5% leg. At 11:02 Patient's settlement paid its last 0.046 mWETH of bond and
  fired it (`Fired`); the vault was then parked full range by the keeper (`Rebalanced` to full range).
- Patient's 5% bond was not enough for two 9.5% drops on this thin test pool: its depositors end 0.77% below
  par. The guarantee is "par while the bond lasts"; sizing the bond is the curator's and depositors' choice.

Superseded (do not use):
- second-audit fixes: hook `0x23C23680100b77Acb606995dAD2Be470A30590A0`, vaults
  `0xc3A2f6f4BE0b437A2cC1C3844F86c999c7391b47`, `0x3CD34e0A6E6f9606F17e00e37544DcC2a70fE586`;
- first audit fixes: hook `0x9BaaB91A2DFB8fF9b9D86D5067E67435d56090a0`, vaults
  `0x448071dAbcF890D6f89FB108803c20461f0D86e8`, `0x0B33F9959107469Fb0913B69f2459Cb07d18d68f`;
- pre-audit: hook `0xd0d744918B9a2657B6097e034D51B2D93524dA80`, vaults
  `0x72E67e9263E8c60811291d4e3F759612090316ca`, `0x8e7665e30D6bB124c5Ea7b4D340Cd6F07513603C`.

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
  round trips (size set by `ROUNDTRIP_WETH`, default 1 mWETH per leg, every 10 min), and the keeper also acts as the
  arbitrageur that returns spot to a reference tick after park/re-centre swaps. Carry, fees and the depositor-vs-par line on the live
  vault pages therefore reflect that script, not market demand: expect carry on the order of a basis point per hour on an in-range
  vault, and bond drains on the passive/out-of-range ones. The replays on real swap data (above) are the evidence for the mechanism.
