# Phase 3 — TWAP observations + epoch snapshots

Date: 2026-11-14
Code: `src/HurdleHook.sol`, tests `test/HurdleHook.t.sol`
Build: `FOUNDRY_OUT=out-p3 FOUNDRY_CACHE_PATH=cache-p3 forge test -vv` (forge 1.5.1, solc 0.8.26, **optimizer off** as configured in `foundry.toml`)

## Why this phase

`research/benchmark-math.md` showed the passive benchmark needs no per-swap accumulator:

```
excess(t0 -> t1) = L * (dfg0 * P1 + dfg1) - L * (s1 - s0)^2 / s0
```

Two snapshots of `(sqrtPriceX96, feeGrowthGlobal0X128, feeGrowthGlobal1X128)` are enough, so swap gas
overhead is near zero. That made **settlement-price manipulation** the top risk: `s1` is a spot
price that anyone can move inside the settlement block. Phase 3 closes that hole with a
stripped-down Uniswap v3 oracle, and makes epoch snapshots permissionless and auditable.

## Design

### Time-weighted tick accumulator (per `PoolId`)

```solidity
struct Observation  { uint32 timestamp; int56 tickCumulative; }   // 88 bits, 1 slot
struct OracleState  { uint32 index; uint32 cardinality; uint32 lastTimestamp; int56 tickCumulative; } // 1 slot
mapping(PoolId => OracleState) private _oracle;
mapping(PoolId => Observation[32]) private _observations;
```

* `afterInitialize` seeds the first observation at the initialization tick. `cardinality = 1`.
* `beforeSwap` reads the **pre-swap** tick with `StateLibrary.getSlot0` (one `extsload`), and only if
  `block.timestamp` advanced does it:

  ```
  tickCumulative += int56(tick) * (now - lastTimestamp)
  write Observation(now, tickCumulative) at index; index++ (mod 32); lastTimestamp = now
  ```

  At most one observation per block; later swaps in the same block return immediately (the state
  slot is read, the tick is not, and nothing is written).
* No writes in add/remove liquidity: those do not change the tick.

**Why accumulation happens before the swap.** The tick that is added for the elapsed period is the
one that was *live during that period*. The tick produced by the current swap has, by construction,
zero elapsed time at the moment it is first observed. So:
* every swap later in the same block sees `timestamp <= lastTimestamp` and adds nothing;
* a huge swap in the settlement block cannot move the mean over any window that ends at that block,
  regardless of ordering;
* the manipulated tick can only enter the accumulator once a *later* block's first swap observes it,
  and then only for the time it was actually live (the standard TWAP holding cost).

### `consult`

```solidity
function consult(PoolId id, uint32 secondsAgo) public view returns (int24 meanTick);
function consult(PoolKey calldata key, uint32 secondsAgo) external view returns (int24 meanTick);
```

* `meanTick = (cumulative(now) - cumulative(now - secondsAgo)) / secondsAgo`, in `int56` tick-seconds.
* `cumulative(now)` extrapolates from the newest observation with the current tick if the newest
  observation is older than `now` (v3 behaviour). This is why `snapshot` does not need to write an
  observation first.
* `cumulative(target)` linearly interpolates between the two observations that bracket `target`.
* Reverts `InvalidTwapWindow()` for `secondsAgo == 0`, `InsufficientHistory()` if `cardinality < 2`
  or the window reaches before the oldest observation.
* Result is a **tick** average (geometric/log price). Convert to a settlement price with
  `TickMath.getSqrtPriceAtTick(meanTick)`; the mean tick is always ≤ the arithmetic mean price.

### Epoch snapshots

```solidity
struct EpochSnapshot {
    uint256 timestamp;
    uint160 sqrtPriceX96;
    int24   twapTick;
    uint256 feeGrowthGlobal0X128;
    uint256 feeGrowthGlobal1X128;
}

function snapshot(PoolKey calldata key) external returns (uint256 epochId);
function epochCount(PoolKey calldata key) external view returns (uint256);
function getEpoch(PoolKey calldata key, uint256 epochId) external view returns (EpochSnapshot memory);
function latestEpoch(PoolKey calldata key) external view returns (uint256, EpochSnapshot memory);
function oracleState(PoolId id) external view returns (uint32 cardinality, uint32 lastTimestamp, int56 tickCumulative, uint32 nextIndex);
```

* Epoch ids are **1-based** so `0` means "no epoch". Stored in a per-pool array; index = `epochId - 1`.
* Permissionless by design for now: any keeper, the curator, or a settlement contract can close an
  epoch. Authority over *which* epoch counts belongs to the vault/settlement layer (phase 4), not
  the hook.
* `twapTick = consult(min(TWAP_WINDOW, now - oldestObservation))`, or the spot tick while there are
  fewer than two observations. `TWAP_WINDOW = 30 minutes` is an upper bound; the snapshot always
  uses a window it can actually serve.
* Emits `EpochSnapshotTaken(poolId, epochId, timestamp, twapTick, sqrtPriceX96, feeGrowthGlobal0, feeGrowthGlobal1)`.

### Hook flags

`afterSwap` is gone (nothing to accumulate in the swap path). The hook now declares:

```
afterInitialize | beforeAddLiquidity | beforeRemoveLiquidity | beforeSwap
```

`test/HurdleHook.t.sol` and `script/DeployHurdleHook.s.sol` mine the matching flags.

## Gas

Measured by `test_gasOverheadOfHookSwap`, same fee/liquidity/price, one `zeroForOne` swap in each
pool, `gasleft()` around the router call. Optimizer is off, so these are conservative.

