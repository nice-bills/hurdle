# Hurdle worker

One Node 22 process: HTTP `/healthz`, an **indexer** (chain → Postgres), a **keeper** (settles vaults, generates volume) and an optional **curator bot** (keeps the demo vaults centred on spot).
Reads addresses only from `../shared/deployment-1301.json` and ABIs from `../shared/abi/`.

## Env

| var | required | default | |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres URL (Render internal URL works; TLS used unless host is localhost) |
| `KEEPER_PRIVATE_KEY` | no | | Funded keeper wallet (hex, `0x` optional). Absent → indexer only. Never logged. |
| `RPC_URL` | no | `https://sepolia.unichain.org` | |
| `PORT` | no | `8080` | `/healthz` |
| `KEEPER_INTERVAL_SECONDS` | no | `600` | full tick (volume round trip + settle/park). Settle/park checks also run every 60 s in between |
| `CURATOR_PRIVATE_KEY` | no | | Wallet that is the curator of the demo vaults. Absent → no curator bot. Never logged. |
| `CURATOR_INTERVAL_SECONDS` | no | `600` | |
| `TARGET_TICK` | no | stored, else 1 h TWAP at first start | tick the keeper arbitrages spot back to (override to script a market move; also kept in `cursor` row `target_tick`) |
| `ARB_THRESHOLD_TICKS` / `ARB_MAX_TICKS` | no | `20` / `150` | swap back when `|spot - target|` exceeds the first, by at most the second per run |
| `ROUNDTRIP_WETH` / `ROUNDTRIP_TICKS` | no | `1` / `15` | synthetic volume: mWETH sold in the first leg of each round trip, and its price limit in ticks. Flow is synthetic |
| `LOW_BALANCE_WEI` | no | `2000000000000000` | `/healthz` flags `lowBalance` for the keeper and curator wallets below this (0.002 ETH) |
| `SNAPSHOT_SECONDS` | no | `120` | |
| `POLL_SECONDS` | no | `6` | indexer poll when caught up |
| `CONFIRMATIONS` | no | `3` | |

## Run

```
npm ci
DATABASE_URL=postgres://... npm run dev          # tsx
npm run build && npm start                       # compiled
npm run dry                                      # no DB, no txs: prints what the indexer would insert
npm test                                         # e2e: in-process PGlite + real RPC + unfunded throwaway keeper key
```

## Render

Background Worker (or Web Service, for `/healthz`), root dir `app/worker`:
build `npm ci && npm run build`, start `npm start`. Env: `DATABASE_URL`, `KEEPER_PRIVATE_KEY` (secret), optional `RPC_URL`.
The build copies `../shared` into `./shared`, so it also works when only `app/worker` is deployed.
Fund the keeper address (shown in `/healthz`) with a little Unichain Sepolia ETH; it mints its own mocks.

## Behaviour

- **Schema**: `schema.sql`, applied idempotently at boot. Addresses are stored **lowercase** (vault, curator, pool_id, and addresses inside `events.args`); bigints in `args` are decimal strings. `events` also holds a `VaultCreated` row per vault.
- **Indexer**: from `factoryStartBlock`, ≤1000-block `eth_getLogs` chunks, 3 confirmations, retry/backoff on `-32016`/429/network errors, one transaction per chunk (rows + cursor `events:<factory>`, one cursor per factory), `ON CONFLICT DO NOTHING`. Every ~2 min a snapshot per vault (multicall at the confirmed head; reverting views, e.g. TWAP history, store NULL) and one `pool_ticks` row (keyed by pool id; migrated idempotently from the old single-pool shape), with the tick read from `PoolManager.extsload` (StateLibrary.getSlot0 equivalent).
- **Keeper** (full tick every 10 min, settle/park check every 60 s): mint mUSDC/mWETH to itself if low and approve the swap router; arbitrage leg (if spot is more than 20 ticks from the target tick, swap back toward it, at most 150 ticks per run; run before the round trip and again after settle/park so park swaps do not leave a lasting market move); synthetic round trip (`ROUNDTRIP_WETH` down to `ROUNDTRIP_TICKS`, back to the start price, default 1 mWETH / 15 ticks, about 1 bp of NAV per hour of fees on an in-range demo vault at the current pool depth: the flow is synthetic, there are no organic traders); `settle()` every vault whose epoch is over; `rebalance(0,0)` on fired vaults until the call reverts `AlreadyParked` (full range and idle <= 2% of NAV). Each tx is simulated first; every action is a `keeper_runs` row: success, failure, or `skipped` (the simulation reverted for an expected reason such as `EpochNotOver`; one skipped row per vault/action per hour). Skips txs when its ETH < 0.0003. RPC errors are logged and the loop continues.
- **Curator bot** (every `CURATOR_INTERVAL_SECONDS`, only for vaults whose `curator()` is the bot wallet and that are not fired): when spot is outside the range or within 20% of the half-width of an edge, `rebalance(lo, hi, 200)` to a range of the same width centred on spot (aligned to tick spacing). Full-range vaults and vaults with no position yet are skipped. It never acts in the first 300 s of an epoch (the deposit window), so depositors' quotes stay valid. Every send uses gas = estimate x 1.3. After a settlement with a shortfall it repays the vault's `deficit` itself (mints the bond token if it is a mock, approves, `postBond(deficit)`), so deposits reopen without a manual top-up; when idle funds exceed 2% of NAV (and fewer than 3 rebalances were used this epoch) it redeploys them with `rebalance(lo, hi, 200)` on the current range. Expected reverts (`PriceDeviation`, `TooManyRebalances`, `BondBelowFloor`, `RebalanceIncomplete`) are recorded as `skipped`.
- **`/healthz`**: JSON with last indexed block, head, lag, vault count, last snapshot, keeper address, ETH balance, last keeper action, `lowBalance` for keeper and curator wallets (< 0.002 ETH) and a `warnings` list.
