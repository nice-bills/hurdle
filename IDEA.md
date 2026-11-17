# Hurdle — UHI11 Hookathon idea

**One line:** Your LP curator guarantees you do at least as well as a passive LP, or pays you the difference out of their own bond. The pool keeps score itself, every block.

## Why this and not the Request-for-Hooks list

The RFH list (copy-LP, ML rebalancers, performance fees, reputation) is what every team's agent will propose. Hurdle doesn't add another curator; it changes the contract between curator and depositor. It is **portable alpha** (PIMCO, 1980s): the depositor gets the benchmark (beta) as a floor, the curator keeps or pays the difference (alpha). The pool computes the benchmark itself, so that swap can be settled onchain without an oracle or a trusted reporter.

## Problem (30 seconds)

Active LP management mostly destroys value, and the curator gets paid anyway.
- Bitquery, 13 Nov 2026, tokenized-stock pools: re-centering the range to follow price **lost money in 17 of 20** pool/range cases. A ±10% range left alone made money in 3 of 4 pools. Across 656 pools, LPs earned $7.30M in fees and lost $9.65M to IL. (bitquery.io/investigations/tokenized-stocks-liquidity-pools-lp-returns)
- Uniswap v3 LPs overall: $42M in fees, still lost $20M against holding. (bitquery.io/investigations/uniswap-v3-lp-returns)
- Oct 2026 SoK on DeFi vaults names the curator principal-agent gap as the main open failure mode. (arXiv 2610.01300)

## What's newly possible

Sept 2026: arXiv 2609.37963 defines an **infinitesimal LP benchmark**: the markout of a fully passive, always-in-range marginal LP, computed only from the AMM's own price path. A v4 hook sees every swap in its pool, so it can compute that benchmark onchain:
- fee per unit of liquidity = growth of `feeGrowthGlobal` (already in pool state)
- adverse selection per unit of liquidity = markout of each block's swaps against the next block's first price

## Mechanism

1. **Curator opens a vault** on a pool and posts a bond. Depositors deposit. All of the vault's liquidity goes through the hook, so the hook knows the vault's exact positions.
2. **Each block, the hook updates the benchmark**: return per unit of liquidity of a passive in-range LP.
3. **Settlement at each epoch / withdrawal:**
   - vault return ≥ benchmark → depositors get benchmark + (1 − carry) × excess; curator gets carry × excess.
   - vault return < benchmark → the shortfall is paid to depositors from the curator bond.
4. **Fire rule:** when the bond can no longer cover the next shortfall (bond / AUM < threshold), the hook moves the vault to a passive full-range position and removes the curator. Depositors never fall below the benchmark while bond lasts.
5. **Earned capacity (stretch):** AUM cap = k × bond. A curator who beats par grows the bond out of carry and can take more capital. This is reputation that cannot be faked.

## 60-second demo

Replay one real week of swaps through a local v4 pool with Hurdle attached, two curators:
- **Patient** (wide range, rarely moves): beats par, carry meter climbs, bond grows, AUM cap grows.
- **Chaser** (re-centers on every move; the 17-of-20 loser): every block it trails par, its bond drains into depositors' balance. Day 3: bond exhausted, `Fired`, capital parks passive.

One chart: par line (benchmark), two vault lines, depositor line that never drops below par, bond meters.

## Kill table (ideas rejected, 2026-11-13)

| Idea | Rule failed | Evidence |
|---|---|---|
| Copy-LP: follow pro managers | On RFH list, every agent proposes it | blog.atrium.academy/uniswap-hook-incubator-2025-wrapped |
| ML / offchain-signal auto-rebalancer | On RFH list, many AVS rebalancers exist | same |
| Plain performance-fee / reputation vault | On RFH list | same |
| Market-hours (NYSE session) liquidity for tokenized stocks | Prior art shipped Aug–Sep 2026 | weir.finance/docs (session-fee hook + curator), vetra.fun/docs.html (closed-hours vault) |
| Onchain market-maker retainer (ring-fenced token loan + KPIs) | Prior art: issuer-owned, MM-run vaults | docs.arrakis.finance/arrakis-pro ; Merkl/Metrom pay for depth |
| Auction the manager seat (am-AMM) | Prior art: am-AMM paper, Bunni v2 | arXiv 2403.03367 |
| Opening-bell batch auction for stock pools | Both parts exist (batch-auction AMMs + session calendars); off theme (MEV) | CoW AMM; Weir |
| Corporate-action-aware liquidity (splits/dividends) | No real problem: issuers use a multiplier so token value stays continuous | blocmates.com (Ondo multiplier) |
| Rebalance via one-sided limit orders | Prior art | Charm Alpha Vaults |
| Senior/junior tranche LP vaults | Prior art (UHI9 IL theme, tranche protocols) | github.com/jayeshy14/awesome-vaults |

