# luna — v6
Score: 9/10
## Why not 10 (blocking items, most important first)
1. `src/HurdleVault.sol:67-70, 587-608`, `research/fee-cap.md` — A dominant LP can recycle swap fees across blocks while the vault is idle or out of range, raising the full-range benchmark and drawing real value from the bond. At the documented cap this can drain a 10% bond over about 46 days. This is materially bounded versus the earlier cap and does not affect a vault earning concentrated fees in range, so it is a disclosed hackathon trade-off; to remove the remaining risk, make benchmark fee credit conditional on fees the vault actually earned, or add a cumulative bond-loss limit that pauses the vault, with a sustained-attack regression.
## Strengths (max 5 lines)
- The fee cap is computed per vault and scales with the fee tier; live Patient reports 8,000 bps on its 500 fee pool, and the live pool key matches deployment configuration.
- Worker keeper and curator actions simulate before sending; arbitrary indexed vaults can be settled, while the curator bot is explicitly allow-listed to Patient and Chaser. Onchain rebalance and price limits bound bad or stale keeper decisions.
- Auto-refill only mints the configured test mock tokens, caps a refill at the deficit/NAV check, and uses `postBond`; idle redeployment respects the deposit window and routine rebalance count.
- Invariant suite passes in isolated `out-luna6`/`cache-luna6` (23 tests); core audit PoCs, fee-tier cap regressions, and vault feature tests also pass.
- Read-only v6 checks confirm deployed Patient bytecode exists, its fee cap is 8,000, and its pool key is the configured pool. Worker health was clean with a three-block indexer lag and funded keeper/curator wallets.
## Nits (optional, do not affect score)
- The live check verified runtime presence and key getters, not a full byte-for-byte runtime comparison: Solidity immutables require masking constructor-patched regions before comparing deployed code with the build artifact.
- The keeper arbitrage can move spot toward a fixed configured tick and the round trip creates synthetic fees; the demo labels that flow synthetic. A bad RPC can delay or misdirect an attempt, but swap limits and contract checks constrain the effect.
