# Hurdle: independent security audit (read-only)

Date: 2026-11-17. Scope: `src/HurdleHook.sol`, `src/HurdleVault.sol` (and `IHurdleVault.sol`).

**Audited source: the uncommitted working tree.** It changed during the audit. Hashes:

| file | md5 |
|---|---|
| `src/HurdleHook.sol` | `ce0806b04a91c206cf87e1f8c79ae756` |
| `src/HurdleVault.sol` | `4f33835314e277a617bcd6606b815320` |
| `src/IHurdleVault.sol` | `e0a1dbc7c0d9c86bb58007c620260da5` |

Line numbers below refer to these versions. PoCs are in `test/audit/AuditPoC.t.sol`. Each test **passes while the bug is present**:

```sh
FOUNDRY_OUT=out-aud FOUNDRY_CACHE_PATH=cache-aud forge test --match-path 'test/audit/*' -vv
```

## Summary

| # | Sev | Title | PoC |
|---|---|---|---|
| F1 | High | Deposits are priced at TWAP and withdrawals paid in kind, so the vault trades at the stale TWAP for free | `test_F1_depositAtTwapWithdrawInKindArb` |
| F2 | High | A rebalance swap's price bound is relative to TWAP, not the real price. With a lagging TWAP, one epoch's loss exceeds the bond | `test_F2_laggedTwapRebalanceLossExceedsBondFloor` |
| F3 | High | Wash swaps inflate par (blocking `donate` does not close this): a large depositor drains the bond for profit | `test_F4_washSwapInflatesParDrainsBond` |
| F4 | Medium | A deposit is priced at par even when the bond cannot cover par − NAV, so the newcomer overpays | `test_F3_depositAtParOverpaysWhenBondShort` |
| F5 | Medium | A deposit made while the vault beats par pays the pending recoup and carry. Exiting just before a good settle dodges carry | analysis |
| F6 | Medium | Unvalidated, curator-chosen constructor parameters, and the oracle is whatever the pool's hook is | analysis |
| F7 | Medium (deployment) | The live Sepolia contracts predate every fix, and the deploy script now reverts | broadcast JSON + source |
| F8 | Low | TWAP is spot for the first ≥60 s after pool init; window shrinks on young pools | analysis |
| F9 | Low | Any revert on the fire path bricks `withdraw`, because withdraw calls `_maybeSettle` first | analysis |
| F10–F15 | Info | see below | — |

Fixed in the working tree (uncommitted), verified by reading the code:
- `beforeDonate` reverts (`HurdleHook.sol:139`). Residual: F3.
- `DEAD_SHARES` on the first deposit (`HurdleVault.sol:38`, `:124-128`). This closes the first-depositor inflation attack: an attacker loses about 1000× what the victim loses.
- Deposits are priced at `max(nav, par)` (`:132`). This closes "deposit just before a known-bad settle and collect bond top-ups". Residuals: F4, F5.
- `MAX_REBALANCES_PER_EPOCH * maxTickDeviation <= minBondBps` (`:36`, `:100`). Residual: F2.
- The ring has 60 s entry spacing (`HurdleHook.sol:30`, `:163`), so an attacker can no longer shrink the TWAP window to 32 blocks by spamming swaps. Residual: F8, F12.

---

## F1 (High): deposit at TWAP, withdraw in kind = a free market maker at the stale price

`HurdleVault.sol:118-132` values a deposit at the TWAP (`_value(amount0, amount1, sqrtP)`) and mints shares against `navAt(TWAP)`. `withdraw` (`:148-168`) pays out pro rata, in kind, with no price check. A deposit followed at once by a withdrawal therefore exchanges the depositor's tokens for the vault's other token **at exactly the TWAP price**. Algebraically, the rate is `p_twap`.

This needs no manipulation. Spot differs from a 30-minute TWAP after every real move. Whenever `|spot − TWAP| <= maxTickDeviation`, anyone can deposit the token that is cheap at spot and withdraw a basket, in a loop, in one transaction. The README's claim that TWAP valuation "errs against the curator, never depositors" is false here: the loss lands on incumbent depositors. Later it shows up as a shortfall against par, so the bond pays it.

PoC: honest move of −45 ticks (`maxTickDeviation` = 50), then 12 s pass (TWAP ≈ 0). Fifteen deposit/withdraw loops follow.
- Arbitrageur profit: 0.1308e18.
- Vault loss: 0.1306e18 out of a 59.9e18 NAV (22 bp).
- This repeats on every lag episode in either direction. The size is about `deviation × the vault's other-token share × NAV`.
- Spot can also be pushed into the band in the same block (TWAP ignores same-block moves), so the attack works on demand as long as pool fees for the push are below the edge.
- The PoC stops at the extraction. It does not run the settles that turn this into bond drain and a fire; that chain is analysis.

