# sonnet — v6
Score: 9/10

Checked at 882aa43 (origin/master). `forge test` (own dirs): 123 pass, 0 fail, 1 skipped. Live 2026-11-26 20:46-20:53 UTC: dApp 200, worker `/healthz` ok (lag 3, keeper balance 0.0051 ETH, curator 0.0034, no warnings, `lowBalance` false). `e2e_deposit_gate.mjs` passes.

## v5 items
1. Deposit dead end after a miss: fixed and seen live. The 20:41 UTC settle left Patient deficit 50.3 and Chaser 102.9 mUSDC (bond 549.7 / 497.1). The curator bot's 20:50:41 run repaid both: bond 600 / 600, deficit 0 (checked on-chain).
2. Quiet-pool drain not documented: the README "Live flow is synthetic" section now covers it.
3. Keeper wallet and `lowBalance` flag: fixed, wallet funded.
4. Arbitrage target: spot -196811 vs target -196800, within the 20-tick threshold, so the keeper is idle (`lastArbAt` null is correct).
5. Reckless fired at 20:41 (fired true, bond 5.1, deficit 144.9 mUSDC), as designed.

## Why not 10 (blocking items, most important first)
1. `app/worker/src/curator.ts` / `app/worker/src/config.ts:74` — the refill runs every 600 s and the deposit window is 300 s, so after a missed epoch deposits stay closed for the whole next window (settle 20:41:10, refill 20:50:41, window closed 20:46). A judge depositing in that window gets `DeficitOutstanding`; the next epoch is fine. Make it 10: run the curator tick right after the keeper settles (or poll every 60 s), so the repay lands inside the 5-minute window.
2. `README.md` (v6 section, ~line 112) — the changelog says the live v6 story is in the README, but the README only has the generic "v6 redeploy" line and no record of the 20:41 UTC fire, the Patient/Chaser deficits and the auto-refill. Make it 10: add the three lines (move at 19:42, Reckless fired 20:41, Patient/Chaser refilled 20:50).
3. `IDEA.md:65,74` — still says video "not yet" (fine until recording, but update it then).

## Strengths (max 5 lines)
- Original oracle-free par with fee cap scaled by tier, matching offchain to 0.001 bp; 123 tests plus invariants.
- Deposit and withdraw verified on an anvil fork of the live Patient vault (settle after warp, deposit 100 shares, withdraw): all succeed.
- The live curator bot repaying the deficit on its own is the strongest demo fix since v4; the keeper arbitrage holds spot at the target.
- Honest limits and legacy-deployment docs; tree clean, v6 reviews are the only untracked files.

## Nits (optional, do not affect score)
- Vault shares are 6 decimals; a first-time `previewDeposit(1e18)` returns absurd amounts, so the dApp must show share units clearly.
- `research/council/` and many `out-*`/`cache-*` dirs are on disk (ignored, but clutter).
