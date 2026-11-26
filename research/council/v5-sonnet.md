# sonnet — v5
Score: 8/10

Checked at ec7eaf4 (origin/master, clean tree). `forge test` (own out dir): 122 pass, 0 fail, 1 skipped. Live 2026-11-26 ~16:45-17:00 UTC: dApp 200, worker `/healthz` ok (lag 3, keeper and curator bot enabled, keeper doing its round-trip swaps), `e2e_app_smoke.mjs` against the live dApp: "all 18 page views clean" (mobile 390 px, no overflow). I watched the 16:58 settlement land live.

## v3 items
1. Demo video: still absent, by design this round. Not counted.
2. Reckless `reclaimBond` dead end: moot; v5 Reckless is fired, deficit 150 mUSDC, bond 0, and is the intended showcase. Banner copy was not re-checked visually (UI excluded).
3. Repo state: fixed. Tree clean, README says tests match (122), broadcast run-*.json ignored.
4. Nits: `./e2e.sh` duplicate line gone.

## Why not 10 (blocking items, most important first)
1. Live Patient and Chaser vaults — at the 16:58 UTC settle both missed par: Patient deficit 23.35 mUSDC (bond 600 -> 576.65), Chaser 13.30 (bond 587). The deposit gate (deficit above 1 bp of depositor NAV) now reverts `DeficitOutstanding` (0x929b7e84); I called `deposit` from the depositor address with the window open and got that revert. So right after the headline "the curator refilled both bonds, deposits open", the one working deposit flow is closed again within an hour, and no code path reopens it: `app/worker/src/curator.ts` only re-centres ranges, never calls `postBond`. The same happened on my anvil fork (settle after one quiet hour: deficit 23.35, deposit reverts). The dApp deposit works only in the minutes after a manual top-up. Make it 10: have the curator bot call `postBond(deficit)` (guarded by balance and a cap) after each settlement, or size the demo so the keeper's round-trip fee flow beats par, and keep one vault depositable at the time judges look. Without this, a judge who deposits sees a revert.
2. Why the miss happens on a quiet pool (research/ or README Live section) — vaults with ±10% and ±2% ranges miss par every epoch when the only flow is the keeper's 0.05 WETH round trips: the fee income is too small to beat the concentrated range's convexity loss. That is true to the design, but the README does not say that the live demo vaults will keep draining their bonds (about 4% of NAV per day at 23 mUSDC per hour on Patient) and be fired in a few days unless topped up. Make it 10: state the expected drain, or give the keeper enough volume that Patient/Chaser stay near par, and show a depositor-vs-par line that stays at or above 1.0 live.
3. Keeper wallet balance — the keeper holds 0.0021 ETH and spends gas every few minutes (swaps, settle, park steps) on three vaults plus mints. Two to three days of runway at best, and no alert in `/healthz` when low. Make it 10: top up before submission and add a `lowBalance` flag to health, or reduce the swap cadence.

## Strengths (max 5 lines)
- Original oracle-free par, wash-resistant with a calibrated 80% APR fee cap, backed by closed-form maths that matches offchain to 0.001 bp.
- 122 tests plus invariants, an independent accounting audit, real-swap replays and a clean live smoke (18 views).
- Live fire story is real and reproducible: Reckless fired and parked on-chain, keeper steps the park until `AlreadyParked`, and the worker is healthy with the curator bot re-centring only the two non-showcase vaults.
- Docs are accurate and candid about limits, token-order change and legacy deployments; repo is tidy.

## Nits (optional, do not affect score)
- Worker first call after idle is slow (uptime 34 s when I first hit it); fine, but mention cold start.
- README layout table still says "two steps" deploy and lists audits but not audit3-accounting.md.
- IDEA.md line 65 still says video "not yet"; update at recording time.