| path | no-hook swap | hooked swap | overhead |
| --- | --- | --- | --- |
| cold ring (new observation slot, blocks 1–32 of a pool) | 86,102 | 120,572 | **34,470** |
| full ring (overwrites an existing slot, steady state) | 86,164 | 98,212 | **12,048** |
| cold ring, `--isolate` (cold access lists per tx) | 151,974 | 193,984 | 42,010 |
| full ring, `--isolate` | 152,036 | 176,424 | 24,388 |

Where the steady-state ~12k goes: hook call + `onlyPoolManager` (~2.6k cold account access), one
`extsload` of `slot0`, one `SLOAD` of the packed oracle slot, one nonzero→nonzero `SSTORE`
(`2.9k`), `keccak256` of the pool key, and the return tuple.

The cold-ring path pays a zero→nonzero `SSTORE` (20k), which only occurs while the 32 slots are
being filled; afterwards every write is an overwrite. This is why the test asserts the 40k target on
the full-ring path (`12,048`) and reports the transient separately. Under `--isolate` the transient
is 42k because the hook account and both of its slots are cold at the start of the transaction; if
that worst case must be under 40k, the options are to pre-touch the oracle slot at
initialization, pack two observations per slot (worst case still one fresh slot), or write every
k-th block instead of every block. None of them change the steady-state number materially, so they
are deferred.

Swaps after the first in a block skip the tick read and the writes entirely: only an `SLOAD` of the
oracle slot plus the hook call.

A snapshot costs four storage slots (three fresh) plus a `consult`; it is never on the swap path.

## Tests

`test/HurdleHook.t.sol` (7 tests):

1. `test_twapMatchesHandComputedMean` — three swaps at t=+100/+250/+400 with `vm.warp`. Observations
   are `(0, 0)`, `(+100, 0)`, `(+250, tickA*150)`, `(+400, tickA*150 + tickB*150)`. Asserts the 400s
   window equals `(tickA*150 + tickB*150)/400` and the 250s window (which needs interpolation at
   t=+150) equals `(tickA*100 + tickB*150)/250`, plus the raw `oracleState` (cardinality 4, newest
   timestamp, cumulative).
2. `test_consultRevertsWithoutEnoughHistory` — reverts with one observation, with `secondsAgo == 0`,
   and when the window reaches before the seed.
3. `test_bigSwapInFinalBlockDoesNotMoveTwap` — a 1e17 swap in the final block moves the spot tick
   (asserted) but leaves `consult(400)` byte-identical.
4. `test_ringBufferWrapsAndKeepsRecentHistory` — 40 swaps, 41 observations: cardinality caps at 32,
   the write cursor wraps to 9, the 372s mean equals the average of the 31 ticks that occupy the
   surviving intervals, and 373s reverts.
5. `test_snapshotFallsBackToSpotWithoutHistory` — a snapshot before the second observation stores
   the spot tick (documented fallback) and zero fee growth.
6. `test_snapshotStoresFeeGrowthAndPrice` — permissionless call from `0xBEEF`; asserts epoch id 1,
   timestamp, `sqrtPriceX96`, hand-computed TWAP (`tickA*100/200`), both fee-growth globals, the
   `latestEpoch` mirror, and `UnknownEpoch` for ids 0 and 2.
7. `test_gasOverheadOfHookSwap` — the table above.

## Limits and follow-ups

* **Effective window = cardinality × block time.** With 32 slots and one write per block the ring
  covers ~6.4 min on a 12s chain and ~64s on Unichain (2s blocks). `TWAP_WINDOW` is only an upper
  bound; `snapshot` shortens to available history. For longer settlement windows, raise
  `OBSERVATION_CARDINALITY` (cost per write is unchanged; `consult` is a linear scan, ≤32 today, so
  use a binary search before growing it a lot) or write every k-th block and keep 32 slots.
* `consult` is O(cardinality) and reverts rather than returning a shorter window; callers that want
  "as much as available" should read `oracleState`/`epochCount` first, as `snapshot` does.
* **Spot vs TWAP in the snapshot.** `sqrtPriceX96` is stored for replay/audit, but it is
  manipulable in the snapshot block. Settlement (phase 4) must use
  `TickMath.getSqrtPriceAtTick(twapTick)` for both NAV and benchmark, exactly as
  `benchmark-math.md` recommends.
* **Unsigned/overflow bounds.** `uint32` timestamps work until 2106; `int56` cumulative overflows
  after ~4e10 s at the extreme tick (~1,290 years) and arithmetic is `unchecked` like v3. Practical
  for this project; a production version would widen both.
* **Precision.** Interpolation truncates toward zero, so a mean can be off by at most ~1 tick
  (1 bp-ish), far below the 100 bp benchmark tolerance. Interpolation uses `int256` intermediates so
  `int56` cannot wrap on a very long gap between observations, unlike stock v3.
* **Stale price between observations.** If nobody swaps for a long time, the current tick is
  extrapolated over the gap. That is correct (no swaps means no price change), but it means a price
  held by an attacker across the gap is priced in — the usual TWAP trade-off, bounded by the window.
* **Manipulation cost scales with window length**, not with swap size inside a block. A 64s window
  on Unichain is cheap to hold for one minute; the phase-4 decision on window length should weigh
  that against how stale a settlement price may be.
* `snapshot` is unauthenticated and spam-able (four slots per call). If epoch creation should be
  gated, add a keeper/curator allowlist in phase 4 without changing the stored data.
* The oracle is per-pool, not per-position; the passive benchmark's `feeGrowthGlobal` delta still
  has to be divided by the epoch's `L` (phase 2 harness). `twapTick` supplies the price path term.
