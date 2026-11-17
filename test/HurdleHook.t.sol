// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
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
            Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_DONATE_FLAG
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

        // Pin the swap ticks so the expected means below are plain constants, not contract formulas.
        assertEq(tickA, -199);
        assertEq(tickB, 1);
        assertEq(cumulativeAtT3, -29_700); // -199*150 + 1*150

        // -29700 / 400 = -74.25, rounded toward negative infinity (v3 OracleLibrary) = -75.
        int24 expectedFullWindow = -75;
        assertEq(hook.consult(key, T3), expectedFullWindow, "400s mean tick");

        // 250s window starts at T3 - 250 = 150, which is interpolated inside the T1..T2 interval.
        int56 cumulativeAt150 = int56(tickA) * int56(uint56(150 - T1));
        assertEq(cumulativeAt150, -9_950); // -199*50
        // (-29700 + 9950) / 250 = -19750 / 250 = -79 exactly, so no rounding.
        int24 expectedPartialWindow = -79;
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
            vm.warp(START + uint32(i) * 60);
            swap(key, i % 2 == 0, -1e13, ZERO_BYTES);
            ticksAfter[i] = _tick(key);
        }
        uint32 nowTs = uint32(block.timestamp);

        (uint32 cardinality, uint32 lastTimestamp,, uint32 nextIndex) = hook.oracleState(key.toId());
        assertEq(cardinality, 32, "ring is full");
        assertEq(lastTimestamp, nowTs, "newest observation");
        assertEq(nextIndex, 41 % 32, "ring write cursor wrapped");

        // The surviving window starts at observation #10 (t=+540) and ends at #41 (t=+2400).
        // Every interval is 60s (= OBSERVATION_INTERVAL), so the mean over 1860s is the average of ticksAfter[9..39].
        int56 tickSum;
        for (uint256 k = 9; k <= 39; ++k) {
            tickSum += int56(ticksAfter[k]);
        }
        assertEq(tickSum, -15, "sum of the 31 live ticks");
        // -15 / 31 = -0.48, rounded toward negative infinity = -1 (truncation would give 0).
        assertEq(hook.consult(key, 31 * 60), -1, "mean over wrapped history");

        // One second more than the retained history is a revert, not a silent short window.
        vm.expectRevert(HurdleHook.InsufficientHistory.selector);
        hook.consult(key, 31 * 60 + 1);
    }

    /// Swaps faster than OBSERVATION_INTERVAL: the accumulator still updates every block, so a
    /// window ending between ring entries is exact (interpolated against the latest accumulator point).
    function test_twapExactBetweenRingEntries() public {
        int24[11] memory ticksAfter;
        ticksAfter[0] = _tick(key);
        for (uint256 i = 1; i <= 10; ++i) {
            vm.warp(START + uint32(i) * 12);
            swap(key, i % 2 == 0, -1e15, ZERO_BYTES);
            ticksAfter[i] = _tick(key);
        }
        vm.warp(START + 132);
        // Mean over the last 72s = ticks live during (60,132]: ticksAfter[5..10], 12s each.
        int56 tickSum;
        for (uint256 k = 5; k <= 10; ++k) tickSum += int56(ticksAfter[k]);
        assertEq(hook.consult(key, 72), int24(tickSum / 6));
        (uint32 cardinality,,,) = hook.oracleState(key.toId());
        assertEq(cardinality, 3, "ring entries at t=0, 60, 120 only");
    }

    /// Moves the pool to exactly tick `a` at START+60, then `b` at START+120, and returns the 120s mean
    /// at START+180 (a live for 60s, b live for 60s). Steps are OBSERVATION_INTERVAL apart so both
    /// window edges are ring entries and nothing is interpolated.
    function _twoSecondMean(int24 a, int24 b) internal returns (int24) {
        vm.warp(START + 60);
        _moveTo(a);
        vm.warp(START + 120);
        _moveTo(b);
        vm.warp(START + 180);
        return hook.consult(key, 120);
    }

    function _moveTo(int24 tick) internal {
        (uint160 sqrtNow,,,) = manager.getSlot0(key.toId());
        uint160 target = TickMath.getSqrtPriceAtTick(tick);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams(target < sqrtNow, -int256(1e30), target),
            PoolSwapTest.TestSettings(false, false),
            ZERO_BYTES
        );
        assertEq(_tick(key), tick, "pool should sit exactly on the target tick");
    }

    /// Mean of ticks -150 and 1 is -149/2 = -74.5: rounds DOWN to -75 (truncation would give -74).
    function test_negativeNonIntegerMeanRoundsDown() public {
        assertEq(_twoSecondMean(-150, 1), -75);
    }

    /// Mean of ticks 150 and -1 is 149/2 = 74.5: truncates to 74 (floor and truncation agree).
    function test_positiveNonIntegerMeanTruncates() public {
        assertEq(_twoSecondMean(150, -1), 74);
    }

    /// A negative mean that divides exactly must not be decremented: (-150 + -2)/2 = -76.
    function test_negativeExactMeanNotDecremented() public {
        assertEq(_twoSecondMean(-150, -2), -76);
    }

    function test_referenceFeeGrowthIgnoresSameBlockSwaps() public {
        (uint256 fg0Open, uint256 fg1Open) = manager.getFeeGrowthGlobals(key.toId());
        vm.warp(START + 100);
        (uint256 r0, uint256 r1) = hook.referenceFeeGrowth(key.toId());
        assertEq(r0, fg0Open, "no swap yet: live fee growth");
        assertEq(r1, fg1Open);

        swap(key, true, -1e16, ZERO_BYTES); // block N, first swap (fee in token0)
        (uint256 l0,) = manager.getFeeGrowthGlobals(key.toId());
        assertGt(l0, fg0Open, "swap should raise fee growth");
        (r0, r1) = hook.referenceFeeGrowth(key.toId());
        assertEq(r0, fg0Open, "reference = value before block N's first swap");
        assertEq(r1, fg1Open);

        swap(key, false, -1e16, ZERO_BYTES); // more swaps in the same block, both directions
        swap(key, true, -1e16, ZERO_BYTES);
        (uint256 live0, uint256 live1) = manager.getFeeGrowthGlobals(key.toId());
        assertGt(live1, fg1Open, "live fee growth moved");
        (r0, r1) = hook.referenceFeeGrowth(key.toId());
        assertEq(r0, fg0Open, "same-block swaps must not move the reference");
        assertEq(r1, fg1Open);

        vm.warp(START + 101); // block N+1, before any swap: reference = live
        (r0, r1) = hook.referenceFeeGrowth(key.toId());
        assertEq(r0, live0, "next block: reference = live fee growth");
        assertEq(r1, live1);
    }

    function test_donateReverts() public {
        vm.expectRevert();
        donateRouter.donate(key, 1e15, 1e15, ZERO_BYTES);
    }

    // ---------------------------------------------------------------------
    // Settlement price helpers
    // ---------------------------------------------------------------------

    function test_twapTickRevertsOnYoungPool() public {
        vm.warp(START + 599);
        vm.expectRevert(HurdleHook.InsufficientHistory.selector);
        hook.twapTick(key.toId());
        vm.warp(START + 600);
        assertEq(hook.twapTick(key.toId()), _tick(key), "flat history: TWAP = spot");
    }

    function test_referenceTickIgnoresSameBlockSwaps() public {
        vm.warp(START + 100);
        int24 open = _tick(key);
        assertEq(hook.referenceTick(key.toId()), open, "no swap yet: spot is the last close");
        swap(key, false, 1e17, ZERO_BYTES); // pump in this block
        assertTrue(_tick(key) != open);
        assertEq(hook.referenceTick(key.toId()), open, "same-block swap moved the reference");
        vm.warp(START + 101);
        assertEq(hook.referenceTick(key.toId()), _tick(key), "next block: reference = previous close");
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
