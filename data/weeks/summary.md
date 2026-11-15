# Weekly replay summary

Capital $1M; Patient = static ±10%, Chaser = re-center ±2% (data/replay_ref.py, untuned). 'par' = same-capital passive full-range LP (closed form, fees always accrue); bps columns are excess vs HODL in bps of capital, 'vs par' = strategy minus par. Vol = annualized stdev of hourly log returns. Volume = swap input side.

| week (UTC start) | swaps | ETH start | ETH end | move % | rvol (ann.) | volume $M | par excess bps | Patient vs par bps | Chaser vs par bps | Chaser rebals | Patient fees bps | Chaser fees / rebal-cost bps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-10 | 45457 | 2487 | 2420 | -2.67 | 48% | 284 | +4.6 | +95.1 | -434.5 | 15 | 119 | 538 / 213 |
| 2026-10-17 | 32586 | 2420 | 2384 | -1.51 | 44% | 217 | +4.7 | +96.8 | -72.0 | 8 | 108 | 492 / 117 |
| 2026-10-24 | 41146 | 2384 | 2242 | -5.94 | 138% | 617 | +11.9 | +211.1 | -4049.3 | 58 | 321 | 1118 / 657 |
| 2026-10-31 | 33216 | 2242 | 2236 | -0.27 | 51% | 399 | +10.5 | +198.1 | -4233.3 | 30 | 209 | 564 / 287 |
| 2026-11-07 | 42280 | 2236 | 1928 | -13.80 | 58% | 1,312 | -19.0 | -378.1 | -1501.1 | 23 | 83 | 580 / 301 |

## Selection (rule in data/README.md, fixed before comparing)

- **Demo week** (smallest |net ETH move|): **2026-10-31**, -0.27%.
  - Patient beats par: **YES** (+198.1 bps).
  - Chaser trails par: **YES** (-4233.3 bps).
- **Second scenario** (existing down week): 2026-11-07.
