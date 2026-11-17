# Hurdle: audit fixes (F1–F15)

Findings: [audit-independent.md](audit-independent.md). Regression tests in `test/audit/AuditPoC.t.sol`
keep each PoC's scenario and assert the attack no longer works.

| # | Fix | Test | Residual |
|---|---|---|---|
| F1 | Deposits are in kind: `deposit(shares, max0, max1)` pulls exactly what `withdraw(shares)` would pay, rounded up (idle pro rata + `ceil(L·shares/supply)` added at spot, paid by the depositor in the unlock callback). No price is used. | `test_F1_noArbDepositWithdrawInKind`, `test_depositInKindRoundTrip` | Only the first deposit is valued (TWAP, spot/reference checked, dead shares). It has no counterparty. |
| F2 | `_swapToRatio` limits the swap to `(referenceTick ± dev) ∩ (TWAP ± dev)` and skips it if the two bands do not overlap. Rebalances and the park also require `|spot−ref|`, `|spot−twap|` and `|ref−twap|` ≤ dev. | `test_F2_laggedTwapRebalanceBlocked`, `test_swapBoundedByReferenceAndTwap`, `test_rebalanceRevertsWhenTwapLagsReference`, `test_rebalanceRevertsOnSpotDeviation` | `4·dev ≤ minBond` holds against the block-open price. A price held off-market across a block boundary passes every check, at the cost of a block of arbitrage exposure. |
| F3 | `benchmark(..., elapsed)` caps the fee credit at `nav0 · MAX_FEE_APR_BPS · elapsed / (10000 · 365 d)`, with `MAX_FEE_APR_BPS = 30000` (300% APR). | `test_F3_washSwapBoundedByFeeCap`, `test_benchmarkFeeCreditCapped` | Inflation is bounded by the cap, about 0.57 bp of NAV per 10-min epoch. An attacker who is also the pool's only other LP recovers its swap fees and nets up to the cap each epoch, which drains a 2% bond in about 2.4 days of continuous washing. A real fee burst above the cap counts as curator excess. A tighter cap, such as the pool's realized fee APR, shrinks both. |
| F4 | Deposits happen only in the settlement block, after the bond has paid what it can, and only while the bond is at or above the floor and no payout is unrecouped (`DeficitOutstanding`, added after the second audit). So nobody can buy into an uncovered guarantee. | `test_F4_noDepositIntoUnderBondedVault` | — |
| F5 (deposit) | Settlement-block-only deposits: the pending take is zero, so a newcomer pays for no prior excess. `start.nav` scales by `(supply+shares)/supply`. **Corrected by the second audit (#2):** an outstanding `deficit` was still charged to newcomers; deposits now revert while it exceeds 1 bp of NAV. | `test_depositOnlyAtSettlement`, `test_E_newcomerCannotJoinWhileDeficit` | Depositors wait for the epoch end, and for the curator to recoup past payouts. |
| F5 (withdraw) | Mid-epoch, if `nav > par` at TWAP, the withdrawn shares pay their pro-rata share of what `_reward` would take (recoup first, into bond shares and reducing `deficit`, then carry to the curator). Payment is a share transfer before payout. | `test_midEpochWithdrawPaysCarry`, `test_midEpochWithdrawRecoupsDeficitFirst` | Behind par mid-epoch, a withdrawer still leaves without a top-up (documented shortcut). |
| F6 | The constructor requires `carryBps ≤ 5000`, `100 ≤ minBondBps ≤ 5000`, `epochSeconds ≥ 600`, `4·dev ≤ minBond` and `currency0 ≠ 0`. | `test_constructorRejectsBadParams`, `test_constructorRejectsUnsafeDeviation` | The hook (oracle) is not verifiable onchain. Depositors must check that `poolKey.hooks` is the canonical HurdleHook (README). No factory. |
| F7 | Redeployment is handled by the hook commit 73fbf6e and the deploy-script agent. | — | The live Sepolia contracts stay unfixed until the redeploy. |
| F8 | Hook commit 73fbf6e: `twapTick` reverts until there are 10 min of history. | hook tests | — |
| F9 | `withdraw` runs settlement (`settleForWithdraw`) and crystallization (`crystallize`) as `try this.…` self-calls guarded by `msg.sender == address(this)`. If settlement fails, fees are still realized before the in-kind payout. The fire-time park is `try this.park()`, so a failed park never reverts the settlement. | `test_withdrawSurvivesOracleRevert`, `test_firingSettleSurvivesFailedPark`, `test_selfCallsGuarded` | Gas griefing a self-call into OOG leaves 1/64 of the gas, which is too little for the payout that follows. `deposit`, `rebalance` and `settle` still revert on oracle failure. |
| F10 | Hook commit 73fbf6e. | — | — |
| F11 | The curator's free shares are excluded from `owed`, like bond shares. Burns and top-ups also lift those shares, so the lift is locked back into `bondShares`. The curator's free value stays `c·nav/t`, and bond value falls by exactly what depositors receive. | `test_curatorSharesAbsorbOwnMiss`, `test_deficitRecoupedBeforeCarry` | The curator can regain cover by withdrawing its free shares and redepositing them from another address (needs a settlement block; the deposit then counts against capacity). |
| F12 | Hook commit 73fbf6e. | — | — |
| F13 | The constructor rejects `currency0 == 0`. A comment says native ETH and fee-on-transfer/rebasing tokens are unsupported. | `test_constructorRejectsBadParams` | Not enforced for fee-on-transfer tokens. |
| F14 | Documented only: every vault operation calls `manager.unlock`, so the vault cannot be called from inside another unlock. | — | — |
| F15 | Hook commit 73fbf6e (flags are `afterInitialize`, `beforeSwap` and `beforeDonate`). | — | — |

## Interface change (for the Replay/script agent)

- `deposit(uint256 amount0, uint256 amount1)` is now **first deposit only** (`NotFirstDeposit` otherwise). It resets the benchmark start to that block. `test/Replay.t.sol` and `script/DeployHurdleHook.s.sol` still compile against it.
  - Its `_checkedTwapSqrtPrice` needs 10 min of pool history, plus spot, reference and TWAP within `maxTickDeviation`.
- Later deposits use `deposit(uint256 shares, uint256 max0, uint256 max1) returns (amount0, amount1)`. They work in the first-deposit block or in any settlement block; otherwise they revert with `DepositsOnlyAtSettlement`.
- `benchmark` takes a sixth argument, `elapsed` (seconds since `start.timestamp`).
- `data/par_check.py` has no fee cap. If an hourly epoch earns more than about 3.4 bp of fees (300% APR), on-chain par falls below the offchain value, and the README's 1 bp replay match fails for that epoch.