Fix (smallest first):
- Require in-kind deposits in the vault's current token ratio (`amount0 : amount1 = vault0 : vault1`, positions included). No price is needed and the attack is symmetric with withdrawals.
- Or value a deposit conservatively: each token at `min(spot, twap)`, NAV at `max(spot, twap)`.
- Or lock shares until the next settlement.

## F2 (High): a rebalance's price bound is TWAP ± maxDev, not the real price, so the bond cap does not hold

`_swapToRatio` limits the swap to `twap ± maxTickDeviation` (`HurdleVault.sol:414`). `_checkedTwapSqrtPrice` (`:195`) only requires that *spot* be inside that band. The constructor invariant `4 · maxDev <= minBondBps` (`:100`) assumes each rebalance loses at most about maxDev bps. That holds only when the real price ≈ TWAP.

When the market moves and TWAP lags, an attacker pushes spot back into the band and makes the vault trade inside it, at up to `lag + maxDev` away from the real price. The attacker then swaps back.

PoC, curator variant:
- Token0 rallies 800 ticks and 12 s pass. The curator pushes spot to `twap+45` three times. Each time it calls `rebalance(c-6000, c-3000)`, which forces the vault to sell token0, then swaps back to fair.
- The vault loses 403 bp of NAV in one epoch, against a 200 bp floor and a 250 bp bond.
- At settle, the whole bond (0.5e18) is paid out and 0.34e18 of shortfall is left unpaid.

Sensitivity (same setup):

| TWAP lag (ticks) | vault loss (bp of NAV) |
|---|---|
| 200 | 113 |
| 300 | 162 |
| 400 | 211 |
| 600 | 307 |
| 800 | 403 |

That is about 0.5 bp per tick of lag. Loss crosses the 2% floor at roughly a 3.9% move inside the TWAP window. Such a move happens on volatile days.

Who profits:
- In this deep pool (2000e18 background liquidity) the curator-attacker's P&L is +0.31e18, which is less than the 0.5e18 bond it forfeits. So the proven harm is **depositors ending below par with the bond gone**, not curator profit.
- In a thinner pool, less of the loss leaks to background LPs as fees, and the curator can come out ahead.
- Third-party variant, not demonstrated: the fire-time `_redeploy` inside the permissionless `settle` (`:256`) swaps the whole vault to 50/50 under the same bound. So does the permissionless post-fire `rebalance` whenever idle funds exceed 2% (`:189`; bond payouts refill idle every epoch). An outsider gains only when the vault holds the token that has appreciated against TWAP. Whether a fired vault ends up lopsided that way depends on the trend.

Fix:
- Bound the swap against a second reference as well, e.g. `limit = clamp(spot_at_entry ± maxDev) ∩ (twap ± maxDev)`.
- Refuse to rebalance or park while `|spot − twap|` is large in *either* direction. This means reverting rather than trading inside the band when the TWAP lags, i.e. requiring that TWAP has converged, such as a short TWAP within maxDev of the long one.
- Simplest: skip swaps during the firing settle and leave parking to a later call that requires short-TWAP ≈ long-TWAP.

## F3 (High): wash swaps inflate par; `beforeDonate` only closed one path

Par credits the vault's *virtual* full-range liquidity `L_b = nav/(2·s0)` (`HurdleVault.sol:319`) with `dfg = fees / activeLiquidity`. `L_b` is not part of `activeLiquidity`. Swaps raise `feeGrowthGlobal` just as `donate` did.

Suppose the vault is idle or out of range, so its real in-range liquidity is below `L_b`. A depositor whose share of `L_b` exceeds the *other* active liquidity then gains more from inflated par (paid from the bond) than they pay in fees:
- gain ≈ `fees · L_b_attacker / L_active`
- cost = `fees · L_other / L_active`

The gain/cost ratio is `L_b_attacker / L_other`. It does not depend on JIT size. Fees the attacker earns as an LP only improve it.

PoC: pool with 10e18 full-range liquidity at a 1% fee. Bond 2e18; Alice deposits 10e18 and the attacker 80e18 (capacity allows it). After one epoch, in one block, the attacker runs 25 round-trip swaps back to the starting price, then calls `settle` and `withdraw`.
- The bond is drained completely (2e18 paid out) and the curator is fired.
- Attacker P&L is +0.86e18. This counts the attacker paying every swap fee and recovering none, even though it is also the background LP.
- TWAP is untouched, because everything happens in one block.

Real pools: the vault only needs to be large relative to the liquidity active at the ticks being traded. An attacker can also briefly push price into a thin region, wash-trade there (`feeGrowthGlobal` is global), and come back.

