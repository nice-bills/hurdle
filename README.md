# Hurdle

**Portable alpha for curated liquidity.** A Uniswap v4 hook and vault where an LP curator guarantees
depositors at least the return of a passive full-range LP ("par"), pays any shortfall from a posted
bond, and keeps a carry on returns above it. The pool computes par itself, so there is no oracle and
no self-reported performance. A curator whose bond runs out is fired and the vault parks passive.

UHI11 Hookathon, theme: Active Management and Curated Liquidity. Pitch and design log: [IDEA.md](IDEA.md).

## How it works

- **Par, onchain, in closed form.** For a full-range position of liquidity L between two snapshots:
  `value1 = L·(2·s1 + dfg0·P1 + dfg1)`, where `s = sqrtPrice`, `P = s²` and `dfg` is the
  `feeGrowthGlobal` delta. It is path-independent, so the swap path pays nothing for it.
  Derivation: [research/benchmark-math.md](research/benchmark-math.md). The formula matches a real v4
  full-range position to ~2.5e-18 of capital ([research/phase2-harness.md](research/phase2-harness.md)),
  and on the real-swap replay the on-chain par matches an exact offchain computation (same fee cap) to
  within 0.01 bp at every hourly settlement, both weeks
  (`python3 data/par_check.py data/weeks/2026-10-31.csv demo/out/range-week.csv --twap`).
- **Manipulation-resistant price.** `HurdleHook` (flags `afterInitialize | beforeSwap | beforeDonate`)
  writes a tick accumulator in `beforeSwap`, before the price moves, so same-block manipulation has zero
  weight. All NAV and par valuations use the TWAP, which reverts until the pool has 10 minutes of
  history. Donations are blocked (they would inflate par). Overhead is ~40k gas on the first swap of each block in steady state (~12k TWAP write + ~28k block-open fee-growth snapshot); later swaps in the same block skip both writes
  ([research/phase3-twap.md](research/phase3-twap.md)).
- **Par is fee-capped and wash-proof within a block.** `benchmark(..., elapsed)` credits at most 300% APR
  of the epoch's starting NAV in fees, and the vault reads fee growth as of the block's first swap
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
  unrecouped bond payout (`deficit` ≤ 1 bp of NAV), so a newcomer never repays compensation that went
  to others.
- **Rebalances** (curator only, max 4 per epoch, bond at or above the floor) revert `PriceDeviation`
  unless spot, the block-open price and the **10-minute** TWAP are within `maxTickDeviation` (50 ticks)
  of each other and the 10- and 30-minute TWAPs agree within 4 × that; the swap is bounded by all three
  (block-open, 10-min, 30-min ± 50 ticks), so a fast re-range after a real move never trades far from
  the price NAV is marked at. `rebalance(lo, hi, maxIdleBps)` reverts `RebalanceIncomplete` (keeping the
  slot) if a front-run left more than `maxIdleBps` of NAV unswapped.
- **Keepers are paid.** `settle()` is permissionless; a third party calling it on schedule gets 5% of
  that epoch's carry (`SETTLER_BOUNTY_BPS`, minted out of the curator's carry, never from depositors).
- **After firing**, anyone can finish the park (uncounted calls, strict 30-minute gate); one epoch after
  the park the curator can `reclaimBond()` what is left, since the parked vault holds exactly the
  passive position par describes.
- **Factory.** `HurdleVaultFactory` only creates vaults on pools whose hook is the canonical
  `HurdleHook`, and records them in `isVault`, so depositors check one flag instead of the pool's hook.
- **Capacity:** deposits are capped at `bond / minBondBps`.
- **Withdrawals** take the withdrawer's pro-rata share of `deficit` with them (recouped if ahead of par,
  forgiven otherwise), so the remaining holders' per-share charge never grows.

## Results on real swaps

Every swap of two real weeks of mainnet ETH/USDC (Uniswap v3, 0.05%) replayed through the hook and two
vaults with hourly settlement (`test/Replay.t.sol`). Patient holds ±10%; Chaser re-centers ±2% whenever
price leaves its range (the strategy most curators lose with), and tops up its bond if refused for being
under the floor. Values in USD, % of starting capital.

