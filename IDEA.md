# Hurdle — UHI11 Hookathon idea

**One line:** A Uniswap v4 hook that pays LP curators only for the return they earn above a passive LP, measured by the pool itself every block, and fires them automatically when they fall behind.

## Problem (30 seconds)

Curated LP vaults (Gamma, Arrakis, Charm, Steer, and the new v4 curator hooks) charge fees on the fees they earn, not on whether they beat simply sitting in range. Depositors can't tell skill from luck, and a curator who loses to a passive position still gets paid. The Oct 2026 SoK on DeFi vaults names this principal-agent gap as the main unsolved failure mode of curation (arXiv 2610.01300).

## What's newly possible

Sept 2026: "Not All LPs Are Equal" (arXiv 2609.37963) defines an **infinitesimal LP benchmark**: the markout of a fully passive, always-in-range marginal LP, computed only from the AMM's own price path. They also find a systematic active-passive gap in concentrated pools, so active curation does create value that can be measured.

A v4 hook sees every swap in its pool. So the hook can compute that benchmark **onchain, with no oracle**:
- fee per unit of liquidity = growth of `feeGrowthGlobal` (already in pool state)
- adverse selection per unit of liquidity = markout of each block's swaps against the next block's first price

That benchmark becomes the hurdle rate. Nobody can game it, because nobody else computes it.

## Mechanism

1. **Curators register a strategy** with the hook and post a bond. Each curator manages one vault of depositor capital in the pool. The hook routes every `modifyLiquidity` call for that vault.
2. **Every block, the hook updates the benchmark**: return per unit of liquidity of the passive LP (fees minus markout loss).
3. **Each vault's NAV is marked against the benchmark scaled to its liquidity.** A performance fee accrues only on the excess above a high-water mark.
4. **Fire rule:** if a vault's drawdown against the benchmark passes the depositors' threshold, the hook (a) moves its capital to a passive full-range position, (b) slashes the curator bond to depositors, and (c) stops the curator's control.
5. **Earned AUM (stretch):** a curator's deposit cap grows with benchmark-relative alpha. This covers the RFH bullet "reputation-weighted curation", using a reputation the pool measures itself.

## 60-second demo

We replay one real week of ETH/USDC swaps (Base) through a local v4 pool that has Hurdle attached, with two curators:
- **Sharp**: tight range, recenters on volatility. It beats the benchmark, so the performance-fee meter climbs.
- **Churner**: rebalances on every move and pays the spread. Its fee meter stays at 0. On day 3 it crosses the drawdown line: `Fired` event, bond goes to depositors, capital parks full range.

The UI shows one chart: benchmark line, two vault lines, fee meters, the fire event.

## RFH fit (UHI11 "Curated Liquidity")

Covers vault-managed curator control, performance fee systems, and reputation-weighted curation in one primitive. It does this with accountability, which the other entries won't have.

## Kill table (ideas rejected)

| Idea | Rule failed | Evidence |
|---|---|---|
| Copy-LP: follow pro managers | Generic. It is on the RFH list, so every team builds it | blog.atrium.academy/uniswap-hook-incubator-2025-wrapped |
| ML or offchain-signal auto-rebalancer | Generic. On the RFH list, with many existing AVS rebalancers | same |
| Auction the pool manager seat (am-AMM) | Prior art: am-AMM paper, Bunni v2 shipped it | arXiv 2403.03367, bunni.xyz |
| Onchain strategy backtester from swap history | Value shows only over time, and the gas cost kills it | rule 5 / 8 |
| Mandate-enforced curator (IMA limits) | Too weak alone. Folded into Hurdle as depositor drawdown threshold | — |
| Dynamic-fee / IL-insurance hooks | Wrong theme (UHI9/10). Crowded: 57% of 2025 projects | 2025 Wrapped |

Prior-art sweep (hook directory, hookatlas, v4hooks, GitHub): `research/prior-art.md`. No v4 hook was found that charges curators against a passive benchmark or slashes a curator bond. Nearest: MaxFi (performance-fee-only, but on absolute earnings), Bunni v2 (hook-owned liquidity, no accountability), Uniswap FLAIR (offchain LP-competitiveness metric, not enforced). Spot-checked with a GitHub search on 2026-11-13: none found.

## Definition of done (falsifiable)

On a replay of at least 7 days of real ETH/USDC swaps through a local v4 pool with the hook:
1. The onchain benchmark matches an offchain Python reference implementation of the paper's infinitesimal LP within 1 bp.
2. The underperforming curator is charged 0 performance fee and is fired by the hook. The outperforming curator is paid exactly `perfFee × (NAV − benchmarkNAV − HWM)`.
3. Swap gas overhead is under 40k per swap.
4. A live testnet deployment (Unichain Sepolia) and a demo UI.

## Workflow (phases, riskiest first)

1. **Benchmark math spike**: derive the per-L markout for v4 concentrated liquidity. Write a Python reference and replay real swaps. Risk: the math is wrong or noisy.
2. **Verification harness**: Foundry fork/replay test that pipes the same swaps through the hook and diffs it against the Python reference.
3. **Benchmark accumulator** in `afterSwap` (lazy markout at the first swap of each block).
4. **Vault + curator accounting**: NAV, HWM, performance fee, bond.
5. **Fire rule** and passive fallback.
6. **Demo**: replay script, chart UI, testnet deploy, video.
7. Stretch: earned-AUM caps.

Grunt work (research sweeps, test scaffolding, UI) goes to OpenCode free models (GLM 5.3 Flash / DeepSeek V4.1 Flash). Claude reviews every result against the harness.
