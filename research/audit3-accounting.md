# Audit 3: share, bond, deficit and carry accounting

Independent, read-only pass over `src/HurdleVault.sol` (fee-cap constant `MAX_FEE_APR_BPS = 8_000` at the time of reading,
not reviewed). Line numbers refer to that version. Prior findings in `audit-independent.md`, `audit2.md` and
`audit-fixes.md` are not repeated.

PoCs: `test/audit/AcctPoC.t.sol` (uncommitted). Run with
`FOUNDRY_OUT=out-acct FOUNDRY_CACHE_PATH=cache-acct forge test --match-contract AcctPoC -vv`. All 3 pass against the
current code, which means each bug is present.

Fix check: both fixes below were applied to a scratch copy of the repo (not this tree). With them, the 3 PoCs fail as
expected and all 99 existing tests pass, including the invariant suite. `Replay.t.sol` was not run.

## Summary

| # | Severity | Title |
|---|---|---|
| A | Medium | `deficit` is charged to every share but was paid only to depositor shares, so noise around par moves curator value to depositors |
| B | Low | A fired vault whose fire-time park failed still takes in-kind deposits, with no bond behind them |
| I1–I6 | Info | Settler bounty as a curator alias, carry on bond shares, keeper bounty front-run, deficit left behind when depositors exit, reclaim mid-epoch, dead shares |

### Resolution