Prior-art sweep for Hurdle itself: `research/prior-art.md`. No v4 hook found that settles curators against a passive benchmark or slashes a curator bond. Nearest: MaxFi (performance-only fee on absolute earnings), Bunni v2, Arrakis Pro (no benchmark), Uniswap FLAIR (offchain metric). Second GitHub spot-check 2026-11-13: none found.

## Definition of done (falsifiable)

On a replay of ≥7 days of real swaps through a local v4 pool with the hook:
1. Onchain benchmark matches an offchain Python reference of the paper's infinitesimal LP within 1 bp.
2. Chaser's depositors end ≥ benchmark (bond paid the shortfall) and Chaser is fired; Patient is paid exactly `carry × (vaultReturn − benchmark)`.
3. Swap gas overhead < 40k.
4. Testnet deploy (Unichain Sepolia) + demo UI + video.

## Workflow (riskiest first)

1. ~~Benchmark math spike~~ DONE: closed form, path-independent, 2 snapshots, ~0 swap gas (`research/benchmark-math.md`). New top risk: settlement-price manipulation, so the hook keeps a TWAP.
2. ~~Verification harness~~ DONE: formula matches a real v4 full-range position to ~2.5e-18 of capital over 200-300 swaps, 257 fuzz runs (`research/phase2-harness.md`).
3. ~~Epoch snapshots + TWAP observation~~ DONE: written in `beforeSwap` so same-block manipulation has zero weight; steady-state swap overhead 12k gas (`research/phase3-twap.md`). Real data: 42,280 ETH/USDC swaps, 7 days (`data/`). Open: in that down week both toy curators ended below par, so the demo week must show Patient beating par (pick a range-bound week or tune Patient).
4. ~~Vault + settlement~~ DONE (`src/HurdleVault.sol`): TWAP-valued NAV and par, carry, bond pays shortfall, shortfall recouped into the bond before carry (noise nets out), bond-capped AUM, epoch-gated settle, spot–TWAP deviation guard, swap-to-ratio rebalancing.
5. ~~Fire rule + passive fallback~~ DONE: fired vault parks 50/50 full range and tracks par (test within 10 bp).
6. Demo: ~~replay~~ (`test/Replay.t.sol`, real weeks) ~~chart UI~~ (`demo/ui`) ~~deploy script~~ (dry run passes). Left: broadcast (needs a funded key), video.
7. ~~Stretch: earned capacity~~ DONE as AUM cap = bond / minBond.

Replay results (real ETH/USDC swaps, hourly epochs, 5% bond, values in USD):
- Range week (Oct 31 – Nov 6, selected by a rule fixed in advance): Patient beats par by +1.9% and keeps its bond; Chaser trails par by 2.7%, is fired on day 4, and its depositors end above par.
- Down week (Nov 7 – 13, ETH −14%): both trail par; Patient's bond runs out on day 6 and it is fired; depositors of both end at or above par.
- In both weeks depositors never fall below par while bond remains (asserted by `demo/build_json.py`).

Grunt work (scaffold, test fixtures, UI, research sweeps) goes to OpenCode free models (GLM 5.3 Flash / DeepSeek V4.1 Flash); Claude owns the math and reviews every result against the harness.

## Submission text (paste into the idea form)

**Hurdle — portable alpha for curated liquidity.** A Uniswap v4 hook where LP curators guarantee depositors at least the return of a passive LP, paying any shortfall from a posted bond, and keep a carry on returns above it. The hook computes the passive benchmark itself, every block, from the pool's own fee growth and price path (the "infinitesimal LP" from arXiv 2609.37963), so there's no oracle or self-reported performance. Curators who fall behind par drain their bond into depositors and are fired automatically; curators who beat it grow their bond and their capacity. Fresh data shows why it matters: re-centering strategies lost money in 17 of 20 tokenized-stock pool cases (Bitquery, Nov 2026), yet curators are still paid on fees, not on beating "leave it alone."