Fix:
- Count the vault's own position in the benchmark: `par_fees = min(L_b, L_vault_inrange_avg) · dfg`. This is not trivial.
- More robustly, cap the per-epoch fee credit at `L_b · dfg · L_active / (L_active + L_b)`, i.e. what a real full-range LP of size `L_b` would actually have earned.
- Cheapest: cap the per-epoch shortfall paid from fee growth to a TWAP-consistent fee APR, and require that the depositor who triggers settle has held for more than one epoch.

## F4 (Medium): par-priced deposit overpays when the bond cannot cover the gap

`shares = value · supply / max(nav, par)` (`:132`) prices a newcomer as if the vault were worth par. That is correct only when the bond can pay `par − nav`.

When the shortfall exceeds `bondValue()`, the newcomer pays for a guarantee that does not exist, and the surplus goes to incumbents. Deposits are still allowed in this case, because the capacity check (`:135`) only compares the bond with NAV.

PoC: the vault trails par by about 4% with a 2.5% bond. Bob deposits 2.083e18 and receives 2.052e18 after the next settle, a 149 bp loss.

Fix: price at `nav + min(owedShortfall, bondValue)` instead of `max(nav, par)`, where `owedShortfall` is the non-bond-share part of `par − nav`.

## F5 (Medium): carry and recoup timing games

- **Deposit while ahead of par.** The share price is `nav`, but at settle the whole `nav − par` excess accrued *before* the deposit is charged:
  - first 100% as recoup into `bondShares` (up to `deficit`), then `carryBps` as carry (`_reward`, `:264`);
  - both are minted pro rata, so they dilute the newcomer by `V/(N+V) · take`.

  After a bad epoch (with `deficit > 0`), a newcomer can lose up to their pro-rata share of the entire excess.
- **Exit before a good settle.** A depositor who withdraws one block before a settle that beats par keeps the excess and pays no carry. They can redeposit after the settle. Combined with the par guarantee, depositors hold a free option: stay through bad epochs and leave before good ones.

Fix: track the excess accrued so far, `max(nav − par, 0)`. Price deposits at `nav − pendingTake`, and charge carry and recoup pro rata on withdrawal, i.e. a crystallised performance fee per share.

## F6 (Medium): curator-controlled parameters void the guarantee

The constructor (`:91-111`) checks only `maxTickDeviation`.
- `carryBps > 10_000` makes carry exceed the excess. The curator then mints shares worth more than the outperformance, pushing depositors below par on every winning epoch.
- `epochSeconds` can be 0.
- `minBondBps` is arbitrary.
- `oracle = _key.hooks` (`:103`): any pool and any hook are accepted. A curator can deploy a vault on a pool whose "hook" returns any `twapTick`, and that tick drives NAV, par and deposit pricing.

There is no factory or registry, so a depositor must audit each vault's arguments.

Fix: `require(carryBps <= 5000 && epochSeconds >= 1 hours && minBondBps >= X)`. Deploy vaults through a factory that pins the canonical hook.

## F7 (Medium, deployment): the live contracts are the unfixed version

`broadcast/DeployHurdleHook.s.sol/1301/run-latest.json` lists hook `0xd0d7…4dA80` and vaults `0x72E6…16ca` and `0x8e76…603C`, the addresses in the README. The hook address's low byte is `0x80`, so the `BEFORE_DONATE` bit (0x20) is not set. On the live pool `donate()` is open, and the original par-inflation attack works with zero swap cost.

The live vaults also predate dead shares, par-priced deposits and the rebalance cap. They were deployed with `maxTickDeviation = 300`.

The deploy script still passes `(2000, 200, 300, 3600)` (`script/DeployHurdleHook.s.sol:111`), which now fails the new `require(4·maxDev <= minBond)` with "DEV". Redeploy is blocked until the script is updated. Testnet mock tokens only, but the README points users at these addresses.

## F8 (Low): TWAP falls back to spot on young pools

`_twapTickOrSpot` returns spot while `cardinality < 2` (`HurdleHook.sol:296`). With the new 60 s spacing (`:163`), swaps in the first 60 s after `initialize` update the accumulator but write no second ring entry. For at least 60 s after pool init (longer if nobody swaps), `twapTick` therefore equals spot, and the window afterwards is `now − init`, not 30 minutes.

A vault on a fresh pool is fully exposed to same-block manipulation. Fix: revert in `twapTick` (and so in the vault) until `available >= TWAP_WINDOW`, or until a minimum such as 10 minutes.

## F9 (Low): fire-path reverts lock withdrawals

`withdraw`, `deposit` and `rebalance` all call `_maybeSettle` (`:150`, `:119`, `:193`). After an epoch ends, `_settle` may fire and then `_redeploy`, which does a swap and an add-liquidity. Any revert there blocks every exit until conditions change. Examples: `getSqrtPriceAtTick(twap ± maxDev)` beyond ±887272 near the extreme ticks (`:414`), or liquidity-per-tick overflow on a huge vault.

