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
  history. Donations are blocked (they would inflate par). Overhead is ~12k gas per swap in steady state
  ([research/phase3-twap.md](research/phase3-twap.md)).
- **Par is fee-capped.** `benchmark(..., elapsed)` credits at most 300% APR of the epoch's starting NAV
  in fees, so wash swaps cannot inflate par without bound.
- **Settlement** (`HurdleVault.settle`, once per epoch):
  - beat par: the excess first refills the bond up to past shortfalls, then the curator earns
    `carryBps` of the rest as new shares;
  - miss par: the bond pays depositors up to par;
  - bond below `minBondBps` of NAV: the curator is fired, the vault swaps to 50/50 and parks full range.
- **Deposits** are in kind and only in a settlement block: the first deposit
  (`deposit(amount0, amount1)`, valued at TWAP) starts the vault; later ones are
  `deposit(shares, max0, max1)`, paying exactly what `withdraw(shares)` pays out, so no price is used.
- **Rebalances** (curator only, max 4 per epoch) revert `PriceDeviation` unless spot, the block-open
  price and the TWAP are within `maxTickDeviation` (50 ticks) of each other; the swap is bounded by both.
- **Earned capacity:** deposits are capped at `bond / minBondBps`.

## Unichain Sepolia (1301)

**Live (audit-fixed, deployed 2026-11-17):**

| Contract | Address |
|---|---|
| HurdleHook | [`0x9BaaB91A2DFB8fF9b9D86D5067E67435d56090a0`](https://sepolia.uniscan.xyz/address/0x9BaaB91A2DFB8fF9b9D86D5067E67435d56090a0) |
| Patient vault (±10%) | [`0x448071dAbcF890D6f89FB108803c20461f0D86e8`](https://sepolia.uniscan.xyz/address/0x448071dAbcF890D6f89FB108803c20461f0D86e8) |
| Chaser vault (±2%) | [`0x0B33F9959107469Fb0913B69f2459Cb07d18d68f`](https://sepolia.uniscan.xyz/address/0x0B33F9959107469Fb0913B69f2459Cb07d18d68f) |
| mUSDC (currency0) | `0x01b5BFD7756e9f525152D6D62569c33279816b25` |
| mWETH (currency1) | `0xa30F0653de83907C4B63dcB50cc7d019058f2B14` |
| Liquidity / swap routers | `0x87805a54151Ae3989442b54244dF3D4517Bf7181` / `0x23af931211dDf6b766b119Db9E086eed0e09C99b` |

Full output: `script/out/deploy-1301.json`.

Superseded pre-audit deployment (do not use): hook `0xd0d744918B9a2657B6097e034D51B2D93524dA80`,
vaults `0x72E67e9263E8c60811291d4e3F759612090316ca`, `0x8e7665e30D6bB124c5Ea7b4D340Cd6F07513603C`.

## Layout

| Path | What |
|---|---|
| `src/HurdleHook.sol` | v4 hook: TWAP observations, block-open reference tick, donate block |
| `src/HurdleVault.sol` | curator vault: settlement, bond, carry, fire rule |
| `test/` | unit tests, audit regression tests (`test/audit/`), benchmark harness vs real v4 accounting, real-swap replay |
| `data/` | five weeks of real ETH/USDC swaps (Uniswap v3 mainnet) + Python reference (`par_check.py`) |
| `demo/` | replay → JSON (`build_json.py`) and the chart UI (`ui/`) |
| `script/` | Unichain Sepolia deploy, two steps: `DeployHurdleHook.s.sol` (hook, mocks, routers, pool), `DeployVaults.s.sol` (vaults, 10+ min later) ([research/deploy.md](research/deploy.md)) |
| `research/` | math, harness, audit ([audit-independent.md](research/audit-independent.md), [audit-fixes.md](research/audit-fixes.md)), deploy notes |

## Run

```sh
forge test                                     # 46 tests
# replay a real week through the hook + two vaults (30–60 s), check par against the offchain reference, build the UI data
REPLAY_CSV=data/weeks/2026-10-31.csv REPLAY_OUT=demo/out/range-week.csv forge test --match-contract ReplayTest -vv
python3 data/par_check.py data/weeks/2026-10-31.csv demo/out/range-week.csv --twap
python3 demo/build_json.py demo/out/range-week.csv "Range-bound week (Oct 31 – Nov 6)"
# second week: data/weeks/2026-11-07.csv -> demo/out/down-week.csv, "ETH −14% week (Nov 7 – 13)"
cd demo && python3 -m http.server 8000         # open http://localhost:8000/ui/
```

## Limits (known, documented)

- The TWAP ring spans at most 32 minutes (one entry per 60 s), and `twapTick` reverts until the pool
  has 10 minutes of history. A young pool cannot be used until then, so deployment is two steps.
- Deposits are in kind and only in the settlement block (`deposit(shares, max0, max1)` settles a
  finished epoch first, then reverts `DepositsOnlyAtSettlement` in any other block): a newcomer pays
  exactly what `withdraw(shares)` pays out, rounded up, so no price is used. Depositors wait for an
  epoch end. Only the first deposit is valued (at TWAP) and sits idle until the curator rebalances.
- A withdrawal mid-epoch leaves without that partial epoch's guarantee. If the vault is ahead of par,
  the withdrawn shares first pay their pro-rata share of the pending recoup and carry. Withdrawals
  never wait on settlement: if settling or the price read reverts, they pay out in kind without it.
- NAV and par are valued at TWAP, which matters only at settlement and for crystallized carry.
- Fee-cap residual: par's fee credit is capped at 300% APR of the epoch's starting NAV, so wash swaps
  can still inflate par, and drain the bond, by up to ~0.57 bp of NAV per 10-minute epoch (a 2% bond in
  about 2.4 days of continuous washing by an attacker who is also the pool's only other LP). A real fee
  burst above the cap counts as curator excess. Neither real replay week reaches the cap.
- F2 cross-block residual: rebalances need spot, the block-open price and TWAP within
  `maxTickDeviation` of each other, and the swap is bounded by both bands, so a single block's
  sandwich costs at most ~50 bp. A price held off-market across a block boundary passes every check, at
  the cost of a block of arbitrage exposure to the attacker.
- The curator cannot withdraw the bond or bond shares; they stay as collateral for the vault's life.
- After firing, `rebalance` is permissionless and swaps to 50/50, with the same price bounds.
- The curator's own free shares are not covered by its bond: on a miss they take their share of the loss.
- Plain ERC20 pools only: native ETH and fee-on-transfer tokens are unsupported. Depositors must check
  that the vault's pool hook is the canonical HurdleHook.
- Par is valued at the TWAP, not spot. Over the ETH −14% week the two differ by up to ~84 bp at a single settlement (28 bp at the
  week end; `data/par_check.py` without `--twap`).
- Not audited. Testnet only (mock tokens).
