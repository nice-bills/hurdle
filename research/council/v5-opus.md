# opus — v5 (round v4, origin/master ec7eaf4)
Score: 7/10

Checked at ec7eaf4. `forge test` (out-opus5/cache-opus5): 122 passed, 0 failed, 1 skipped. Live reads 16:47–17:00 and 19:10 UTC
2026-11-26, plus an anvil fork of Unichain Sepolia (I sent nothing live).
- On the fork I warped to the next epoch, settled, and deposited from a fresh address:
  - Reckless (fired, parked, deficit 150 mUSDC) accepted the deposit.
  - Patient and Chaser reverted `DeficitOutstanding`.
- I then simulated an hour of keeper round trips at a flat price and settled again:
  - Patient −0.92 bp vs par.
  - Chaser +0.70 bp, all of it a recoup.
- The live 16:58 settle then matched the fork: Patient missed by 23.35 mUSDC and Chaser by 13.30 mUSDC.
- Re-checked at 19:10 UTC:
  - 17:59 settle: Patient −1.03 bp (bond paid 0.60 mUSDC), Chaser +0.11 bp.
  - 19:00 settle: Patient +0.01 bp, Chaser +0.07 bp.
  - Every take was a deficit recoup (≤ 0.06 mUSDC). No `SettlerPaid` yet.
  - After 19:00 the curator key posted bond, so the deficit is 0 on both and they take deposits again.
  - Worker uptime is now 8628 s.
- Worker `/healthz` is ok (lag 3). Uptime was 112 s at 16:49, so it had restarted once more during review.

v3 items: 1 (park) fixed live, 2 (fired deposits) fixed in the contract, 3 (fee-cap docs) fixed, 4 (video) still open, 5 (curator skill live) only half done.

## Why not 10 (blocking items, most important first)
1. `app/web/src/lib/deposit-status.ts:46–53` — The dApp blocks the only vault that takes deposits.
   - The fired branch still applies the deficit gate. Its comment says "mirrors the deployed v4 bytecode … drop
     this branch when the next deployment ships". v5 shipped that change and the branch was never dropped.
   - Live Reckless v5 is fired, parked (`parked: true` in `/api/vaults`) and has `deficit` 150 mUSDC. The page
     says "deposits are closed (DeficitOutstanding) … reopen once the curator calls reclaimBond", and the Deposit
     button is disabled (`actions.tsx` `blocking`).
   - The contract accepts that deposit: I ran it on the fork.
   - In the 16:58 window Patient and Chaser were also blocked (a real `DeficitOutstanding`, item 2), so a judge
     could deposit into no v5 vault from the app. Any later miss brings that back.
   - The changelog says "app's parked check mirrors the contract", but the deficit gate does not.
   - To make it a 10:
     - Delete the fired-vault deficit branch.
     - Measure the non-fired gate against depositor shares, as the contract does: `deficit·supply > nav·(supply − bondShares − bal[curator])·1bp`.
     - Add an e2e check that the deposit button is enabled on a fired, parked vault inside the window.