| # | Resolution |
|---|---|
| A | Fixed as specified: `_excluded()`, gross-up in `_reward`, depositor-only deficit in `crystallize`, `withdraw` (curator pays 0) and the deposit gate. Regression: `Audit3Regression`, `NoiseNeutrality`, invariants 1, 2, 10. |
| B | Fixed: `deposit` reverts `NotParked` when fired and not parked (`_parked()` shared with `reclaimBond` and the fired `rebalance`). Fired and parked vaults still skip the deficit and capacity gates. |
| I1 | Skipped: cannot be told apart from an honest keeper onchain; bounded at 5% of carry, same as the documented withdraw-and-redeposit route. Documented in README Limits. |
| I2 | Skipped: curator-to-curator transfer; excluding bond shares from the carry base changes the economics and the replay results. Documented. |
| I3 | Fixed: implicit epoch-end settles (`deposit`, `withdraw` via `settleForWithdraw(settler)`, `reclaimBond`) pay the bounty to the caller unless it is the curator. |
| I4 | Gone with A (deficit measured against depositor shares; the curator's exit leaves it untouched). The dead shares' slice (~1000 wei of shares) remains. |
| I5 | Skipped: small, and a fix needs pro-rata mid-epoch settlement (already a documented shortcut for withdrawals). |
| I6 | Skipped: negligible (1000 wei of shares); excluding the dead shares would add a term to every deficit formula and cost bytecode. |

## A (Medium): recoup charges the curator's own shares for a deficit they never received

**Where**
- `_payShortfall` `:490-524`: depositors receive `owed = shortfall·(t−x)/t`, where `x` is bond shares plus curator free
  shares. `deficit += paid`.
- `_reward` `:467-468`: `recoup = min(excess, deficit)` is minted to `bondShares` by diluting **all** shares.
- The same per-all-shares view is used in `crystallize` `:296` (`deficit·shares/t`), `withdraw` `:251` and the deposit
  gate `:213`.

**Mechanism.** A recoup of `R` dilutes depositors by only `R·(t−x)/t`. The curator's own shares pay the other
`R·x/t`, which goes to the curator's own bond. Yet `deficit` falls by the full `R`. After a miss and an equal beat:
- depositors have repaid `(t−x)/t` of what the bond paid them;
- `deficit` reads 0;
- the difference, `m·(t−x)·x/t²·(1−carry)`, is a permanent transfer from the curator to depositors.

This breaks the contract's own claim (`:29`) that "noise around par nets out instead of draining the bond".

**Scenario, with numbers (`test_A_noiseDoesNotNetOut_singleCycle`)**
- Setup: NAV 40e18, held half by Alice and half by the curator (an in-kind co-investment, or accumulated carry). Bond
  4e18, carry 20%. Par is set directly, with no swaps, so NAV is constant.
- Epoch 1 misses by `m = 1e18`: the bond pays Alice 0.5e18 and `deficit = 0.5e18`.
- Epoch 2 beats by `m`: recoup 0.5e18 and carry 0.1e18; `deficit` is back to 0.
- Net: Alice +0.2e18 (+1%), curator −0.2e18. Over both epochs the composite par equals NAV exactly, so the fair
  transfer is 0.

**Drift (`test_A_noiseDrainsCuratorOverEpochs`).** 60 such ±2.5% cycles: `deficit` is 0 after every cycle, and Alice
gains 10.7e18 (+53%), all paid by the curator. The loss lands on the curator's free shares first, then on the bond.
- Size in practice: about `x/t·(1−x/t)·(1−carry)` of every shortfall payment. For example, 3.8% at `x/t = 5%` and 16%
  at `x/t = 25%`.
- The replay's bond paid 2.6–10% of NAV per week, so at `x/t = 5%` this moves roughly 0.1–0.4% of NAV per week.
- A secondary effect: once every depositor has exited, `deficit·x/t` stays behind. It is never owed by anyone, yet it
  keeps the deposit gate shut until the curator pays it with `postBond` (see I4).

**Fix.** Treat `deficit` as owed by depositor shares only. Let `dep = totalSupply − bondShares − balanceOf[curator]`;
it is always greater than 0 because of the dead shares.
```solidity
function _excluded() private view returns (uint256) { return bondShares + balanceOf[curator]; }

// _reward: gross up so that depositors' dilution equals the deficit reduction
uint256 recoup;
uint256 d = deficit;
if (d > 0) {
    uint256 t = totalSupply;
    uint256 dep = t - _excluded();
    uint256 gross = FullMath.mulDivRoundingUp(d, t, dep);
    recoup = excess < gross ? excess : gross;
    deficit = recoup == gross ? 0 : d - FullMath.mulDiv(recoup, dep, t);
}

// crystallize: the curator's own carry and recoup are paid to itself
if (owner == curator) return 0;
uint256 owedDeficit = FullMath.mulDiv(deficit, shares, t - _excluded());

// withdraw (computed before crystallize moves shares)
uint256 owedDeficit = msg.sender == curator ? 0 : FullMath.mulDiv(deficitBefore, shares, totalSupply - _excluded());

// deposit gate: compare with the depositors' NAV
if (!fired && deficit * 10_000 * supply > navBefore * (supply - _excluded()) * DEFICIT_TOLERANCE_BPS) revert DeficitOutstanding();
```

**Result on the scratch copy**
- Single cycle: Alice +0, curator −2 wei.
- 60 cycles: Alice −0.73%. That is genuine carry, not a leak: with bond shares burned, the two epochs' composite par is
  `N − m²/N`, so the vault beat it by `m²/N` per cycle. 20% carry on that, times Alice's half, is 0.0025e18 per cycle,
  which matches the result.

## B (Low): deposits into a fired, unparked vault

**Where**
- `deposit` `:211-213` and `:231-232` skip the deficit gate and the capacity floor once `fired`, on the premise in the
  comment at `:231`: "A fired vault is parked passive (it is par), so it needs no bond".
- The park at firing is `try this.park() {} catch {}` (`:460`), so it can fail (F9). Nothing in `deposit` checks that
  the vault is parked.

**Scenario (`test_B_depositIntoFiredUnparkedVault`)**
1. The curator is fired and its park reverts. Bond value is now 0 bps of NAV, and the vault still holds the fired
   curator's 240-tick range.
2. In the same block (the window opens at the firing settle), Bob deposits in kind, doubling the vault. Every gate
   passes.
3. The price keeps trending and nobody parks. At the next settlement Bob's value is 20.69e18 against a par of 21.75e18
   (−4.9%), and the shortfall paid is 0.

**Fix.** In `deposit`, add `if (fired && !_parked()) revert NotParked();` and factor `_parked()` out of `reclaimBond`
(`tickLower/Upper == min/maxUsableTick && _idleBps()*50 <= 10_000`). An alternative is to `try this.park()` first.
Verified on the scratch copy. The existing fired-vault deposit tests still pass because their vaults are parked.

## Info

- **I1: the settler bounty gives a curator alias covered shares.** The `_reward` bounty `:476-480` is not paid when
  `settler == curator`. A curator that settles from another address gets 5% of its carry as ordinary covered shares,
  with no deposit window, capacity or deficit check. This is the same effect as the documented F11 residual
  (withdraw-and-redeposit), by a cheaper path, and bounded at 5% of carry.
- **I2: carry is charged on the bond shares' own excess.**
  - Carry is computed on the whole excess, and bond shares are diluted by carry minted to the curator's free balance.
  - Each beat therefore moves `carry·excess·b/t` from locked collateral to withdrawable curator shares.
  - This is curator-to-curator, but it lowers collateral and raises the chance of `BondBelowFloor` or firing.
  - Fix, if unwanted: exclude bond shares from the carry base, `carry = (excess − recoup)·(t−b)/t·carryBps`.
- **I3: the keeper bounty can be front-run.**
  - Any `withdraw(1)`, `deposit` or curator `rebalance` after the epoch end settles through `_maybeSettle` with
    `settler = 0` (`:410`), so no bounty is paid.
  - The keeper's `settle()` then reverts `EpochNotOver`. The curator keeps the 5%.
  - If keepers matter, pay the bounty to `msg.sender` on any implicit epoch-end settle when the caller is not the
    curator.
- **I4: deficit is left behind when depositors exit.** Under the current per-all-shares model, `x/t` of the deficit
  stays after every depositor leaves. Fix A removes this.
- **I5: reclaim leaves the current epoch uncovered.** `reclaimBond` only settles a finished epoch. Mid-epoch, the
  parked vault keeps up to 2% idle, which can drift from par, and after the reclaim no bond covers that partial epoch.
  The amount is small.
- **I6: dead shares are covered by the bond.** `balanceOf[address(0)]` counts as a depositor in `_payShortfall`. The
  bond pays the dead shares' part of a miss (1000 wei of shares), and that value is stuck forever. Negligible. It also
  means `paid > 0` is still possible when no real depositors remain, so a miss can still fire a curator whose bond is
  under half the floor.

## Checked and found sound

- Share supply: `Σ balanceOf + bondShares == totalSupply` on every path (first deposit, deposit, withdraw and
  crystallize, `_reward`, `_payShortfall` burns and curator lock, reclaim).
- `_payShortfall`, re-derived:
  - `k = owed·t²/((t−x)·nav + owed·t)`;
  - the `paid` formula;
  - the gross-up `rest·t2/(t2−x2)` (the denominator is `t−x` and never 0);
  - `keep = c·nav·t2/(t·(nav+tokens))`.
  Bond value falls by exactly `paid`, and the curator's free value is unchanged.
- `_reward`: `newShares = take·t/(nav−take)` dilutes each share by its own pro-rata excess. The bounty comes from carry
  shares only. Rounding favours depositors over the curator.
- Crystallize then burn: the burn scales `start.nav` by `(t−burn)/t`. The paid shares keep their excess, but it is
  re-charged only to their new owner (curator or bond), so depositors are not charged twice. A curator withdrawing
  pays itself (no-op).
- Self-call gas grief on `crystallize` or `settleForWithdraw`: keeping the ~150k+ gas the rest of the payout needs
  means the self-call itself gets at least ~9M gas, so it cannot be starved.
- In-kind deposit rounding:
  - each token rounds up and liquidity rounds up, so the depositor always overpays by at most 1 wei per token plus
    one unit of liquidity;
  - the add is paid by the depositor;
  - fees are realized first, in the same transaction.
- `_idle1` cannot underflow: `_swapToRatio` spends at most `a1`, and `getLiquidityForAmounts` floors.
- First deposit and inflation: the first deposit is curator-only and every later deposit is in kind and pro rata, so
  a donation cannot move what a newcomer pays per share.
- Re-baseline optionality, for the curator or anyone, within `DEPOSIT_WINDOW`:
  - Locking carry at a peak is undone by the bond paying the reversal and recouping it later, which is equivalent to a
    high-water mark (net of A).
  - A depositor-triggered re-baseline that books a miss over 1 bp reverts through the deficit gate, which bounds it.
- Rounding drift: `start.nav` floors and the `owedDeficit` floor are ≤1 wei per operation and do not compound.

## Invariants to add to `test/invariant/`

1. **Depositors repay exactly what they received.** Track `ghostPaidToDepositors` (sum of `Settled.shortfallPaid`),
   `ghostRecoupedFromDepositors` (depositor dilution from `toBond` mints and crystallize recoups), the forgiven amount
   (the `owedDeficit` of each withdrawal behind par) and `ghostPostBondPaydown`. Then:
   `deficit == paid − recouped − forgiven − paydown ± dust`. This fails today (finding A).
2. **Noise neutrality.** A miss of `m` followed by a beat of `m` on a constant NAV (the `vm.store` harness in the PoC,
   fuzzing `m` and the curator's share) changes the depositor's value by at most rounding. Fails today.
3. **Value conservation per action.** With no external flow (settle, crystallize, park without a swap), the sum over
   holders of `shares·nav/t`, plus bond tokens, stays equal to `nav + bond`; `settle` keeps it within 1 wei per holder.
4. **Bond accounting.** `token1.balanceOf(vault) >= bond` always.
5. **Dead shares.** `balanceOf[address(0)] == 1000` and `totalSupply >= 1000` after the first deposit.
6. **Shortfall effect.** On every shortfall settle, `bondValue` falls by `paid` (relative 1e-12), and
   `balanceOf[curator]·nav/t` is unchanged.
7. **Carry gate.** On every settle with `nav >= bench`, no shortfall is paid. Minted shares equal
   `take·t/(nav−take)`, and the bounty is at most 5% of the carry shares.
8. **Fired deposits.** Every successful deposit into a fired vault happens while the vault is parked (finding B).
9. **Withdraw split.** In `crystallize` plus `withdraw`: `burn + paidShares == shares`, and the curator's gain plus the
   bond's gain equals `paidShares`.
10. **Par per share.** Deposit and withdraw keep `start.nav/totalSupply` (relative 1e-15) and
    `deficit/(t−x)` unchanged after fix A.
11. **Handler gaps.**
    - `sumShares` only covers fixed actors. Add every address that ever receives a `SettlerPaid` bounty.
    - Add a curator in-kind `deposit` and a curator `withdraw` action, so that `x/t` reaches levels where A shows.
