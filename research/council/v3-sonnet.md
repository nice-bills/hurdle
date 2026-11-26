# sonnet — v3
Score: 9/10

Checked at 9028807. `forge test` (own out dir): 95 pass, 0 fail, 1 skipped. Live: dApp 200, worker `/healthz` ok (lag 3 blocks, keeper settled Reckless at 14:51 UTC). `e2e_app_smoke.mjs` against the live dApp: "all 16 page views clean". I loaded home, vault, create and swap with a true 390 px mobile emulation: `scrollWidth` 390 on every page, stat cards wrap, nothing clips. Deposit check: I forked Unichain Sepolia locally with anvil, minted mock tokens to a throwaway address and called `deposit` on Patient and Chaser during the open window. Both succeed. Nothing was sent to the live chain.

## v2 items
1. No depositable vault: fixed. `deficit()` is 0 on Patient and Chaser, and the fork deposit succeeds. The fired Reckless showcase is kept.
2. Deficit gate traps a vault: fixed. `postBond` pays the deficit down first (`src/HurdleVault.sol:313-324`) with three tests, and the README says so.
3. Demo video: NOT fixed. No link anywhere; README and IDEA.md still say "in progress".
4. mWETH-versus-USD chart units: fixed. The vault page has a USD/mWETH toggle, USD by default, and the axis is labelled "vs par, USD (points of starting capital)".
5. Repo hygiene: partly fixed. The README now says 95 tests (matches). `git status` still shows modified `broadcast/**/run-latest.json` files and, at review time, uncommitted edits to `src/HurdleVault.sol`, `README.md` and `app/worker/*`.
6. Keeper noise: no red lines on the vault page I loaded. The worker still restarts (`uptimeSeconds` 32 at 14:40, 134 at 14:53), so uptime is not continuous.
7. Nit, fired vault refuses deposits: fixed (capacity check skipped), but see item 2 below.

## Why not 10 (blocking items, most important first)
1. README / IDEA.md / submission — still no demo video or recording link (changelog "Not done"). Judges rate the demo, and the story (scripted move, Reckless fired, keeper settles, then a deposit into a healthy vault) is best seen as a 2-3 minute clip. Make it 10: record it and put the link in the first five lines of the README.
2. Live Reckless page, "Deposits reopen once the curator calls reclaimBond" — the vault was fired 11-22 16:39 UTC and more than an epoch has passed, but `reclaimBond()` has not been called, so the showcase vault's deposit tab shows `DeficitOutstanding` (0.05 mWETH, $143). It reads as a dead end, and the vault is still the only live evidence of the "parked passive" state. Make it 10: have the curator (`0xA9B4…689F`) call `reclaimBond()` before submission (it also tests the path on-chain), or soften the banner to say this is the expected end state of a fired vault.
3. Repo state at submission — the working tree has uncommitted changes in `src/HurdleVault.sol`, `test/V4Features.t.sol`, `README.md`, `app/worker/*` and the broadcast files, so HEAD may not be what is being judged or deployed. Make it 10: commit or discard them, ignore `broadcast/**/run-*.json`, and tag the final commit.

## Strengths (max 5 lines)
- Both v2 liveness blockers are really closed. Patient and Chaser are depositable now, and `postBond` clearing the deficit is the right design with direct tests.
- Original, oracle-free par from the pool's own fee growth and TWAP; the on-chain value matches the offchain reference to 0.001 bp.
- The live dApp is polished and honest. It has a USD/mWETH toggle, a clear "deposit window closed, next opens in 8m 54s" state, decoded reverts, a FIRED banner with the reason, and a mobile layout with no overflow.
- The README live story is specific (dates, block, amounts) and candid: the v3 depositors end 0.77% below par, and a fired Reckless is shown as designed.
- 95 tests plus invariants, both real-swap replays, and an e2e that includes a live dApp smoke.

## Nits (optional, do not affect score)
- README "Run" lists `./e2e.sh` twice (lines 159-160) with different descriptions.
- With the deposit window closed, the page does not offer a "remind me" or a countdown on the Vaults list. The vault page does have one.
- The worker free-tier restarts leave the first request after idle slow (about 30 s for the smoke run); a note on the live page would pre-empt a "broken" impression.
