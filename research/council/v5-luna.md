# luna — v5
Score: 8/10
## Why not 10 (blocking items, most important first)
1. `src/HurdleVault.sol:67-70, 584-608`, `research/fee-cap.md` — The fee-growth benchmark still pays a cross-block wash-trade attacker from the bond: a dominant LP can recycle most of its swap fees while raising the virtual full-range benchmark, and the bond transfers real value to depositors at up to 0.91 bp NAV/hour. Repeating the attack drains a 10% bond in about 46 days under the documented estimate. This is bounded, but not economically eliminated. Require benchmark fee credit to be backed by fees the vault actually earned, or add a cumulative hard loss cap / pause that prevents prolonged bond drain; retain a regression that tries the sustained attack.
2. `src/HurdleVault.sol` — Share, bond, deficit, shortfall gross-up, and carry math remain high-impact custom accounting without an independent review of this exact source. The regression and invariant suite is materially stronger, but model audits cannot provide the same assurance as an independent Solidity review. Obtain an external audit of this version and add tests for each finding before relying on depositor guarantees with meaningful funds.
## Strengths (max 5 lines)
- My v4 parked-deposit issue is resolved: fired deposits check `_parked()` and revert if fire-time parking failed; regression coverage exists.
- The shortfall coverage definition and payout gross-up are aligned with the README and handler; the v4 ambiguity is resolved.
- Audit3's depositor-only deficit, noise-neutral recoup, and implicit-settlement bounty fixes are implemented with focused regressions and added invariants.
- The keeper and curator bot simulate before sending, tolerate expected reverts, bound their managed vault set, and the curator bot leaves the deliberately reckless vault alone.
- `forge test` passes in isolated `out-luna5` / `cache-luna5` directories; the live v5 addresses, worker health and recent keeper/curator activity match the deployment documentation.
## Nits (optional, do not affect score)
- The fee cap can clip genuine high-fee periods, shifting that excess to the curator; the trade-off is measured and documented.
