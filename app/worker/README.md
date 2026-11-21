# Hurdle worker

One Node 22 process: HTTP `/healthz`, an **indexer** (chain → Postgres) and a **keeper** (settles vaults, generates volume).
Reads addresses only from `../shared/deployment-1301.json` and ABIs from `../shared/abi/`.

## Env

| var | required | default | |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres URL (Render internal URL works; TLS used unless host is localhost) |
| `KEEPER_PRIVATE_KEY` | no | | Funded keeper wallet (hex, `0x` optional). Absent → indexer only. Never logged. |
| `RPC_URL` | no | `https://sepolia.unichain.org` | |
| `PORT` | no | `8080` | `/healthz` |
| `KEEPER_INTERVAL_SECONDS` | no | `600` | |
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
- **Indexer**: from `factoryStartBlock`, ≤1000-block `eth_getLogs` chunks, 3 confirmations, retry/backoff on `-32016`/429/network errors, one transaction per chunk (rows + cursor `events`), `ON CONFLICT DO NOTHING`. Every ~2 min a snapshot per vault (multicall at the confirmed head; reverting views, e.g. TWAP history, store NULL) and one `pool_ticks` row, with the tick read from `PoolManager.extsload` (StateLibrary.getSlot0 equivalent).
- **Keeper** (every 10 min): mint mUSDC/mWETH to itself if low and approve the swap router; round trip on the pool (5 ticks down, back to the start price); `settle()` every vault whose epoch is over; `rebalance(0,0)` on fired vaults not yet parked full range. Each tx is simulated first; every action (success or failure) is a `keeper_runs` row. Skips txs when its ETH < 0.0003. RPC errors are logged and the loop continues.
- **`/healthz`**: JSON with last indexed block, head, lag, vault count, last snapshot, keeper address, ETH balance, last keeper action.
