# opus — v6 (round v5, origin/master 882aa43)
Score: 8/10

Checked at 882aa43 (local master = origin/master). `forge test` (out-opus6/cache-opus6): 123 passed, 0 failed, 1 skipped.
Live reads 20:46–20:51 UTC 2026-11-26, plus an anvil fork of Unichain Sepolia (nothing sent live). UI looks and the video are not judged.

Live facts, verified:
- Scripted move: one swap at 19:42:58 UTC, block 68869750, tx `0x402b94…`, limit at tick −196800. Reckless was centred near −196250, so the move is about −555 ticks.
- Keeper holds the target: spot sat at exactly −196800 from 19:44 to 20:40, and is −196811 after the park (inside the 20-tick threshold). `/healthz` targetTick is −196800 and lagBlocks is 3.
- 20:41 settles (keeper):
  - Reckless missed by 144.92 mUSDC. It was `Fired` and parked full range in the same transaction, and `rebalance(0,0)` now reverts `AlreadyParked`.
  - Patient missed by 50.33 mUSDC and Chaser by 102.88 mUSDC. Both bonds paid.
- Auto-repay works: the curator bot repaid both deficits at about 20:50:41, and `deficit()` is 0 on both.
- Round-4 items:
  - 1 (app blocks the depositable vault): fixed. The gate mirrors the contract and `e2e_deposit_gate.mjs` pins it.
  - 4 (fee cap): fixed. `maxFeeAprBps = fee × 16`, with a ceiling.
  - 2 (curator story): partly fixed. See items 1–3.

## Why not 10 (blocking items, most important first)
1. `app/worker/src/curator.ts:139` (`rebalance(..., MAX_IDLE_BPS=200)`) with `RebalanceIncomplete` in `CURATOR_EXPECTED` — Chaser has been out of range since 19:42, and the bot cannot bring it back.
   - Live state: Chaser is at [−196450, −196050] with spot at −196811. It earned no fees for over an hour, and its NAV stayed flat at 5734.57 from 20:00 to 20:40.
   - Every curator run since the TWAP caught up simulates `RebalanceIncomplete`. I reproduced it live with `cast call --from curator rebalance(-197020,-196620,200)`, which reverted `0xf7e5da95`. It also reverts at caps of 250, 300 and 400, and passes at 500.
   - On the fork, the first re-centre step leaves about 262 mUSDC idle (4.5% of NAV). A second step at cap 200 then succeeds. So the bot's single, strict send can never finish an out-of-range re-centre.
   - The failure is invisible. `RebalanceIncomplete` is recorded as an expected skip, and skips are stored once per hour per action. The only row in the app is a `PriceDeviation` skip at 19:55.
   - This is the same failure as last round (Chaser out of range for 1 h 46 min), with a new cause. It is the "active management" half of the pitch failing live.
   - To make it a 10:
     - When the vault is out of range, send the first step with a looser cap (for example 1000), then in the same run send a redeploy at 200. That costs 2 of the 3 routine slots.
     - Store a skip row whenever the reason changes, not just once per hour.
     - Add a worker unit test for the out-of-range path.
2. Repay timing (`curator.ts` 600 s loop vs `HurdleVault.DEPOSIT_WINDOW` 300 s) — After a miss, the repay always lands after the deposit window closes.
   - The settle was at 20:41:06, the window closed at 20:46:06, and the repay came at 20:50:41.
   - So after any miss, Patient and Chaser refuse deposits (`DeficitOutstanding`) for that epoch's whole window.
   - Chaser will miss again at 21:41, because it is out of range while par earns the round-trip fees. Its next window will be closed too.
   - In practice, a judge can deposit into Patient or Chaser only after a beat, and Reckless is the only vault that is reliably open.
   - To make it a 10: repay right after the settle. Either the keeper settles and then kicks the curator, or the curator runs every 60 s during the first 5 minutes of each epoch. Even better, the curator settles its own vaults and repays in the same run.
3. Live payoff (README "Live flow is synthetic", lines 267–271) — No curator has ever earned carry on any deployment, and `SettlerPaid` has never been emitted.
   - The record:
     - v5 stopped at the 19:00 settle. Its total take was 0.008 and 0.105 mUSDC, all of it recoup, and carry was 0.
     - On v6 the move came 7 minutes after the vaults were created, so the whole v6 record is three misses.
   - The replays show carry (0.05–0.69%), but the live system has only ever shown the punishment side.
   - With Chaser stuck (item 1), carry cannot appear before judging either.
   - To make it a 10:
     - Fix item 1.
     - Let Patient and Chaser run in-range epochs until at least one settle shows take above the recoup, with carry minted and a keeper `SettlerPaid`.
     - Link that transaction in the README next to the v6 fire.
4. `README.md:98–160` — The README does not tell the v6 story and still leads with history.
   - The v6 section has addresses but none of the 19:42 move, the 20:41 fire or shortfalls, or the 20:50 auto-repay. It points to `v4-changelog.md` for v6.
   - The v5, v4, v3 and "superseded" sections (with addresses) take up most of the deployment part.
   - To make it a 10: write a five-line v6 narrative with transaction links (move `0x402b94…`, fire `0xdf4810…`, repay), and move the v3/v4 and superseded material into `research/deploy.md`.

## Strengths (max 5 lines)
- The mechanism is still original and on theme, with par in closed form from the pool's own fee growth and TWAP, and 123 tests including the audit regressions.
- The fire path is clean live. One settle transaction pays the shortfall, fires Reckless and parks it full range in one step (`AlreadyParked` right after). This works because of the pool depth added at deploy.
- The keeper as arbitrageur works: spot is pinned to the target, so the parks and round trips no longer create fake "market moves".
- The curator bot repays deficits by itself, and the dApp deposit gate now matches the contract exactly, with a pinned e2e check.
- The fee cap now scales with the fee tier as a per-vault immutable, with a hard ceiling, and it is documented.

## Nits (optional, do not affect score)
- The worker restarted at about 20:00 (uptime 2794 s at 20:46), mid-demo. Freeze worker deploys before judging.
- `app/worker` has no unit tests for `planRecenter`, `repayDeficit` or `idleBps`. Only `test/e2e.ts` exists.
- `deposit-rules.ts`: in the "due" state (epoch over, not yet settled) the app shows the vault as open, but `deposit()` settles first and may then revert `DeficitOutstanding` if that settle misses. Add a hint such as "settles first; may close if the curator missed".
- The changelog says "README live story" covers Sonnet's round-4 item 2, but the README has no v6 live numbers yet (see item 4).
