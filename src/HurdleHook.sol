// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "v4-periphery/src/base/hooks/BaseHook.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";

/// Hurdle: settles LP curators against an onchain passive-LP benchmark.
/// @notice Phase 3: a stripped-down Uniswap v3 oracle (time-weighted tick accumulator per pool)
/// plus permissionless epoch snapshots of the inputs the benchmark needs.
/// @dev The accumulator is written in `beforeSwap`, before the pool moves its price. The tick
/// that was live over the elapsed period is therefore the only tick that earns weight, and every
/// swap in a block after the first writes nothing. Same-block price manipulation has zero weight
/// on the TWAP regardless of the order or size of the swaps.
contract HurdleHook is BaseHook {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    /// @notice Number of observations kept per pool (ring buffer).
    uint32 public constant OBSERVATION_CARDINALITY = 32;

    /// @notice Minimum spacing of ring-buffer entries. The accumulator itself updates every block,
    /// so the TWAP stays exact; spacing only stretches the history to 32 x 60s = 32 minutes, which a
    /// one-entry-per-block ring could not hold on a 1s-block chain.
    uint32 public constant OBSERVATION_INTERVAL = 60;

    /// @notice Preferred window for `snapshot`'s TWAP tick. Shortened to the available history.
    uint32 public constant TWAP_WINDOW = 30 minutes;

    /// @param timestamp Observation block timestamp (uint32, as in Uniswap v3)
    /// @param tickCumulative Running sum of `tick * seconds` (int56, as in Uniswap v3)
    struct Observation {
        uint32 timestamp;
        int56 tickCumulative;
    }

    /// @notice Per-pool accumulator. Fits in a single storage slot.
    struct OracleState {
        uint32 index; // next slot in the ring buffer to write
        uint32 cardinality; // initialized observations, capped at OBSERVATION_CARDINALITY
        uint32 lastTimestamp; // timestamp of the latest accumulator update (may be newer than the ring)
        int56 tickCumulative; // cumulative at lastTimestamp
    }

    /// @notice Everything the passive benchmark needs at the start/end of an epoch.
    struct EpochSnapshot {
        uint256 timestamp;
        uint160 sqrtPriceX96;
        int24 twapTick;
        uint256 feeGrowthGlobal0X128;
        uint256 feeGrowthGlobal1X128;
    }

    mapping(PoolId => OracleState) private _oracle;
    mapping(PoolId => Observation[OBSERVATION_CARDINALITY]) private _observations;
    mapping(PoolId => EpochSnapshot[]) private _epochs;

    event EpochSnapshotTaken(
        PoolId indexed poolId,
        uint256 indexed epochId,
        uint256 timestamp,
        int24 twapTick,
        uint160 sqrtPriceX96,
        uint256 feeGrowthGlobal0X128,
        uint256 feeGrowthGlobal1X128
    );

    error InvalidTwapWindow();
    error DonationsDisabled();
    error InsufficientHistory();
    error UnknownEpoch();

    constructor(IPoolManager _manager) BaseHook(_manager) {}

    /// @inheritdoc BaseHook
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: true,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: true,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: true,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ---------------------------------------------------------------------
    // Observation writes
    // ---------------------------------------------------------------------

    /// @notice Seed the oracle with the post-initialization tick. Gas: one observation write.
    function afterInitialize(address, PoolKey calldata key, uint160, int24 tick)
        external
        override
        onlyPoolManager
        returns (bytes4)
    {
        _write(key.toId(), tick, uint32(block.timestamp));
        return IHooks.afterInitialize.selector;
    }

    /// @notice Accumulate the pre-swap tick, then let the swap move the price.
    /// @dev Accumulating before the swap is what gives same-block manipulation zero weight:
    /// the post-swap tick is not observed until the next block's first swap, and by then it has
    /// been the live tick for the elapsed time.
    function beforeSwap(address, PoolKey calldata key, IPoolManager.SwapParams calldata, bytes calldata)
        external
        override
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        uint32 timestamp = uint32(block.timestamp);
        OracleState storage oracle = _oracle[id];

        // Cheap path: only the first swap of a block pays for the tick read and the write.
        if (oracle.cardinality == 0 || timestamp > oracle.lastTimestamp) {
            (, int24 tick,,) = poolManager.getSlot0(id);
            _write(id, tick, timestamp);
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    /// @notice Donations are blocked: `donate` raises feeGrowthGlobal without a swap, which would
    /// inflate the passive benchmark that curators are settled against.
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert DonationsDisabled();
    }

    /// @dev Updates the accumulator at most once per block; appends to the ring at most every OBSERVATION_INTERVAL.
    function _write(PoolId id, int24 tick, uint32 timestamp) private {
        OracleState storage oracle = _oracle[id];
        uint32 lastTimestamp = oracle.lastTimestamp;

        // At most one observation per block. This is also the same-block manipulation guard.
        if (oracle.cardinality != 0 && timestamp <= lastTimestamp) return;

        if (oracle.cardinality != 0) {
            unchecked {
                oracle.tickCumulative += int56(tick) * int56(uint56(timestamp - lastTimestamp));
            }
        }

        oracle.lastTimestamp = timestamp;
        if (oracle.cardinality != 0 && timestamp < _latestRingTimestamp(id) + OBSERVATION_INTERVAL) return;

        uint32 index = oracle.index;
        _observations[id][index] = Observation({timestamp: timestamp, tickCumulative: oracle.tickCumulative});

        unchecked {
            index = (index + 1) % OBSERVATION_CARDINALITY;
        }
        oracle.index = index;
        if (oracle.cardinality < OBSERVATION_CARDINALITY) {
            unchecked {
                oracle.cardinality += 1;
            }
        }
    }

    // ---------------------------------------------------------------------
    // TWAP
    // ---------------------------------------------------------------------

    /// @notice Time-weighted mean tick over the last `secondsAgo` seconds.
    /// @dev Reverts if the ring buffer holds fewer than two observations or the window reaches
    /// further back than the oldest observation.
    function consult(PoolId id, uint32 secondsAgo) public view returns (int24 meanTick) {
        if (secondsAgo == 0) revert InvalidTwapWindow();

        OracleState storage oracle = _oracle[id];
        uint32 cardinality = oracle.cardinality;
        if (cardinality < 2) revert InsufficientHistory();

        uint32 nowTs = uint32(block.timestamp);
        if (secondsAgo > nowTs) revert InsufficientHistory();
        uint32 target = nowTs - secondsAgo;
        if (target < _observationAt(id, 0).timestamp) revert InsufficientHistory();

        (uint32 latestTimestamp, int56 latestCumulative) = _latest(id);
        (, int24 currentTick,,) = poolManager.getSlot0(id);

        int56 cumulativeNow = latestCumulative;
        if (nowTs > latestTimestamp) {
            unchecked {
                cumulativeNow += int56(currentTick) * int56(uint56(nowTs - latestTimestamp));
            }
        }

        int56 cumulativeTarget = _cumulativeAt(id, target, latestTimestamp, latestCumulative, currentTick);

        unchecked {
            meanTick = int24((cumulativeNow - cumulativeTarget) / int56(uint56(secondsAgo)));
        }
    }

    /// @notice Convenience overload keyed by the pool key.
    function consult(PoolKey calldata key, uint32 secondsAgo) external view returns (int24 meanTick) {
        return consult(key.toId(), secondsAgo);
    }

    /// @dev Cumulative tick at `target`, interpolating between observations (v3 style).
    function _cumulativeAt(PoolId id, uint32 target, uint32 latestTimestamp, int56 latestCumulative, int24 currentTick)
        private
        view
        returns (int56)
    {
        if (target >= latestTimestamp) {
            unchecked {
                return latestCumulative + int56(currentTick) * int56(uint56(target - latestTimestamp));
            }
        }

        Observation memory before = _observationAt(id, 0);
        if (target == before.timestamp) return before.tickCumulative;

        uint32 cardinality = _oracle[id].cardinality;
        for (uint32 i = 1; i < cardinality; ++i) {
            Observation memory afterObs = _observationAt(id, i);
            if (afterObs.timestamp >= target) {
                uint32 span = afterObs.timestamp - before.timestamp;
                int56 cumulativeDelta = afterObs.tickCumulative - before.tickCumulative;
                unchecked {
                    // int256 intermediates: delta (< 2^55) * elapsed (< 2^32) cannot overflow, whereas
                    // int56 would wrap after very long gaps between observations.
                    int56 offset = int56(
                        (int256(cumulativeDelta) * int256(uint256(target - before.timestamp))) / int256(uint256(span))
                    );
                    return before.tickCumulative + offset;
                }
            }
            before = afterObs;
        }

        // target lies between the newest ring entry and the latest accumulator point.
        unchecked {
            int56 offset = int56(
                (int256(latestCumulative - before.tickCumulative) * int256(uint256(target - before.timestamp)))
                    / int256(uint256(latestTimestamp - before.timestamp))
            );
            return before.tickCumulative + offset;
        }
    }

    /// @dev The observation at logical index `i` (0 = oldest).
    function _observationAt(PoolId id, uint32 i) private view returns (Observation memory) {
        OracleState storage oracle = _oracle[id];
        uint32 start;
        unchecked {
            start = (oracle.index + OBSERVATION_CARDINALITY - oracle.cardinality) % OBSERVATION_CARDINALITY;
        }
        Observation memory observation = _observations[id][(start + i) % OBSERVATION_CARDINALITY];
        return observation;
    }

    /// @dev The latest accumulator point (newer than or equal to the newest ring entry).
    function _latest(PoolId id) private view returns (uint32 timestamp, int56 tickCumulative) {
        OracleState storage oracle = _oracle[id];
        return (oracle.lastTimestamp, oracle.tickCumulative);
    }

    function _latestRingTimestamp(PoolId id) private view returns (uint32) {
        OracleState storage oracle = _oracle[id];
        unchecked {
            return _observations[id][(oracle.index + OBSERVATION_CARDINALITY - 1) % OBSERVATION_CARDINALITY].timestamp;
        }
    }

    /// @notice Settlement tick for vaults: TWAP over `TWAP_WINDOW`, shortened to the available history.
    /// shortcut: the 32-slot ring holds 32 blocks with swaps, so on a busy pool the window is shorter than 30 min; upgrade to a growable ring before mainnet.
    function twapTick(PoolId id) external view returns (int24) {
        (, int24 spotTick,,) = poolManager.getSlot0(id);
        return _twapTickOrSpot(id, spotTick);
    }

    /// @dev TWAP over `TWAP_WINDOW`, shortened to the available history; spot tick before that.
    function _twapTickOrSpot(PoolId id, int24 spotTick) private view returns (int24) {
        if (_oracle[id].cardinality < 2) return spotTick;

        uint32 nowTs = uint32(block.timestamp);
        uint32 oldest = _observationAt(id, 0).timestamp;
        if (nowTs <= oldest) return spotTick;

        uint32 available = nowTs - oldest;
        uint32 window = available < TWAP_WINDOW ? available : TWAP_WINDOW;
        if (window == 0) return spotTick;

        return consult(id, window);
    }

    // ---------------------------------------------------------------------
    // Epoch snapshots
    // ---------------------------------------------------------------------

    /// @notice Permissionlessly freeze the benchmark inputs for a new epoch.
    /// @dev Epoch ids are 1-based so that 0 means "no epoch".
    function snapshot(PoolKey calldata key) external returns (uint256 epochId) {
        PoolId id = key.toId();

        (uint160 sqrtPriceX96, int24 spotTick,,) = poolManager.getSlot0(id);
        (uint256 feeGrowthGlobal0X128, uint256 feeGrowthGlobal1X128) = poolManager.getFeeGrowthGlobals(id);
        int24 settleTick = _twapTickOrSpot(id, spotTick);

        _epochs[id].push(
            EpochSnapshot({
                timestamp: block.timestamp,
                sqrtPriceX96: sqrtPriceX96,
                twapTick: settleTick,
                feeGrowthGlobal0X128: feeGrowthGlobal0X128,
                feeGrowthGlobal1X128: feeGrowthGlobal1X128
            })
        );
        epochId = _epochs[id].length;

        emit EpochSnapshotTaken(
            id, epochId, block.timestamp, settleTick, sqrtPriceX96, feeGrowthGlobal0X128, feeGrowthGlobal1X128
        );
    }

    /// @notice Number of snapshots taken for a pool.
    function epochCount(PoolKey calldata key) external view returns (uint256) {
        return _epochs[key.toId()].length;
    }

    /// @notice Snapshot `epochId` (1-based) for a pool.
    function getEpoch(PoolKey calldata key, uint256 epochId)
        external
        view
        returns (EpochSnapshot memory epochSnapshot)
    {
        EpochSnapshot[] storage epochs = _epochs[key.toId()];
        if (epochId == 0 || epochId > epochs.length) revert UnknownEpoch();
        return epochs[epochId - 1];
    }

    /// @notice Most recent snapshot, if any.
    function latestEpoch(PoolKey calldata key)
        external
        view
        returns (uint256 epochId, EpochSnapshot memory epochSnapshot)
    {
        EpochSnapshot[] storage epochs = _epochs[key.toId()];
        epochId = epochs.length;
        if (epochId == 0) revert UnknownEpoch();
        return (epochId, epochs[epochId - 1]);
    }

    /// @notice Raw accumulator state, for debugging and research tooling.
    function oracleState(PoolId id)
        external
        view
        returns (uint32 cardinality, uint32 lastTimestamp, int56 tickCumulative, uint32 nextIndex)
    {
        OracleState storage oracle = _oracle[id];
        return (oracle.cardinality, oracle.lastTimestamp, oracle.tickCumulative, oracle.index);
    }

    // ---------------------------------------------------------------------
    // Liquidity gates (unchanged)
    // ---------------------------------------------------------------------

    function beforeAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IHooks.beforeAddLiquidity.selector;
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IHooks.beforeRemoveLiquidity.selector;
    }
}
