# luna — v2
Score: 8/10
## Why not 10 (blocking items, most important first)
1. `IDEA.md:63,72` and `demo/` — The required demo video is still marked in progress and no recording link is provided. The static replay and live app help, but judges must reconstruct the mechanism from pages and charts. Add a short recorded walkthrough showing a winning settlement, a bond-paid miss, and firing/parking, linked from the README.
2. `src/HurdleVault.sol` / security evidence — The core contracts remain explicitly unaudited (`README.md`, Limits). Two regression suites and stateful invariants improve confidence, but this submission moves depositor funds and implements nontrivial share/bond accounting; a scoped independent review of the final v3 source, with findings resolved or disclosed, is needed for a 10.
3. `src/HurdleVault.sol: benchmark` and README Limits — The 300% APR fee cap is not tied to realized pool fees and remains an acknowledged wash residual that grows with elapsed time. A long epoch can therefore credit synthetic par from a high-fee pool. Replace the flat elapsed-time cap with a bound based on realized fees and active liquidity, or demonstrate a quantified worst-case exposure and enforce a maximum settlement interval.

## Strengths (max 5 lines)
- Strong, distinctive mechanism with a clear user promise; the v4 benchmark math is path-independent and independently checked against real swaps.
- v2 fixes the deposit race and untrusted-hook issue with a deposit window/re-baseline and canonical factory registry.
- Bond, carry, firing, post-fire recovery, TWAP guards, and stateful invariants are backed by focused regression coverage.
- The live app, worker, and replay are genuinely operational at review time; worker health reports two indexed vaults, a three-block lag, and a successful recent keeper action.
- Documentation is candid about limits, including bond exhaustion, non-transferable shares, and endogenous par.

## Nits (optional, do not affect score)
- `IDEA.md` still calls the video “in progress”; update it when the recording is available.
- Repo status contains unrelated modified and untracked broadcast files and a deleted `app/worker/.probe.mjs`; keep generated deploy artifacts out of review changes.
