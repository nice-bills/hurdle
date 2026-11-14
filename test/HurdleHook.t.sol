// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {HurdleHook} from "../src/HurdleHook.sol";
import {HookMiner} from "./utils/HookMiner.sol";

contract HurdleHookTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    /// @dev Fixed genesis timestamp so every expected cumulative is hand-computable.
    uint32 constant START = 1_000_000;
    uint32 constant T1 = 100;
    uint32 constant T2 = 250;
    uint32 constant T3 = 400;

    HurdleHook hook;
    PoolKey noHookKey;

    function setUp() public {
        vm.warp(START);

        // Deploy the pool manager, test routers, and two mock currencies.
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        // Full-range 1e18 liquidity: big swaps move the tick without exiting the position,
        // which keeps the TWAP arithmetic readable.
        IPoolManager.ModifyLiquidityParams memory fullRange =
            IPoolManager.ModifyLiquidityParams({tickLower: -887220, tickUpper: 887220, liquidityDelta: 1e18, salt: 0});
        LIQUIDITY_PARAMS = fullRange;

        // Mine a CREATE2 salt that gives the hook the permission bits it declares.
        uint160 flags = uint160(
            Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
                | Hooks.AFTER_INITIALIZE_FLAG
        );
        (address hookAddress, bytes32 salt) =
            HookMiner.find(address(this), flags, type(HurdleHook).creationCode, abi.encode(address(manager)));

        hook = new HurdleHook{salt: salt}(manager);
        assertEq(address(hook), hookAddress, "hook deployed to an unmined address");

        // Initialize the pool and seed liquidity (exercises beforeAddLiquidity + afterInitialize).
        (key,) = initPoolAndAddLiquidity(currency0, currency1, IHooks(address(hook)), 3000, SQRT_PRICE_1_1);

        // Same pool without a hook, for the gas comparison.
        (noHookKey,) = initPool(currency0, currency1, IHooks(address(0)), 3000, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(noHookKey, fullRange, ZERO_BYTES);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _tick(PoolKey memory _key) internal view returns (int24 tick) {
        (, tick,,) = manager.getSlot0(_key.toId());
    }

    /// @dev Three swaps at t=100, 250, 400 so the oracle holds:
    ///      (START, 0), (T1, 0), (T2, tickA*150), (T3, tickA*150 + tickB*150).
    function _buildThreeIntervalHistory() internal returns (int24 tickA, int24 tickB) {
        vm.warp(START + T1);
        swap(key, true, -1e16, ZERO_BYTES);
        tickA = _tick(key);

        vm.warp(START + T2);
        swap(key, false, -1e16, ZERO_BYTES);
        tickB = _tick(key);

        vm.warp(START + T3);
        swap(key, true, -1e16, ZERO_BYTES);
    }

    // ---------------------------------------------------------------------
    // TWAP
    // ---------------------------------------------------------------------

    function test_twapMatchesHandComputedMean() public {
        (int24 tickA, int24 tickB) = _buildThreeIntervalHistory();

        // The seed at START contributes tick 0, so cumulative(T3) is exactly the two intervals in
        // which the post-swap ticks were live.
        int56 cumulativeAtT3 = int56(tickA) * int56(uint56(T2 - T1)) + int56(tickB) * int56(uint56(T3 - T2));

        int24 expectedFullWindow = int24(cumulativeAtT3 / int56(uint56(T3)));
        assertEq(hook.consult(key, T3), expectedFullWindow, "400s mean tick");

        // 250s window starts at T3 - 250 = 150, which is interpolated inside the T1..T2 interval.
        int56 cumulativeAt150 = int56(tickA) * int56(uint56(150 - T1));
        int24 expectedPartialWindow = int24((cumulativeAtT3 - cumulativeAt150) / int56(uint56(T3 - 150)));
        assertEq(hook.consult(key, T3 - 150), expectedPartialWindow, "250s interpolated mean tick");

        // Sanity: the mean is not the spot tick (otherwise the assertions above are vacuous).
        int24 spot = _tick(key);
        assertTrue(expectedFullWindow != spot, "mean should differ from spot");
        assertTrue(tickA != 0 && tickB != 0, "swaps should move the tick");

        // Raw accumulator check: one observation per block, newest cumulative at T3.
        (uint32 cardinality, uint32 lastTimestamp, int56 tickCumulative,) = hook.oracleState(key.toId());
        assertEq(cardinality, 4);
        assertEq(lastTimestamp, START + T3);
        assertEq(tickCumulative, cumulativeAtT3);
    }

    function test_consultRevertsWithoutEnoughHistory() public {
        // Only the afterInitialize seed exists.
        vm.expectRevert(HurdleHook.InsufficientHistory.selector);
        hook.consult(key, 100);

        vm.expectRevert(HurdleHook.InvalidTwapWindow.selector);
        hook.consult(key, 0);

        vm.warp(START + 100);
        swap(key, true, -1e15, ZERO_BYTES);

        // Two observations now, but a 101s window reaches back before the seed.
        vm.expectRevert(HurdleHook.InsufficientHistory.selector);
        hook.consult(key, 101);
    }

    function test_bigSwapInFinalBlockDoesNotMoveTwap() public {
        _buildThreeIntervalHistory();

        vm.warp(START + 600);
        int24 twapBefore = hook.consult(key, 400);
        int24 spotBefore = _tick(key);

        // Same block as the observation above, so this swap must carry zero weight.
        swap(key, true, -1e17, ZERO_BYTES);

        int24 spotAfter = _tick(key);
        assertTrue(spotAfter != spotBefore, "big swap should move spot price");
        assertEq(hook.consult(key, 400), twapBefore, "TWAP must ignore the final-block swap");
    }

    function test_ringBufferWrapsAndKeepsRecentHistory() public {
        // 1 seed + 40 swaps = 41 observations, so the 32-slot ring keeps #10..#41.
        int24[41] memory ticksAfter; // [0] = init tick, [i] = tick after swap i
        ticksAfter[0] = _tick(key);
        for (uint256 i = 1; i <= 40; ++i) {
            vm.warp(START + uint32(i) * 12);
            swap(key, i % 2 == 0, -1e13, ZERO_BYTES);
            ticksAfter[i] = _tick(key);
        }
        uint32 nowTs = uint32(block.timestamp);

        (uint32 cardinality, uint32 lastTimestamp,, uint32 nextIndex) = hook.oracleState(key.toId());
        assertEq(cardinality, 32, "ring is full");
        assertEq(lastTimestamp, nowTs, "newest observation");
        assertEq(nextIndex, 41 % 32, "ring write cursor wrapped");

        // The surviving window starts at observation #10 (t=+108) and ends at #41 (t=+480).
        // Every interval is 12s, so the mean over 372s is the average of ticksAfter[9..39].
        int56 tickSum;
        for (uint256 k = 9; k <= 39; ++k) {
            tickSum += int56(ticksAfter[k]);
        }
        assertEq(hook.consult(key, 31 * 12), int24(tickSum / 31), "mean over wrapped history");

        // One second more than the retained history is a revert, not a silent short window.
        vm.expectRevert(HurdleHook.InsufficientHistory.selector);
        hook.consult(key, 31 * 12 + 1);
    }

    // ---------------------------------------------------------------------
    // Epoch snapshots
    // ---------------------------------------------------------------------

    function test_snapshotStoresFeeGrowthAndPrice() public {
        vm.warp(START + 100);
        swap(key, true, -1e16, ZERO_BYTES);
        int24 tickA = _tick(key);

        vm.warp(START + 200);
        swap(key, false, -1e16, ZERO_BYTES);

        (uint160 sqrtPriceX96,,,) = manager.getSlot0(key.toId());
        (uint256 feeGrowthGlobal0X128, uint256 feeGrowthGlobal1X128) = manager.getFeeGrowthGlobals(key.toId());
        assertGt(feeGrowthGlobal0X128 + feeGrowthGlobal1X128, 0, "swaps should accrue fees");

        // 200s of history, shorter than TWAP_WINDOW, so the snapshot uses all of it:
        // tick 0 for [START, 100], tickA for [100, 200].
        int24 expectedTwapTick = int24(int56(tickA) * 100 / 200);
        assertEq(hook.consult(key, 200), expectedTwapTick, "hand-computed 200s mean");

        vm.prank(address(0xBEEF));
        uint256 epochId = hook.snapshot(key);
        assertEq(epochId, 1, "first epoch is 1");
        assertEq(hook.epochCount(key), 1);

        HurdleHook.EpochSnapshot memory snap = hook.getEpoch(key, 1);
        assertEq(snap.timestamp, block.timestamp, "snapshot timestamp");
        assertEq(snap.sqrtPriceX96, sqrtPriceX96, "snapshot price");
        assertEq(snap.twapTick, expectedTwapTick, "snapshot TWAP tick");
        assertEq(snap.feeGrowthGlobal0X128, feeGrowthGlobal0X128, "fee growth 0");
        assertEq(snap.feeGrowthGlobal1X128, feeGrowthGlobal1X128, "fee growth 1");

        (uint256 latestId, HurdleHook.EpochSnapshot memory latest) = hook.latestEpoch(key);
        assertEq(latestId, 1);
        assertEq(latest.sqrtPriceX96, snap.sqrtPriceX96);
        assertEq(latest.feeGrowthGlobal0X128, snap.feeGrowthGlobal0X128);

        vm.expectRevert(HurdleHook.UnknownEpoch.selector);
        hook.getEpoch(key, 0);
        vm.expectRevert(HurdleHook.UnknownEpoch.selector);
        hook.getEpoch(key, 2);
    }

    function test_snapshotFallsBackToSpotWithoutHistory() public {
        // Only the afterInitialize seed exists, so there is no TWAP window yet.
        (uint160 sqrtPriceX96, int24 spotTick,,) = manager.getSlot0(key.toId());

        uint256 epochId = hook.snapshot(key);
        assertEq(epochId, 1);

        HurdleHook.EpochSnapshot memory snap = hook.getEpoch(key, 1);
        assertEq(snap.sqrtPriceX96, sqrtPriceX96);
        assertEq(snap.twapTick, spotTick, "spot fallback before two observations");
        assertEq(snap.feeGrowthGlobal0X128, 0);
        assertEq(snap.feeGrowthGlobal1X128, 0);
    }

    // ---------------------------------------------------------------------
    // Gas overhead
    // ---------------------------------------------------------------------

    function test_gasOverheadOfHookSwap() public {
        // Phase A, cold ring: the pool is young, so the observation lands in an unused slot.
        vm.warp(START + 100);
        swap(key, true, -1e14, ZERO_BYTES);
        swap(noHookKey, true, -1e14, ZERO_BYTES);

        vm.warp(START + 200);
        uint256 gasBefore = gasleft();
        swap(key, true, -1e14, ZERO_BYTES);
        uint256 hookColdGas = gasBefore - gasleft();

        gasBefore = gasleft();
        swap(noHookKey, true, -1e14, ZERO_BYTES);
        uint256 plainColdGas = gasBefore - gasleft();

        // Fill the 32-slot ring (mirror the swaps into the no-hook pool so the states stay close).
        for (uint256 i = 0; i < 32; ++i) {
            vm.warp(START + 300 + i * 12);
            swap(key, true, -1e13, ZERO_BYTES);
            swap(noHookKey, true, -1e13, ZERO_BYTES);
        }

        // Phase B, full ring: the observation overwrites an existing slot. This is the number that
        // matters for a live pool, and the one the 40k budget is measured against.
        vm.warp(START + 1000);
        gasBefore = gasleft();
        swap(key, true, -1e13, ZERO_BYTES);
        uint256 hookSteadyGas = gasBefore - gasleft();

        gasBefore = gasleft();
        swap(noHookKey, true, -1e13, ZERO_BYTES);
        uint256 plainSteadyGas = gasBefore - gasleft();

        console2.log("cold-ring swap gas, no hook ", plainColdGas);
        console2.log("cold-ring swap gas, with hook", hookColdGas);
        console2.log("cold-ring hook overhead      ", int256(hookColdGas) - int256(plainColdGas));
        console2.log("full-ring swap gas, no hook ", plainSteadyGas);
        console2.log("full-ring swap gas, with hook", hookSteadyGas);
        console2.log("full-ring hook overhead      ", int256(hookSteadyGas) - int256(plainSteadyGas));

        assertLt(hookSteadyGas, plainSteadyGas + 40_000, "hook overhead must stay under 40k gas");
    }
}
