# Phase 2: real v4 accounting harness

`test/Benchmark.t.sol` adds a full-range, address-zero-hook integration harness. It initializes a 1:1 pool at fee 3000 / spacing 60, records the actual token deposits, snapshots `sqrtPriceX96` and global fee growth, runs seeded mixed exact-in/exact-out swaps, then removes the entire salted position and compares token1-valued realized accounting with the closed-form benchmark. The deterministic path uses 240 swaps; the fuzz path uses 200–300.

## Verification status

The requested Foundry command could not compile the project, so no accounting error or swap gas measurement is available yet. It failed twice, one minute apart, in the concurrently edited `src/HurdleHook.sol`: `manager` is undeclared at lines 121, 175, 278, and 279. This harness does not edit that file. Re-run after that concurrent edit is complete:

```sh
FOUNDRY_OUT=out-p2 FOUNDRY_CACHE_PATH=cache-p2 forge test --match-path test/Benchmark.t.sol -vv
```

Once it compiles, the test logs absolute token1-wei error, initial capital, and total gas for the swap loop. The assertion enforces a strict 1 bp bound; it has not been weakened. Finite full-range tick limits, per-swap fee-growth rounding, and token amount rounding remain empirical caveats until the run succeeds.
