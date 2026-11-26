# opus — v3
Score: 7/10

Checked at 9028807. `forge test` (out-opus/cache-opus): 95 passed, 0 failed, 1 skipped. Live: dApp and the
GitHub Pages replay return 200. Worker `/healthz` is ok (lag 3 blocks, 5 vaults), but its `uptimeSeconds` was
123, so it had just restarted again. On a local anvil fork I warped to the next epoch window and ran
`settle()` and a real `deposit()` into Chaser: it succeeded, so the v2 "no depositable vault" item is closed.
Reckless on the same fork reverts `DeficitOutstanding`. I sent nothing to the live chain.

## Why not 10 (blocking items, most important first)
1. Live fired vaults are not parked, and so do not track par (`HurdleVault._swapToRatio` :690–714,
   `app/worker/src/keeper.ts:230`, `app/web/src/lib/server/data.ts:146`). The README and the app say a
   fired vault "parks passive full range: it now simply tracks par". On chain, neither fired showcase does
   that:
   - **Reckless v4.** NAV is 2.051 mWETH. It holds 1.939 mWETH idle against a full-range position of only
     2.996e12 liquidity, so about 95% of NAV sits idle in mWETH.
   - **Patient v3.** It holds 2.136 of 2.146 mWETH idle, about 99.5%.

   The fire-time park set the ticks to full range, but its swap is capped at ±50 ticks. On this thin pool
   that swaps about 5% of NAV per call. I tested this on a fork: three permissionless `rebalance(0,0)` calls
   in a row moved idle mWETH only 1.939 → 1.826. Each later call does nothing until the price and the TWAP
   come back.

   The keeper and the app call a vault "parked" when its ticks are full range, so the keeper never retries.
   The contract judges it differently: `AlreadyParked`/`NotParked` look at idle ≤ 2%. Two results follow:
   - Depositors in both fired vaults are long WETH with a bond of 0. The "+2.36 bp vs par" settlements on
     Reckless are this exposure, not fees. I decoded the `Settled` events: par's fee credit is 0.007 bp.
   - `reclaimBond` reverts `NotParked`, so `deficit` never clears and Reckless refuses deposits for good.
     The page says deposits reopen on `reclaimBond`, but that call cannot succeed.

   The replay hides all of this because it adds 1e21 of background liquidity.

   To make it a 10:
   - Define "parked" one way everywhere (idle ≤ 2%).
   - Have the keeper repeat park calls until that holds, with return-leg swaps between calls.
   - Finish parking both live fired vaults before judging.
   - Add a thin-pool test, with the vault holding ≥ 50% of in-range liquidity, that measures how long a
     park takes.
   - Then either let a fired vault's park proceed in TWAP-paced chunks, or document "fired ≠ par until
     parked" in Limits and on the vault page.
2. A fired vault's deposits depend on the fired curator (`deposit` :208, `reclaimBond` :384–401).
   - The v3 fix lets fired vaults skip the capacity check, but the `deficit` check still applies.
   - Only `reclaimBond` clears `deficit`, and only the curator can call it. A curator who walks away
     therefore leaves the vault closed to deposits forever.
   - `test_firedVaultDepositIgnoresCapacityFloor` passes only because `_firedAndReclaimed()` calls
     `reclaimBond` first.
   - After firing, `_reward` is skipped, so `deficit` is never recouped. The newcomer protection that the
     deficit check gives therefore protects no one in a fired vault.

   To make it a 10: skip the deficit check when `fired`, or zero `deficit` at fire time. Then add a test
   that a deposit into a fired, parked, unreclaimed vault succeeds.
3. The docs contradict the code on the fee cap (README.md:30, :181–182; HurdleVault.sol:537). The README
   says the credit is capped "over at most one epoch (a late settlement does not widen it)" and
   "≤ 3.4 bp … however late the settlement". The code computes `maxFees` with the real `elapsed`
   (:547), and the v3 changelog says the one-epoch clamp was reverted. A judge who checks the security
   claims against the code finds this mismatch. To make it a 10: restate the cap as growing with elapsed
   time and give the worst case for a delayed settle. Better, do Luna's item: tie the cap to realized
   pool fees, or enforce a maximum settle interval, which the paid keeper already makes cheap.
4. There is still no demo video (IDEA.md:65, :74 "video in progress"; changelog "Not done"). This is the
   third round running. The live demo now has a real fire, a refill and reopened deposits, which would make
   a 2-minute clip. To make it a 10: record it after item 1 is fixed, so the clip does not show a "parked"
   vault that is 95% WETH, and link it in the first lines of the README.
5. The live curator story shows no skill (Chaser page; Patient page).
   - Chaser is labelled "re-centers often" but has been "Out of range, not earning" (ticks 196050–196450
     vs spot 196749) for about 22 hours, with $0 carry. No curator bot runs it.
   - Patient's positive epochs (+0.1 to +3 bp) all went to recouping the deficit. Carry paid on chain is $0
     for every v4 vault.

   A judge sees bonds paying out but never a curator beating par and getting paid, which is half of the
   pitch. To make it a 10: run the `/integrate` curator bot on Chaser so it re-centers live, and let one
   vault visibly earn carry, with a `SettlerPaid` bounty, before judging.

## Strengths (max 5 lines)
- The mechanism is original and on theme: portable alpha for LP curators, with par in closed form from the pool's own fee growth and TWAP, no oracle, and a 0.001 bp match on real swaps.
- The v2 liveness items are really closed. `postBond` pays down the deficit (tested exactly, including over-payment), and the Patient and Chaser deficits are 0 on chain. A fork deposit into Chaser succeeds.
- The v4 fire is real and well told: Reckless was fired in the same transaction as the miss (`Settled`/`Fired`/`Rebalanced`, block 68513152), rehearsed on a fork first and visible in the app.
- The depth is serious: block-open fee growth and tick, a donate block, three-way price gates, 4·dev ≤ bond, crystallize on exit, a settler bounty, invariants and two audit regression suites.
- The full dApp works: explorer, per-vault charts in USD/mWETH, decoded reverts, honest status notes, `/integrate`, and a 24/7 indexer and keeper.

## Nits (optional, do not affect score)
- HurdleVault.sol:124: the `DepositWindowClosed` NatSpec still says "only in the block the vault settled". It is now a 5-minute window.
- The vault activity feed shows "Deposit … 2 shares". Shares are 1e18-scaled value units, so label them or show the value.
- The worker restarted during review twice in two rounds (uptime 123 s). Freeze worker deploys near the deadline.
- Patient and Chaser are showing up as about 0.0–0.1 bp vs par each epoch on a pool whose only flow is the keeper's up/down swaps. Add some organic-looking swap flow, or say on the page that the flow is synthetic.
- `git status` shows three modified `broadcast/**/run-latest.json` files. Commit or ignore them.
