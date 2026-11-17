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
  and on the real-swap replay the on-chain par matches an exact offchain computation to within 1 bp
  at every hourly settlement (`python3 data/par_check.py data/weeks/2026-10-31.csv demo/out/range-week.csv --twap`).
- **Manipulation-resistant price.** `HurdleHook` writes a tick accumulator in `beforeSwap`, before the
  price moves, so same-block manipulation has zero weight. All NAV and par valuations use the TWAP.
  Overhead is ~12k gas per swap in steady state ([research/phase3-twap.md](research/phase3-twap.md)).
- **Settlement** (`HurdleVault.settle`, once per epoch):
  - beat par: the excess first refills the bond up to past shortfalls, then the curator earns
    `carryBps` of the rest as new shares;
  - miss par: the bond pays depositors up to par;
  - bond below `minBondBps` of NAV: the curator is fired, the vault swaps to 50/50 and parks full range.
- **Earned capacity:** deposits are capped at `bond / minBondBps`.

## Layout

| Path | What |
|---|---|
| `src/HurdleHook.sol` | v4 hook: TWAP observations, epoch snapshots |
| `src/HurdleVault.sol` | curator vault: settlement, bond, carry, fire rule |
| `test/` | unit tests, benchmark harness vs real v4 accounting, real-swap replay |
| `data/` | five weeks of real ETH/USDC swaps (Uniswap v3 mainnet) + Python reference |
| `demo/` | replay → JSON (`build_json.py`) and the chart UI (`ui/`) |
| `script/` | Unichain Sepolia deploy ([research/deploy.md](research/deploy.md)) |

## Run

```sh
forge test                                     # 25 tests
# replay a real week through the hook + two vaults (~30 s), then build the UI data
REPLAY_CSV=data/weeks/2026-10-31.csv REPLAY_OUT=demo/out/range-week.csv forge test --match-contract ReplayTest -vv
python3 demo/build_json.py demo/out/range-week.csv "Range-bound week (Oct 31 – Nov 6)"
cd demo && python3 -m http.server 8000         # open http://localhost:8000/ui/
```

## Limits (known, documented)

- The TWAP ring holds 32 blocks with swaps, so on a busy pool the window is shorter than 30 minutes.
- A withdrawal mid-epoch leaves without that partial epoch's guarantee.
- NAV is valued at TWAP. When spot is far from TWAP this errs against the curator, never depositors.
- The curator cannot withdraw the bond or bond shares; they stay as collateral for the vault's life.
- After firing, `rebalance` is permissionless and swaps to 50/50; price impact is bounded to
  `maxTickDeviation` around TWAP.
- Par is valued at the TWAP, not spot. Over a trending week the two differ by up to ~22 bp at the
  endpoints (`data/par_check.py` without `--twap`).
- Not audited. Testnet only.
