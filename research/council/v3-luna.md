# luna — v3
Score: 8/10
## Why not 10 (blocking items, most important first)
1. `src/HurdleVault.sol:537-550` — The fee-growth cap limits but does not prevent benchmark inflation: a trader can wash trade across blocks, paying real pool fees to raise `feeGrowthGlobal`, while the virtual benchmark liquidity receives those fees without funding the vault. Over a delayed settlement, par can rise by 300% APR times elapsed time (README estimates ≤3.4 bp per 10 minutes), forcing the curator bond to pay depositors or firing the curator. Bind fee credit to fees actually earned by the vault's active liquidity, or remove fee-growth credit from par; if retaining the cap, enforce a maximum settlement interval on-chain so callers cannot stretch the exposure.
2. `src/HurdleVault.sol` — This remains unaudited despite moving depositor funds through custom share, locked-bond-share, deficit, and carry math. A rounding/accounting error in `_payShortfall`, `crystallize`, or withdrawal can transfer value between depositors and curator without an obvious failing happy-path test. Obtain an independent review of the final deployed source, resolve its findings, and add regression tests for each finding before claiming the security confidence needed for a 10.
## Strengths (max 5 lines)
- The v3 changes close the deficit top-up and fired-vault deposit traps; the alignment audit confirms the current source and live deployment relationship.
- The hook blocks donations and removes same-block fee-growth and tick manipulation from the benchmark inputs.
- Settlement, carry, shortfall, fire, park, and reclaim flows have focused regressions plus stateful invariants.
- Worker signing is isolated to configured keeper/curator keys; simulated transactions are sent only for hard-coded keeper actions or curator-owned vaults, and contract checks remain authoritative.
- README clearly discloses fee-cap, bond, and deployment limits; live v4 addresses and v3 legacy deployment are identified.
## Nits (optional, do not affect score)
- The keeper's safety still depends on the configured RPC endpoint being honest: a malicious endpoint can feed false state to the curator bot or disrupt transaction simulation/receipt tracking. Use a trusted endpoint or cross-check critical reads if this worker is funded with valuable keys.
