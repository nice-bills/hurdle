# data/ — real ETH/USDC swap week + replay reference

One week of real Uniswap v3 swaps (ETH/USDC 0.05%, Ethereum mainnet) plus a
closed-form replay reference for the Hurdle benchmark (IDEA.md "60-second
demo"): per-day passive-LP benchmark and two toy curator strategies
(**Patient** static ±10% vs **Chaser** re-centering ±2%).

## Files

| File | What |
|---|---|
| `fetch_swaps.py` | Fetcher: chunked `eth_getLogs`, retry/backoff, endpoint rotation, adaptive range splitting, raw-log resume cache. Stdlib + `requests`. No API keys. |
| `swaps.csv` | 42,280 decoded Swap events, 5.0 MB. `block,timestamp,logIndex,amount0,amount1,sqrtPriceX96,liquidity,tick` |
| `replay_ref.py` | Closed-form benchmark (per day + week) and the Patient/Chaser simulation. |
| `replay_results.json` | Machine-readable output of `replay_ref.py`. |
| `block_timestamps.json` | block → timestamp cache (23,731 blocks; reused on rerun). |
| `fetch_meta.json` | Fetch provenance: window, block range, endpoints, per-day counts. |

## Source and window

- Pool `0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640` — Uniswap v3, 0.05% tier.
  Verified onchain: `token0()` = USDC (`0xa0b8...eb48`, 6 dec), `token1()` =
  WETH (`0xc02a...6cc2`, 18 dec), `fee()` = 500.
- Window: **7 complete UTC days 2026-11-07T00:00:11Z .. 2026-11-13T23:59:59Z**,
  blocks **26,359,254 .. 26,409,492** (50,239 blocks).
- 42,280 Swap events (`Swap(address,address,int256,int256,uint160,uint128,int24)`),
  deduped by (blockNumber, txHash, logIndex), sorted by (block, logIndex).
  Per day: 2700 / 3806 / 7616 / 6915 / 7297 / 6282 / 7664.
- Event decoding is cross-verified on the data itself: for every swap with
  ≥ $10 notional, the price implied by the two amounts matches the
  `sqrtPriceX96` price to a median of 0.049% (p99 0.05% — tick granularity),
  and `tick ≈ ln(P)/ln(1.0001)` throughout.

## Rerun

```bash
python3 data/fetch_swaps.py    # ~6 min; recomputes the same 7-complete-days
                               # window only if run the same UTC day
python3 data/replay_ref.py     # ~10 s, offline (reads swaps.csv only)
```

Reruns are cheap: a completed raw-log fetch is cached in `.rawlogs_cache.json.gz`
(deleted on success) and block timestamps in `block_timestamps.json`. The
window is "the 7 most recent complete UTC days", so a rerun on a later day
fetches a different (newer) window.

## Results snapshot (2026-11-07 → 11-13)

ETH drifted 2236 → 1928 USDC (−13.8%) over the week; pool volume ≈ $1.31B
(input side), so pool fees ≈ 5 bps of volume by construction.

- Passive full-range, $1M: fees **+$659**, IL **−$2,561** → benchmark
  **−$1,903** (−19 bps of capital). Per unit in-range liquidity: fees
  6.2e-14 USDC, IL term −2.4e-13 USDC (week endpoints, valued at end price).
- **Patient** (static ±10%, $1M): fees 82.6 bps, 0 rebalances, excess vs HODL
  **−397 bps**. Range was exited on day 7 (fees → 0 once out of range).
- **Chaser** (re-center ±2%, $1M): 23 rebalances, fees 579.8 bps but rebalance
  costs 301.4 bps, excess vs HODL **−1,520 bps** — 7.7× worse than Patient and
  far below par, consistent with the Bitquery 17-of-20 re-centering result.
- Both strategies ended below the passive benchmark in this particular week
  (a one-way −13.8% grind): IL dominated fees at this pool's volume/liquidity.
  Strategy-vs-par comparisons across other weeks are what the demo chart shows.

## Method (mirrors research/ref/benchmark.py)

- Fee per unit in-range liquidity: `0.0005 × swap input volume / L_event`
  (the event's post-swap in-range liquidity), accumulated swap by swap in
  token terms; WETH-denominated terms converted to USDC at the period-end
  price (single end-of-period valuation, as in the identity).
- IL term per unit L over a window with endpoints (s0, s1):
  `−(s1 − s0)²/s0` (WETH-raw per L). **Path-independent except fees** — the
  property the hook exploits (2 snapshots per epoch, ~0 swap gas).
- Toy strategies: a v3 position's inventories are closed-form in the current
  price, so P&L = closed-form value change + fees earned while in range
  (pro-rata share `L_pos/L_pool`) − rebalance costs. Chaser re-centers
  whenever price exits its ±2% range, trading inventory into the fresh shape
  at the market price (value-preserving) and paying 0.05% pool fee + 0.10%
  slippage on the traded notional; liquidity is re-scaled to preserve capital.

## Caveats

1. **Topic0**: the pool emits Swap with topic
   `0xc42079f9...8004e115fbcca67` (recorded in `fetch_meta.json`), which is
   what we filter on. Note this differs from the topic hash often quoted in
   v3 docs (`0xc42079f9...bc972c3d`); we verified by decoding the data
   (tick/price/amount cross-checks above) rather than trusting a constant.
2. **Event semantics**: `amount0/amount1` are pool-perspective — positive =
   the pool received that token (the swap's input). Fee accrual uses the
   positive side. Swaps with zero/ambiguous amounts or zero event liquidity
   are skipped for fees (0 such rows in this fetch).
3. **Fee attribution approximation**: a swap's fee is credited to the range
   containing the *post-swap* price, and liquidity density is assumed uniform
   within a position's range (exact within a tick in real v3). Swaps that
   jump across a whole range in one hop credit no fees to that range.
4. **IL is not additive across days**: fees accumulate daily, but the IL term
   is a function of window endpoints, so sum-of-daily-benchmarks ≠ weekly
   benchmark (both printed).
5. **Toy-strategy fee share** uses `L_pos/L_pool` per swap; with ±2% this
   assumes unrealistically deep concentration (a $1M ±2% position would be a
   large fraction of this pool's near-price liquidity — a modeling artifact,
   favorable to the Chaser, which still loses badly).
6. **Sim numbers**: absolute USDC values are from this environment's chain
   state; treat bps-of-capital and strategy-vs-benchmark comparisons as the
   meaningful outputs.
7. `sqrtPriceX96`, `liquidity` are uint160/uint128; `amount0/amount1` are
   int256 (two's-complement negatives decoded).

## RPCs tried (2026-11-14), free tier, no keys

Working for this fetch:
- `rpc.mevblocker.io` — getLogs for week-old blocks, no observed range limit,
  includes `blockTimestamp` in each log (primary).
- `rpc.flashbots.net` — getLogs max 2000 blocks per call.
- `eth.drpc.org` — small ranges on the free plan; also returns
  `blockTimestamp` in logs.
- `ethereum-rpc.publicnode.com`, `1rpc.io/eth`, `cloudflare-eth.com` — used
  for `eth_blockNumber`/`eth_getBlockByNumber` only.

Rejected:
- `eth.llamarpc.com` — HTTP 525.
- `eth.merkle.io` — HTTP 1015 / 403.
- `rpc.ankr.com/eth` — requires an API key (free account) for getLogs.
- `ethereum-rpc.publicnode.com` for getLogs — "Archive requests require a
  personal token" for blocks older than ~128.
- `1rpc.io/eth` — getLogs range limited to 50 blocks.
- `eth-mainnet.public.blastapi.io` — getLogs range limited to 10 blocks.
- `eth.meowrpc.com` — `eth_getLogs` not supported.
- `cloudflare-eth.com` for getLogs — internal error.

Fetcher behavior: rotates endpoints per request, exponential backoff on
429/5xx/network errors, and splits the block range in half when an endpoint
rejects the range or result count (detects "greater than", "ranges over",
"response size", etc.).