Fix: run the park in a `try this.park()` external self-call or in a separate call, and never make `withdraw` depend on it. An in-kind withdrawal needs no settlement price.

## Info

- **F10, `snapshot()` (`HurdleHook.sol:315-336`).** Permissionless, unbounded `push`, and nothing in the vault reads it. Anyone can make epoch ids meaningless. Delete it or make it view-only.
- **F11, curator's own shares are guaranteed by the curator's own bond.** `_payShortfall` (`:279`) pays shortfall to *all* non-bond shares, including `balanceOf[curator]` (carry shares or curator deposits). This consumes bond coverage meant for third parties and adds to `deficit`. Consider excluding curator-held shares from `owed`.
- **F12, ring interpolation is approximate.** The ring is spaced ≥60 s, so linear interpolation inside a gap (`:233-260`) spreads ticks that changed in the gap's first 60 s across the whole gap. The error is ≤ 60 s × Δtick over a 1800 s window (≤3.3% of the deviation in that gap). The "TWAP stays exact" comment (`:27-29`) overstates it.
- **F13, token assumptions.** `token0 = Currency.unwrap(...)` (`:110`): native-ETH pools (currency0 = 0) are unusable, because `balanceOf` on address 0 reverts. Fee-on-transfer and rebasing tokens break accounting, since a deposit credits `amount` rather than the amount received.
- **F14, composability.** Every vault operation calls `manager.unlock`. Calling the vault from inside another unlock reverts (`AlreadyUnlocked`).
- **F15, `beforeAddLiquidity` / `beforeRemoveLiquidity` are no-ops (`:380`+).** They cost every LP operation gas. Drop the flags unless they will be used.

## Coverage of the requested checks

| Area | Result |
|---|---|
| Inflation / first depositor | fixed (dead shares). Residual griefing costs the attacker about 1000× what the victim loses |
| Rounding direction | shares, payouts and liquidity floor in the vault's favour. OK |
| Deposit valuation vs navAt vs start.nav/bench scaling | `start.nav += value·start.nav/bench` is consistent. Pricing issues: F1, F4, F5 |
| Withdraw draining others | in-kind pro rata; `_idle1` excludes the bond. OK apart from F1 |
| Deposit before a known-good or known-bad settle | bad: fixed (par pricing), residual F4. Good: F5 |
| Carry dilution `newShares = take·T/(nav−take)` | correct, and the existing test asserts it |
| bond vs `_idle1` | no underflow path found; `getLiquidityForAmounts` floors so adds never touch bond tokens |
| `_payShortfall` k-burn math | re-derived: `k = owed·t²/((t−b)·nav + owed·t)` and `paid` are exact. OK |
| Curator recovering the bond | not directly. Indirectly via F2 (thin pools) and F11 |
| Deficit recoup | correct. Edge: when `take >= navNow`, `deficit` is reduced with nothing minted (`:269`); unreachable unless par = 0 |
| Benchmark formula / overflow | matches `benchmark-math.md`. `mulDiv` everywhere; no overflow at realistic sizes |
| TWAP vs spot inconsistencies | F1, F2. Position valued at TWAP but minted at spot: concavity makes NAV ≤ the holdings' TWAP value, which feeds F1 |
| Stale or short TWAP | F8. Ring spamming fixed by the 60 s spacing |
| Fee growth via donate | fixed in source, open on the live deployment (F7). Via swaps: F3 |
| JIT liquidity | dilutes the vault's fees and the per-L benchmark equally; no extra edge beyond F3 |
| `_swapToRatio` sandwich / price limit | F2. Direction and limit sign are correct |
| `unlockCallback` | only the manager can call it, and the manager only calls back the unlocker (the vault itself). Safe |
| ERC20 return values | `require(transfer…)`. A no-return token (USDT-style) would revert; no silent failure |
| Reentrancy | none with standard ERC20s. State is updated before the external transfers in `withdraw` |
| Hook `onlyPoolManager` | on the state-writing callbacks; the pure hooks need none |
| int56 accumulator | safe for about 1287 years at max tick. `uint32` timestamps wrap in 2106 |
| Ring indexing | `_observationAt` and `_latestRingTimestamp` are correct for cardinality < 32 and when full |
| Swap-bricking revert in the hook | none: `beforeSwap` only writes and cannot revert. `beforeDonate` reverts by design |
| Fire rule, forced by a third party | yes, via F3 (and F1 and F2 indirectly) |
| Fire rule, blocked by a third party | not found. A spot-deviation grief only delays the park, not the fire (`:256`) |
| Post-fire permissionless rebalance | `AlreadyParked` plus the 4-per-epoch cap limit it; residual covered in F2 |
