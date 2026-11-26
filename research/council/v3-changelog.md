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

## Audit 3 accounting fixes + fee cap 80% (806d2ea and after)

Independent accounting audit: `research/audit3-accounting.md` (Resolution column per finding).

- Fee-cap APR lowered to 80% (`MAX_FEE_APR_BPS = 8_000`, 806d2ea): ~2x p99 of the real weeks' hourly fee credit,
  never binds there; wash-trade bond drain bounded to ~0.91 bp of NAV per hour.
- **A (Medium).** `deficit` is owed by depositor shares only (`t - bondShares - balanceOf[curator]`). `_reward` grosses
  the recoup up (`ceil(d*t/dep)`) so depositors repay exactly what they received; `crystallize`, `withdraw` and the
  deposit gate use depositor shares; the curator's own withdraw/crystallize neither takes nor forgives deficit. A miss
  then an equal beat is neutral (60 cycles of +-2.5%: depositor -0.7%, genuine carry on m^2/N; was +53%).
- **B (Low).** A fired vault that is not parked refuses deposits (`NotParked`); a fired AND parked vault still skips the
  deficit/capacity gates. App: deposit status line and revert text cover `NotParked`; keeper unchanged.
- **I3.** An implicit epoch-end settle (deposit, withdraw) pays the keeper bounty to its caller (not the curator):
  `settleForWithdraw(address)` is now parameterised. Self-call only; no change to the external ABI the app uses.
- **I4** is removed by A. I1, I2, I5, I6 stay documented residuals (audit Resolution column).
- Contract size: `_parked()`, `_fullRange()`, `_pull()` factored out so the factory (which embeds the vault initcode)
  stays under EIP-170: vault runtime 21,531 B, factory 24,405 B (limit 24,576).
- Tests: `test/audit/Audit3Regression.t.sol` (the PoCs, now asserting the fix), the audit's 11 invariants in
  `test/invariant/` (handler: curator deposit/withdraw, keepers, deficit/par ghosts) and `NoiseNeutrality.t.sol` (fuzz).
- Handler "covered settle" now means the bond is worth the whole shortfall: bond tokens that enter the vault are shared
  with the curator's free shares, so a bond worth only the depositors' slice can leave them up to x/t short until the next settle.

## Not done

- Demo video: not yet. `demo/video/` holds a discarded draft; the final recording comes after the UI is settled.
- Realized-APR fee cap; independent audit.
