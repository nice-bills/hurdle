# Changelog v2 → v3

Commits 673f014 → cc7dfdb. By v2 council item (Luna 8/10, Sonnet 8/10).

## Contracts

| v2 item | Change | Test |
|---|---|---|
| Deficit gate traps a vault: after one shortfall payment, deposits stay closed until carry refills the bond (Sonnet) | `postBond` now pays the deficit down first (fresh bond tokens settle the curator's debt to the bond), so a curator can reopen deposits at once. | `test/V4Features.t.sol`: `test_postBondPaysDownDeficitAndReopensDeposits`, `..MoreThanDeficitClampsToZero`, `..PartialReducesDeficitExactly` |
| Fired vault refuses deposits forever (`CapacityExceeded` on an empty bond) (Sonnet) | Fired (passive, full range) vaults skip the bond-capacity check: no curator risk left to bond. | `test_firedVaultDepositIgnoresCapacityFloor`, `test_nonFiredVaultBelowFloorStillReverts` |
| Fee cap / late settle (Luna 2) | Tried capping the fee-credit clock at one epoch; it made a late settle hand real fees to the curator (3 fairness tests failed). Reverted: the cap grows with real elapsed time. Realized-fee cap still not done (Limits). | `test_F_settleTiming`, `test_passiveVaultSettlesAtPar`, `test_firedVaultTracksPar` |

## Live (Unichain Sepolia)

- v4 redeploy: hook, factory, three vaults — Patient (±10% (±950 ticks), 10% bond), Chaser (±2%, 10% bond), Reckless (±1%, 2.5% bond, built to be fired). Patient and Chaser are healthy and depositable (Sonnet: "no depositable live vault").
- Scripted +544-tick move 2026-11-22 15:46 UTC to fire Reckless; rehearsed on a fork first (only Reckless fires).
- v3 deployment kept as the earlier fire showcase (Patient v3 fired 2026-11-22 11:02 UTC), priced on its own pool.

## App / worker

- Indexer cursor keyed per factory (redeploys index from their own start block; old rows kept).
- Explorer: v4 vaults first, "Earlier deployment (v3)" section. Keeper handles three vaults.
- e2e step h: live dApp smoke (16 page views, two widths). Full e2e green: 98 tests (97 pass + 1 skipped replay) + invariants, both replays, par check (max 0.001 bp), UI + dApp smoke.

## 45bde1f

- Fired vaults skip the deficit gate on deposit (current src; the deployed v4 bytecode predates it).
- Keeper parks fired vaults until `AlreadyParked`; `script/AddDepth.s.sol` adds pool depth.
- Curator bot in the worker (re-centres the demo vaults), with README fee-cap wording fixes.

## Not done

- (Demo video landed in c11c654: `demo/video/hurdle-demo.mp4`.)
- Realized-APR fee cap; independent audit.
