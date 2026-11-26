# Changelog v4 → v5 (round 5)

Commits ec7eaf4 → HEAD. By round-4 item (Opus 7, Sonnet 8, Luna 8).

| Item | Change | Where / test |
|---|---|---|
| App blocks the only depositable vault (Opus 1) | Stale fired-vault deficit branch removed; non-fired deficit gate mirrors the contract exactly (depositor shares). | `app/web/src/lib/deposit-rules.ts`, `e2e_deposit_gate.mjs` (e2e step f2) |
| Demo moves leave lasting "market moves" (Opus 2) | Keeper acts as the arbitrageur: pulls spot back toward a target tick (env → deployment `keeperTargetTick` → stored per pool → 1-h TWAP), ≤150 ticks/run. | `app/worker/src/keeper.ts` |
| No carry shown live / deposits reopen only by hand (Opus 2, Sonnet 1) | Larger configurable round-trip flow (synthetic, labelled as such); curator bot auto-repays the deficit after a miss, redeploys idle > 2%, 1.3× gas buffer. | `app/worker/src/curator.ts`, README "Live flow is synthetic" |
| "Quiet pool drains the bond" (Sonnet 2) | Checked live: settles after the scripted move were at/above par (Chaser +0.07–0.11 bp, carry recoup); the misses came from our own move + park swaps in a then-thin pool. Pool depth now added at deploy. | README live story |
| Keeper wallet low (Sonnet 3) | Funded; `/healthz` low-balance flag + warnings for keeper and curator. | `app/worker/src/health.ts` |
| Fee cap calibrated on one tier (Opus 4) | Per-vault immutable `maxFeeAprBps = 8000 × fee / 500` (≤ 100 000). | `test_feeCapScalesWithFeeTier`, `research/fee-cap.md` §6 |
| Wash-fee benchmark (Luna 1) | Kept as a documented, bounded trade-off: only out-of-range vaults, 0.91 bp/h at 0.05% (5.5 at 0.3%); an in-range vault earns ~168× the credit. | README Limits, `test/FeeCapAttack.t.sol` |
| External audit (Luna 2) | Not possible before the deadline; model audits only (audit2, audit3, alignment), stated in README. | README Limits |
| Nits | ABIs regenerated (`settleForWithdraw(address)`, `maxFeeAprBps`); `pool_ticks` keyed by pool; V4Features reaches the fired state with real calls; deploy freeze note; hook salt offset for redeploys. | |

## Live — v6 (2026-11-26)

Redeployed (9fdb7c5) with pool depth added up front. Scripted −555-tick move at 19:42 UTC (rehearsed on a fork: only Reckless fires); keeper target held at the moved tick. v5 kept read-only as the earlier deployment.

## Not done

- UI redesign and demo video: deliberately after this round.
