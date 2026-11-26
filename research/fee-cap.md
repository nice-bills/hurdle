# Fee-credit cap, calibrated to real flow

Problem (council v3 luna item 1): swaps across blocks raise pool fee growth, and par credits that growth to its
virtual full-range liquidity whether or not the vault earned it. An attacker who is the dominant LP recycles the
fees it pays. Par rises, the bond pays depositors. Par must stay a full-range benchmark, so the fix is a tighter
cap on the credit, not "only fees the vault earns".

## 1. Measurement (`python3 -I data/fee_credit_dist.py data/weeks/*.csv`)

Par's uncapped fee credit per hourly settlement, as an APR on the epoch's starting NAV (same walk as
`data/par_check.py`, spot prices).

| week | settlements | max | p99 | median |
|---|---|---|---|---|
| 2026-10-31 (replay, range) | 166 | 60.3% | 48.2% | 3.0% |
| 2026-11-07 (replay, down) | 166 | 34.4% | 29.9% | 2.4% |
| **both replay weeks** | 332 | **60.3%** | **40.4%** | **2.5%** |
| 2026-10-10 (extra) | 167 | 39.3% | 13.7% | 1.9% |
| 2026-10-17 (extra) | 166 | 15.4% | 11.7% | 1.9% |
| 2026-10-24 (extra, 138% vol) | 166 | 185.3% | 161.8% | 2.5% |
| all five weeks | 831 | 185.3% | 46.2% | 2.2% |

## 2. Choice: `MAX_FEE_APR_BPS = 8_000` (80% APR), no maximum settlement interval

- 80% is 2x the replay p99 (40.4%) and above the replay max (60.3%): it never binds on either replay, so par
  matches the exact offchain computation as before.
- Over all five weeks, 6 of 831 hourly settlements exceed it (max 185%), all in the volatile Oct 24 week. In those
  hours par is under-credited by the excess, which counts as curator outperformance: a vault that is exactly
  passive would show excess of at most (185% - 80%) / 8760 = 1.2 bp of NAV in the worst hour, and the curator
  takes `carryBps` (20%) of it, ~0.24 bp. Depositors are not hurt below par; they give up that sliver of carry.
- Why no max settlement interval: the cap is `APR x elapsed`, a rate. A late settle widens the allowed credit
  in proportion to the real time that passed, so the per-hour drain is the same whether settling every hour or
  every day (`test_attack_lateSettleDrainSameRatePerHour`). A clamp would not lower the rate, and the earlier
  one-epoch clamp handed real fees to the curator (`test_F_settleTiming`, still passing).
- A lower cap (e.g. 50%) would sit below the replay max (60%) and start clipping real hours; 80% is the tightest
  round value that keeps both replays unclipped with margin.

## 3. Attacker cost vs gain (dominant full-range LP, 3000 pips fee tier)

Bound: at 80% APR par gains at most 0.91 bp of NAV per hour (21.9 bp/day), versus 3.42 bp/hour (82 bp/day) at
the old 300%. A 10%-of-NAV bond: ~46 days to drain instead of ~12.

- Gain: up to the cap per hour, paid by the bond to depositors (so the attacker profits only as a depositor
  or by short-selling the curator's credibility). `test/FeeCapAttack.t.sol` (attacker holds 2000e18 of the pool's
  liquidity, vault NAV 10e18 idle so it earns none of the wash fees, 120 blocks of wash trading per epoch):
  uncapped credit would be 8.9e15 wei (8.9 bp), the bond actually pays 9.13e14 = exactly the cap (0.913 bp);
  a settle 3 epochs late pays exactly 3x (same hourly rate).
- Cost: the wash fee `f x volume`, of which the attacker gets back its own LP share `w` (dominant LP: w -> 1,
  cost -> 0 apart from gas). The attacker needs fees of `cap x NAV x L_pool / L_par` to saturate the cap;
  its net cost is the (1 - w) part, paid to the other LPs. For a non-dominant attacker the cost exceeds the gain
  once `(1 - w) x L_pool / L_par > 1`, i.e. in any pool deeper than the vault.
- Residual that remains by design: a dominant LP can still push par by 0.91 bp/hour. Bound, not eliminated.
  A larger bond floor (`minBondBps`) or keepers topping up the bond shrink its relevance.

## 4. Tests / checks

- `test/FeeCapAttack.t.sol`: two tests above.
- `test_passiveVaultSettlesAtPar` and `test_firedVaultTracksPar` still assert the same bounds, but their price
  swings were scaled down (about 4x) because the old swings produced a fee yield between 80% and 300% APR, above
  any realistic hour (the Oct 24 week peaks at 185%). Above the cap a passive vault correctly shows excess.
- `data/par_check.py` uses the new cap; both replays still keep depositors >= par at every settlement.

## 5. In-range vs idle vault (council v4 luna item 1)

Question: does the dominant-LP wash drain a vault that is in range? No. A vault in range earns its share of the
wash fees as a real LP, and its concentrated liquidity is `~1/(1 - 1.0001^-60)` = 168x its full-range equivalent at
+-120 ticks, so it earns 168x what par credits to the virtual full-range position. Par's credit is the vault's own
fee growth per unit of in-range liquidity times a smaller liquidity, so the vault is always above it.

`test_attack_inRangeVaultIsNotDrained` (same pool, attacker 2000e18 liquidity, 120 blocks of 5e18 wash swaps,
vault NAV 10e18, +-120 ticks):

| Vault | Real fee gain | Par fee credit | Bond paid |
|---|---|---|---|
| In range | +1.060e18 (10.6% of NAV) | 6.29e15 uncapped (0.063%), cap 9.13e14 | 0 |
| Idle / out of range | 0 | 8.91e15 uncapped, cap 9.13e14 (0.913 bp) | 9.13e14 (= the cap) |

Only an idle or out-of-range vault is exposed, bounded by the 80% APR cap (~0.91 bp/h). Curator's defence: stay in
range; the live curator bot re-centres. Residual: a vault idle for days (price left the range, curator offline)
bleeds at up to the cap until it re-centres or the bond fires.
