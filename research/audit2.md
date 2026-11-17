# Second independent audit: findings and fixes

A second fresh-context audit (Opus 5.5, no prior context; it read the README and research/ only after its
own pass) raised 12 items. Its PoCs proved #1–#4 against the code at commit 32332f4. Each item is listed
below by the auditor's number, with the fix and its test. Regression tests are in
`test/audit/Audit2Regression.t.sol`.

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | **Medium.** The curator was fired whenever `bondValue < minBond·NAV`, even while beating par. The bond is fixed token1, while NAV grows with price, fees, carry and deposits up to capacity, so drift alone forfeited the bond. | Firing now needs a settlement that **paid a shortfall** and left the bond below **half** the floor. Below the floor without a miss: in-kind deposits revert `CapacityExceeded` and curator rebalances revert `BondBelowFloor` until `postBond`. That keeps `4·dev ≤ minBond` true whenever a curator rebalance runs. | `test_M_trackingParWithNavGrowthNotFired`, `test_M_beatParAtCapNotFired`, `test_M_thirdPartyFillThenDriftNotFired`, `test_beatingParNeverFires`, `test_fireRule` |
| 2 | **Medium.** `deficit` was absolute, so newcomers and the remaining holders repaid compensation that went to earlier depositors (2.9% of upside in the PoC). | In-kind deposits revert `DeficitOutstanding` while `deficit > 1 bp of NAV`. Shares are fungible, so no scaling can exempt a newcomer; the gate is the only exact fix. `withdraw` removes exactly the withdrawer's pro-rata share of `deficit`, once: recouped by `crystallize` if ahead of par, forgiven otherwise. Per-share deficit is unchanged by exits. | `test_E_newcomerCannotJoinWhileDeficit`, `test_E_perShareDeficitUnchangedByWithdraw`, `test_midEpochWithdrawRecoupsDeficitFirst` |
| 3 | **Medium/Low.** `rebalance` checked `fired` before settling, so a settle that fired the curator parked the vault and then redeployed it to the curator's range. | `rebalance` settles first. If that settle fires the curator, it returns without touching the parked position. | `test_D_firedInsideCuratorRebalanceStaysParked`, `test_fireRule` |
| 4 | **Low.** A front-run pinning spot at the swap-band edge made rebalances swap almost nothing while each used one of the 4 per-epoch slots; the same blocked a fired vault's park. | New overload `rebalance(lo, hi, maxIdleBps)` reverts `RebalanceIncomplete` if more than `maxIdleBps` of NAV is left idle; the revert keeps the slot. After firing, park calls are permissionless and uncounted (they only move toward 50/50), so griefing them only delays at the attacker's cost. | `test_K_griefedRebalanceRevertsAndKeepsSlot`, `test_K_firedParksNotCapped` |
| 5 | **Low.** Rebalances (and the fire-time park) revert when the 30-min TWAP lags spot by more than 50 ticks. | **Documented, not code-fixed**: loosening the check reopens F2 (cross-block price holds). Reproduced on the real data: \|spot − TWAP30\| > 50 ticks in 2.6–4.6% of minutes per week, 3.4% over all five weeks (4.6% in the ETH −14% week). The park is retried by anyone once the TWAP catches up. | README Limits |
| 6 | **Low.** Anyone could make the first deposit, so a dust deposit could block the curator's own start (and the deploy script). | The first deposit is `deposit(amount0, amount1, receiver)`, curator-only; shares go to `receiver`. | `test_firstDepositCuratorOnly`, `test_depositSlippageAndFirstOnly` |
| 7 | **Low.** Same-block wash swaps lifted `feeGrowthGlobal`, so par at withdraw time, letting a withdrawer dodge carry (≤ ~3.4 bp of NAV per hour × carry). | The hook records fee growth at the first swap of each block (`referenceFeeGrowth`). The vault uses it for settlement, `crystallize`, the first deposit and every epoch start, so same-block swaps cannot move par. Cross-block washing stays bounded by the fee cap (F3). | `test_7_washBeforeSettleDoesNotChangeBench`, `test_7_washBeforeWithdrawDoesNotChangeCarry`, `test_referenceFeeGrowthIgnoresSameBlockSwaps` |
| 8 | Info. Settle timing is not a free option. | No change needed. | `test_F_settleTiming` |
| 9 | Info. Test gaps. | `Benchmark.t.sol` now tests the deployed `HurdleVault.benchmark` against a real v4 position (max error 1.43e-18 of capital, asserted ≤ 2.5e-18) and checks that the fee cap binds. `Replay.t.sol` skips without `REPLAY_CSV` and otherwise asserts depositor ≥ par at every settlement and no settlement revert. `test_fireRule` fires through the curator's `rebalance`. `twapTick` now rounds toward −∞ like v3, with hand-computed expectations. | `test/Benchmark.t.sol`, `test/Replay.t.sol`, `test/HurdleHook.t.sol` |
| 10 | Info. The live deployer was both curator and depositor, and curator shares are not covered, so the live vaults could never pay a shortfall. | `DeployVaults` makes the curator fund the first deposit with shares minted to a separate depositor address, derived from the deployer key (`keccak256(pk, "hurdle-depositor")`); only the address is written. | live deploy |
| 11 | Info. In-kind deposits added liquidity at spot with no deviation check. | `deposit(shares, …)` now requires spot, block-open price and TWAP to agree within `maxTickDeviation`. | `test_11_depositRevertsWhenSpotPushed` |
| 12 | Unchanged-from-claims checks (round trips, bond isolation, shortfall math, self-call gas, TWAP/reference manipulation). | No change needed. | — |

Side effect of #7: fees from swaps in the settlement block after its first swap count in the vault's NAV
in that epoch but in par only in the next epoch (which starts from that block's block-open fee growth).
Each is counted once; it is a one-block timing shift, first in the curator's favour, then against it.

Residual of #1: a curator whose bond has already drifted below half the floor (NAV roughly doubled
against the bond without a top-up) is fired by any miss, however small (even a few wei). It was already
unable to rebalance or take deposits from the moment it fell below the floor, and can avoid this by
topping up with `postBond`.

Replay note for #1: in the ETH −14% week, Chaser's bond sits under the floor for much of the week, so 36 of
its re-centers revert `BondBelowFloor` (19 more revert `PriceDeviation`, see #5). The replay curator never
tops up, so Chaser is frozen in its last range rather than fired. In the range week: 0 and 24.

Replay with the fixes (both weeks, depositor never below par at any settlement):

| Week | Vault | NAV vs par | Depositor vs par | Bond paid | Fired |
|---|---|---|---|---|---|
| Range (Oct 31 – Nov 6) | Patient | +1.92% | +1.57% | 2.64% | no |
| | Chaser | −2.10% | +1.64% | 6.58% | day 5.7 |
| ETH −14% (Nov 7 – 13) | Patient | −4.25% | +0.11% | 10.23% | day 6.2 |
| | Chaser | −1.98% | +0.52% | 8.22% | no |

Percentages are of starting capital, valued in token1. Par matches the offchain reference within 0.001 bp.
In the down week the old rule fired Chaser on day 4 from drift; under the new rule its bond (2.3% left)
never fell below half the floor after a miss.

Regression tests were checked by mutation: undoing each code fix (#1, #2 both halves, #3 restored to the
old check-before-settle order, #4 both halves, #6, #7, #11) makes its named test(s) fail.

Gas cost of #7: steady-state hook overhead on the first swap of a block rose from ~12k to ~40k (two fee-growth
reads and writes); see research/phase3-twap.md.
