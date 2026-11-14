# Phase 2: real v4 accounting harness

Ran with the isolated build/cache directories required for this phase:

```sh
FOUNDRY_OUT=out-p2 FOUNDRY_CACHE_PATH=cache-p2 forge test --match-path test/Benchmark.t.sol -vv
```

Result: 4 tests passed, including 257 fuzz cases with swap counts bounded to 200–300. Each run initializes a 1:1, 3000-fee pool with an address(0) hook, mints a full usable-range position at liquidity `1e18`, snapshots `sqrtPriceX96` and both global fee-growth accumulators, performs seeded swaps in both directions (exact input and exact output), then removes the position and compares its actual returned amounts with the closed-form benchmark.

## Result

The maximum relative error in an eight-seed, 240-swap measurement sweep was `2,495,368,819 / 1e27`, or about `2.50e-18` of initial capital. All measured and fuzzed cases stayed below the required 1 bp tolerance. The representative 240-swap run ended at a token1/token0 price of about `1.493205`, a roughly 49% move from the initial price of 1. The measured seeds also ended between about `0.904966` and `1.426875`.

The maximum absolute discrepancy in the deterministic sweep is about 5 token1 wei against roughly `2e18` token1 wei of capital. This is consistent with integer rounding across v4's Q128 fee-growth accumulation, liquidity accounting, and the harness's Q64 valuation; no tolerance was relaxed.

The plain one-swap gas baseline was `487,300` gas for the `swap` helper call in this test fixture. This is a harness baseline for the core manager/router setup, not an incremental hook overhead measurement.

## Scope and caveats

- This confirms the formula against a finite full-range position between `TickMath.minUsableTick(60)` and `TickMath.maxUsableTick(60)`. The tested paths remain inside that range; it does not establish the result for swaps that move beyond the position's initialized bounds.
- The check uses actual ERC20 balance changes on position mint and removal, so the ground truth includes v4 fee realization and rounding at withdrawal.
- Both the formula and truth are valued at the final spot price. This validates the accounting identity, not the suitability or manipulation resistance of spot price as a settlement price.
- The maximum error is an observed maximum from the eight deterministic measurement seeds, not a mathematical upper bound. Fuzz cases enforce the 1 bp ceiling individually.