2. Live curator story (`app/worker/src/curator.ts`, `keeper.ts:196`, `:250`) — Since 17:59 Patient and Chaser hold par, but the
   pitch's payoff is still not shown live, and the vaults stay open to deposits only through hand top-ups.
   - The live record so far:
     - v5: 4 settlements each. The two misses (50/40, then 23/13 mUSDC) were followed by +0.01 to +0.11 bp, and
       Patient also missed by 1.03 bp at 17:59.
     - Every take so far is a recoup. Carry paid is $0, and there has been no `SettlerPaid` on any deployment.
     - The deficit was cleared by a curator `postBond` sent by hand, not by beating par.
   - The 16:58 miss was caused by the demo itself:
     - Reckless's ~28 park steps (15:58–16:26) sold WETH into the pool and walked spot −130 ticks
       (−196800 → −196930).
     - Nothing brings the price back: the keeper's round trip returns to the price at the start of each trip,
       not to a reference.
     - So the park became a 1.3% "market move" that the concentrated vaults lost 40/23 bp on.
   - The curator bot cannot fix this:
     - It only re-centres. Chaser stayed out of range for 1 h 46 min after the move: PriceDeviation, then
       RebalanceIncomplete, then OutOfGas (tx `0x2acc6d…`; the bot sends the simulated gas with no headroom).
     - It never redeploys idle funds. Patient has ~5% of NAV idle (0.098 mWETH + ~50 mUSDC), which is why it trails
       Chaser (−0.92 bp in a flat hour on the fork).
     - It never posts bond. Each miss closes deposits (`DeficitOutstanding`) until someone tops up by hand.
   - To make it a 10:
     - Have the keeper act as the arbitrageur: return spot to a target price after scripted moves and parks.
     - Add a gas buffer to the bot's sends, and redeploy idle funds above 2%.
     - Have the bot `postBond(deficit)` after a miss.
     - Before judging, let one vault build a run of beats past the recoup, so the app shows real carry and a keeper
       `SettlerPaid`. On +0.1 bp/h of round-trip flow that takes a long time, so either add more flow or say on the
       page that the flow is synthetic and the carry is expected to be tiny.
3. Demo video (IDEA.md:65, :74) — There is still no demo video, the fourth round running. It is deliberately scheduled
   after the UI redesign, but it is one of the judged items. To make it a 10: once items 1–2 are fixed, record the
   fire/park/refill cycle and one carry-earning epoch, and link it in the first lines of the README.
4. `src/HurdleVault.sol:53` — The fee cap is fixed for every pool, but it was calibrated on one pair.
   - `MAX_FEE_APR_BPS = 8_000` is a constant, set from the ETH/USDC 0.05% replays.
   - The factory accepts any canonical-hook pool. On 0.3% or 1% tiers, or on volatile pairs, real fee APR above
     80% is routine. Par is then under-credited every hour, and the curator collects carry on fees it did not beat.
   - To make it a 10: make the cap a per-vault immutable that the factory sets within bounds, or derive it from
     `key.fee`. Document how to pick it.

## Strengths (max 5 lines)
- The mechanism is original and on theme: portable alpha for LP curators, with par in closed form from the pool's own fee growth and TWAP, no oracle, and a 0.001 bp match on real swaps.
- The park is really fixed live. Reckless v5 is fired, full range, with 0.4 mUSDC idle. The keeper stepped it until `AlreadyParked`, and the contract and worker agree on what "parked" means.
- The audit-3 accounting is careful: the deficit is owed by depositor shares only, the recoup is grossed up, the implicit settle pays the bounty, and fired-but-unparked vaults refuse deposits. All of it has regression tests, invariants and a noise-neutrality fuzz.
- The fee cap is now argued with data (fee-cap.md): it never binds on the replays, gives a bounded drain per hour, and an in-range vault beats the wash 168x. The docs now match the code.
- The live fire is real and well told: one scripted −593-tick move, Reckless fired in the settle transaction and parked, Patient and Chaser paid out and were refilled by hand.

## Nits (optional, do not affect score)
- `app/shared` vault ABI is stale: `settleForWithdraw()` has no args, but v5 has `settleForWithdraw(address)`. Regenerate it from `out/`.
- `pool_ticks` has no pool column. `/api/pool` history mixes v4 ticks (+196727) with v5 ticks (−196930), so the
  Swap page's price-chart baseline is the v4 tick and the chart is garbage until the v4 rows age out. Key the table by pool id.
- `test/V4Features.t.sol:128` sets `deficit` with `vm.store(slot 5)`. Reach the fired, parked, unreclaimed state through
  real calls instead, as Reckless did live.
- Keeper gas: 0.0021 ETH at about 1.9e-5 ETH/h lasts about 4–5 days. Top it up before judging.
- The worker restarted during review again (uptime 112 s). Freeze worker deploys near the deadline.