| Week | Vault | Strategy vs par | Depositor vs par | Bond paid (gross) | Carry | Fired |
|---|---|---|---|---|---|---|
| Range (Oct 31 – Nov 6) | Patient | +1.92% | +1.57% | 2.63% | 0.39% | no |
| | Chaser | +0.65% | +2.58% | 8.83% | 0.64% | no |
| ETH −14% (Nov 7 – 13) | Patient | −4.25% | +0.11% | 8.77% | 0.02% | day 6.2 |
| | Chaser | −2.21% | +0.52% | 9.91% | 0.11% | no (1 top-up) |

Depositors are never below par at any of the 166 hourly settlements, in either week. On-chain par
matches an independent offchain computation within 0.001 bp at every settlement
(`data/par_check.py --twap`); the fee cap never binds. "Bond paid" is gross: misses are paid per epoch
and later excess refills the bond before any carry.

## Unichain Sepolia (1301)

**Live (second-audit fixes, deployed 2026-11-17):**

| Contract | Address |
|---|---|
| HurdleHook | [`0x23C23680100b77Acb606995dAD2Be470A30590A0`](https://sepolia.uniscan.xyz/address/0x23C23680100b77Acb606995dAD2Be470A30590A0) |
| Patient vault (±10%) | [`0xc3A2f6f4BE0b437A2cC1C3844F86c999c7391b47`](https://sepolia.uniscan.xyz/address/0xc3A2f6f4BE0b437A2cC1C3844F86c999c7391b47) |
| Chaser vault (±2%) | [`0x3CD34e0A6E6f9606F17e00e37544DcC2a70fE586`](https://sepolia.uniscan.xyz/address/0x3CD34e0A6E6f9606F17e00e37544DcC2a70fE586) |
| mWETH (currency0) | `0x66eE82318ef63f70062D6A1dA13B4932D07ACF45` |
| mUSDC (currency1, bond token) | `0xb64f26a56Be428ED28dF58eaFa8581CBd4E657C9` |
| Liquidity / swap routers | `0x7C7649B1a7c6EE4b907a604070dAb159aDAFeEeD` / `0x52bD3f18263c4b05cE7550B5c601780F9A495742` |
| Depositor (holds the vault shares; not the curator, so the bond covers it) | `0xE1cCCD969F34E0f7d435CeA96C63c4d78E95aD03` |

Each vault: 300 mUSDC bond, 1 mWETH + 3000 mUSDC deposited, curator range deployed. Full output:
`script/out/deploy-1301.json`.

Superseded (do not use):
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
| `test/` | unit tests, v2/v3 feature tests, audit regression tests (`test/audit/`), stateful invariants (`test/invariant/`), benchmark harness vs real v4 accounting, real-swap replay |
| `data/` | five weeks of real ETH/USDC swaps (Uniswap v3 mainnet) + Python reference (`par_check.py`) |
| `demo/` | replay → JSON (`build_json.py`) and the chart UI (`ui/`) |
| `script/` | Unichain Sepolia deploy, two steps: `DeployHurdleHook.s.sol` (hook, mocks, routers, pool), `DeployVaults.s.sol` (vaults, 10+ min later) ([research/deploy.md](research/deploy.md)) |
| `research/` | math, harness, audits ([audit-independent.md](research/audit-independent.md), [audit-fixes.md](research/audit-fixes.md), [audit2.md](research/audit2.md)), deploy notes |

## Run

```sh
forge test                                     # 94 pass, replay skipped (Audit2Regression re-runs the 30 vault tests via inheritance)
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
- Fee-cap residual: same-block washing has no effect, but wash swaps spread across blocks can still
  inflate par, and drain the bond, by up to the cap (~0.57 bp of NAV per 10-minute epoch: a 2% bond in
  about 2.4 days of continuous washing by an attacker who is also the pool's only other LP). A real fee
  burst above the cap counts as curator excess. Neither real replay week reaches the cap.
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
  curator settling from a second address collects its own 5%, which changes nothing for depositors.
- After firing, `rebalance` is permissionless and swaps to 50/50, with the same price bounds.
- The curator's own free shares are not covered by its bond: on a miss they take their share of the loss.
  The live demo vaults therefore mint the first deposit's shares to a separate depositor address.
- Plain ERC20 pools only: native ETH and fee-on-transfer tokens are unsupported. Vaults deployed
  directly (not via the factory) are not registered; depositors should check `factory.isVault`.
- Par is valued at the TWAP, not spot. Over the ETH −14% week the two differ by up to ~84 bp at a single settlement (28 bp at the
  week end; `data/par_check.py` without `--twap`).
- Not audited. Testnet only (mock tokens).
