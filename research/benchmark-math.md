# Benchmark math (phase 1 spike, 2026-11-13)

## Result

The passive benchmark doesn't need a per-swap or per-block accumulator. For a full-range position of liquidity L, valued in token1 against holding its starting inventory:

    excess(t0 -> t1) = L * (dfg0 * P1 + dfg1)  -  L * (s1 - s0)^2 / s0

- `s = sqrtPrice` and `P = s^2`.
- `dfg0`, `dfg1` are the deltas of `feeGrowthGlobal0X128` / `feeGrowthGlobal1X128`, divided by 2^128: the fee per unit of liquidity that any in-range liquidity earned.
- The loss term depends only on the start and end price, so the price path in between doesn't matter.

The hook therefore stores one snapshot `(sqrtPriceX96, feeGrowthGlobal0, feeGrowthGlobal1)` at each epoch start. At settlement it reads the current values. The swap path pays no gas for this.

Benchmark return per unit capital is `excess / (2 * L * s0)`, where `2 L s0` is the full-range position's value at t0.

## Verification

`research/ref/benchmark.py` runs 2000 random paths of 200 swaps each and compares direct position accounting against the formula. Worst relative error: 4e-16. **VERIFIED (algebra).**

Not yet verified: that v4's real `feeGrowthGlobal` and `sqrtPriceX96` produce the same number. That is phase 2, a Foundry test that diffs the hook against this Python reference on replayed swaps.

## Consequences for the design

1. Phase 3 is simpler: there is no `afterSwap` accumulator. Swap gas overhead is close to 0, against a 40k budget.
2. **Settlement price is now the top risk.** `s1` is a spot price, so anyone can flash-manipulate it at the settlement call. Fix: the hook keeps a short TWAP (an observation written in `afterSwap`, about 5k gas), and settlement uses the TWAP for both the vault NAV and the benchmark.
3. **The benchmark choice is a product decision.** Full range is the honest "do nothing" option. A static ±X% range is also computable onchain via `getFeeGrowthInside(tickLower, tickUpper)`, provided those ticks are initialized. The hook can guarantee that by holding dust liquidity there. Bitquery shows ±10% left alone beat chasing in most pools, so curators could pick a harder benchmark for higher carry.
4. **Paper alignment:** arXiv 2609.37963's infinitesimal LP is a per-unit-liquidity, always-in-range construction. Fees per L are identical; our loss term is the closed-form full-range version. Cite it as inspiration, not an exact implementation.
