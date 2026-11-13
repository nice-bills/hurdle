# Prior-Art Sweep — UHI11 "Curated Liquidity / Active Management" (2026-11-13)

Sources checked: [UHI Hook Directory](https://atriumacademy.notion.site/hook-directory), [Request for Hooks](https://rfh.atrium.academy), [HookAtlas](https://hookatlas.com/hooks), [v4hooks.com](https://v4hooks.com/categories/lp-management), GitHub/DDG search, arXiv, Uniswap blog.

## 1. Performance fee vs passive benchmark (hurdle / HWM / twin position)
**Closest: MaxFi** ([maxfi.tech](https://www.maxfi.tech/blog/maxfi-vs-beefy-gamma-arrakis-lp-managers)) — **partial**: charges "15% performance fee on earnings only," but on absolute earnings, not outperformance vs a benchmark twin/HODL; Gamma also charges 10% perf fee ([same post](https://www.maxfi.tech/blog/maxfi-vs-beefy-gamma-arrakis-lp-managers)). Onchain HWM/hurdle mechanics exist as concepts ([FBYT](https://fbyt.io/blog/defi-vault-fees-explained-management-performance-hwm), [Space and Time, Oct 2026](https://www.linkedin.com/pulse/calculating-performance-fees-onchain-investment-vaults-xpqlc)) and OnChain Benchmark builds tokenized-capital benchmark indices ([onchainbenchmark.com](https://onchainbenchmark.com)) — but **no v4 hook computing benchmark-relative (twin-position/HODL) outperformance fees onchain was found**. None of the UHI directory hooks match ([directory](https://atriumacademy.notion.site/hook-directory)). Verdict: **none found** (benchmark fee defined but no hook implementation).

## 2. Automatic firing/slashing of curator (bond, drawdown threshold)
No Uniswap/hook project found. Slashing exists only in PoS/bridge contexts ([chainscorelabs](https://chainscorelabs.com/differences/layer-1-ecosystem-design/slashing-and-penalty-systems/validator-slashing-vs-delegator-slashing-who-pays-the-price)). Nearest conceptual prior art: vault-curator power/conflict analyses ([Inherence](https://www.inherence.dev/resources/vault-investment-mandate-control-after-deposit), [p2p.org](https://p2p.org/economy/defi-vault-conflict-of-interest-institutional/)) and the DeFi-vault SoK ([arXiv 2610.01300](https://arxiv.org/pdf/2610.01300v1)). Verdict: **none found**.

## 3. Dust-capital strategy proof + atomic copy-LP mirroring
No "follow/copy LP manager" hook found; copy trading products mirror trades, not LP rebalances ([Pons copy trading, v4](https://www.ponscopytrading.com/uniswap-v4-copy-trading)). Nearest mechanisms: Bunni v2, where hook-owned vault liquidity is managed by strategies on v4 ([bunni-v2 repo](https://github.com/Bunniapp/bunni-v2)), and UHI hooks Driftwood / Simple LP Rebalancer ([directory](https://atriumacademy.notion.site/hook-directory)). Verdict: **none found** (partial mechanics only).

## 4. Depositor-set mandate constraints enforced by hook
No v4 hook found that reverts curator actions breaking depositor-set constraints. Closest: vault risk-control systems (onchain caps, slippage bounds) discussed for generic vaults ([Inherence](https://www.inherence.dev/resources/defi-vault-risk-tools-compared), [Upshift](https://www.upshift.finance/blog/stablecoin-vault-risk-controls)) and the curation SoK ([arXiv 2610.01300](https://arxiv.org/html/2610.01300v1)). UHI directory has position-restriction hooks only (e.g., liquidity locks, veLP ticks — [v4hooks.com](https://v4hooks.com/categories/lp-management)). Verdict: **none found** (partial via generic vault risk tooling).

## 5. Evidence ALM vaults underperform HODL / passive (with numbers)
- **Bitquery**: "Uniswap v3 LPs Earned $42M in Fees and Still Lost $20M" — aggregate LPs net-negative vs HODL ([bitquery.io](https://bitquery.io/investigations/uniswap-v3-lp-returns)).
- **Fritsch et al.**, "Risks and Returns of Uniswap V3 Liquidity Providers" (arXiv 2205.08904): most concentrated LPs underperform passive strategies ([arXiv](https://arxiv.org/pdf/2205.08904)).
- **Milionis/Moallemi/Roughgarden**, LVR paper: swap fees insufficient to cover loss-versus-rebalancing for AMM LPs ([moallemi.com](https://moallemi.com/ciamac/papers/lvr-2022.pdf)); follow-up on CLMMs ([arXiv 2410.23404](https://arxiv.org/pdf/2410.23404)); recent "active–passive gap" work ([arXiv 2609.37963](https://arxiv.org/abs/2609.37963)).
- Vendor comparison with fee numbers for Gamma/Arrakis/Beefy/MaxFi ([maxfi.tech](https://www.maxfi.tech/blog/maxfi-vs-beefy-gamma-arrakis-lp-managers)) — use with caution (vendor).

## 10 recent (2026) v4 launches / liquidity-management features
1. **Aggregator hooks live** (Oct 22, 2026) — [blog](https://blog.uniswap.org/aggregator-hooks-are-now-live), [The Block](https://www.theblock.co/news/defi/2026-10-22/uniswaps-aggregator-hooks-go-live-ethereum-base-robinhood-chain-421932)
2. **v4 on Elysium** (Nov 9, 2026) — [Binance Square](https://www.binance.com/en/square/post/11-09-2026-uniswap-v2-v3-and-v4-launch-on-elysium-386446203386183)
3. **July 2026 governance votes** on v4 protocol fees → UNI burns — [beelaa](https://www.beelaa.com/crypto-trends/uniswap-v4-2026)
4. **Bunni v2** risk-managed LP engine on v4 — [repo](https://github.com/Bunniapp/bunni-v2), [docs](https://docs.bunni.xyz/docs/v2/technical/overview/)
5. **EulerSwap** LP-management hook, production — [v4hooks.com](https://v4hooks.com/hooks/eulerswap)
6. **Doppler Whetstone** bonding-curve LP hook, production — [v4hooks.com](https://v4hooks.com/hooks/doppler)
7. **PoolClaw** AI agent for active LP management — [poolclaw.org](https://www.poolclaw.org/)
8. **Arrakis & GammaStrategies on v4** — [hookatlas.com/hooks](https://hookatlas.com/hooks)
9. **MaxFi** performance-fee-only LP manager (Mar 2026) — [maxfi.tech](https://www.maxfi.tech/blog/maxfi-vs-beefy-gamma-arrakis-lp-managers)
10. **FLAIR** LP-competitiveness metric — [app.uniswap.org/flair.pdf](https://app.uniswap.org/flair.pdf)

**Bottom line:** ideas 1–4 have no direct v4-hook prior art; nearest neighbors are fee-model and vault-curation designs outside Uniswap. Idea 5 is well-supported by published research.
