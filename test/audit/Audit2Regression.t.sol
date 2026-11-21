// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {HurdleVault} from "../../src/HurdleVault.sol";
import {IHurdleVault} from "../../src/IHurdleVault.sol";
import {VaultFixture} from "../VaultFixture.sol";

/// Second audit's PoCs, inverted into regression tests: each reproduces the PoC scenario and asserts the
/// attack no longer works. (Inherits VaultFixture for its setup and helpers.)
contract Audit2Regression is VaultFixture {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address constant BOB = address(0xB0B);

    function _value(address who) internal view returns (uint256) {
        return vault.balanceOf(who) * vault.nav() / vault.totalSupply();
    }

    function _wash() internal {
        (uint160 s0,,,) = manager.getSlot0(key.toId());
        swapRouter.swap(
            key,
            IPoolManager.SwapParams(true, -int256(30e18), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false),
            ZERO_BYTES
        );
        swapRouter.swap(
            key,
            IPoolManager.SwapParams(false, -int256(1e30), s0),
            PoolSwapTest.TestSettings(false, false),
            ZERO_BYTES
        );
    }

    /// Below the floor (not fired): deposits revert CapacityExceeded, curator rebalances revert
    /// BondBelowFloor; postBond lifts both.
    function _assertBlockedUntilPostBond() internal {
        assertFalse(vault.fired(), "fired");
        assertTrue(vault.bondValue() * 10_000 < 200 * vault.nav(), "not below the floor");
        _fund(BOB, address(vault), 100e18, 100e18);
        vm.prank(BOB);
        vm.expectRevert(HurdleVault.CapacityExceeded.selector);
        vault.deposit(1e15, 100e18, 100e18);
        vm.prank(CURATOR);
        vm.expectRevert(HurdleVault.BondBelowFloor.selector);
        vault.rebalance(-600, 600);

        _fund(CURATOR, address(vault), 0, 3e18);
        vm.prank(CURATOR);
        vault.postBond(3e18);
        vm.prank(BOB);
        vault.deposit(1e15, 100e18, 100e18);
        vm.prank(CURATOR);
        vault.rebalance(-600, 600);
    }

    /// Fires through the curator's own epoch-ending rebalance. Returns the last price tick.
    function _fireViaCuratorRebalance() internal returns (int24 tick) {
        _recenter(vault, 120);
        bool firedByRebalance;
        for (uint256 epoch; epoch < 12 && !vault.fired(); ++epoch) {
            for (uint256 i; i < 10; ++i) {
                tick += 100;
                _moveTo(tick);
            }
            vm.warp(block.timestamp + 600);
            int24 c = _floorTick();
            vm.prank(CURATOR);
            try vault.rebalance(c - 120, c + 120) {
                firedByRebalance = vault.fired();
            } catch {
                vault.settle();
            }
        }
        assertTrue(firedByRebalance, "did not fire inside the curator's rebalance");
    }

    // ---------------------------------------------------------------------
    // [1] M: the curator is never fired for beating or tracking par
    // ---------------------------------------------------------------------

    /// Token0 appreciates, so NAV in token1 outgrows the bond. A par-tracking curator is not fired.
    function test_M_trackingParWithNavGrowthNotFired() public {
        vault = _newVault(0.4e18); // 20e18 NAV, bond exactly 2%
        vm.prank(CURATOR);
        vault.rebalance(TickMath.minUsableTick(SPACING), TickMath.maxUsableTick(SPACING));
        _moveTo(400);
        (uint256 nav, uint256 bench,, uint256 paid) = _settled(vault);
        assertGt(nav, 20e18, "NAV did not grow");
        assertLt(paid * 1e6, nav, "only rounding dust paid"); // ~0 paid: not a fire trigger
        assertGe(nav + nav / 1e6, bench);
        _assertBlockedUntilPostBond();
    }

    /// Third party fills the vault to the cap; the curator BEATS par (carry paid) and is not fired.
    function test_M_beatParAtCapNotFired() public {
        vault = _newVault(1e18);
        _recenter(vault, 600);
        vm.warp(block.timestamp + 600);
        vault.settle();
        _fund(BOB, address(vault), 100e18, 100e18);
        uint256 s = vault.totalSupply() * 3 / 2 - 1e15;
        vm.prank(BOB);
        vault.deposit(s, 100e18, 100e18);
        for (uint256 i; i < 10; ++i) _moveTo(i % 2 == 0 ? int24(300) : int24(-300));
        _moveTo(0);
        (uint256 nav, uint256 bench, uint256 take, uint256 paid) = _settled(vault);
        assertGt(nav, bench, "curator beat par");
        assertGt(take, 0, "carry paid");
        assertEq(paid, 0);
        assertFalse(vault.fired(), "beat par and was fired");
        assertTrue(vault.bondValue() * 10_000 < 200 * vault.nav(), "scenario should leave the bond below the floor");
        _assertBlockedUntilPostBond();
    }

    /// Bob fills the vault to the cap; a +1% drift with zero underperformance does not fire the curator.
    function test_M_thirdPartyFillThenDriftNotFired() public {
        vault = _newVault(1e18);
        vm.prank(CURATOR);
        vault.rebalance(TickMath.minUsableTick(SPACING), TickMath.maxUsableTick(SPACING));
        vm.warp(block.timestamp + 600);
        vault.settle();
        _fund(BOB, address(vault), 100e18, 100e18);
        uint256 s = vault.totalSupply() * 3 / 2 - 1e15;
        vm.prank(BOB);
        vault.deposit(s, 100e18, 100e18);
        _moveTo(100);
        (uint256 nav, uint256 bench,, uint256 paid) = _settled(vault);
        assertLt(paid * 1e6, nav, "only rounding dust paid");
        assertGe(nav + nav / 1e6, bench);
        assertFalse(vault.fired(), "fired without underperforming");
        _assertBlockedUntilPostBond();
    }

    // ---------------------------------------------------------------------
    // [2] E: deficit is not inherited by newcomers
    // ---------------------------------------------------------------------

    /// A newcomer cannot join in kind while the deficit is outstanding, even after the compensated
    /// depositor leaves in the same block.
    function test_E_newcomerCannotJoinWhileDeficit() public {
        vault = _newVault(6e18);
        _losingEpoch(0);
        assertGt(vault.deficit(), 0);
        uint256 aShares = vault.balanceOf(ALICE);
        vm.prank(ALICE);
        vault.withdraw(aShares * 9 / 10);
        assertGt(vault.deficit() * 10_000, vault.nav(), "residual deficit should exceed 1 bp");
        _fund(BOB, address(vault), 100e18, 100e18);
        vm.prank(BOB);
        vm.expectRevert(HurdleVault.DeficitOutstanding.selector);
        vault.deposit(aShares, 100e18, 100e18);
    }

    /// A withdrawal takes its pro-rata share of the deficit with it: per-share deficit is unchanged.
    function test_E_perShareDeficitUnchangedByWithdraw() public {
        vault = _newVault(6e18);
        _losingEpoch(0);
        uint256 d0 = vault.deficit();
        uint256 s0 = vault.totalSupply();
        assertGt(d0, 0);
        uint256 aShares = vault.balanceOf(ALICE);
        vm.prank(ALICE);
        vault.withdraw(aShares * 9 / 10);
        uint256 d1 = vault.deficit();
        uint256 s1 = vault.totalSupply();
        assertLt(d1, d0 / 5, "deficit not scaled down");
        assertApproxEqRel(d1 * s0, d0 * s1, 1e12, "per-share deficit changed");
    }

    // ---------------------------------------------------------------------
    // [3] D: a firing settle inside the curator's rebalance keeps the park
    // ---------------------------------------------------------------------

    function test_D_firedInsideCuratorRebalanceStaysParked() public {
        vault = _newVault(0.6e18);
        _fireViaCuratorRebalance();
        assertTrue(vault.fired());
        (int24 lo, int24 hi, uint128 liq) = vault.position();
        assertEq(lo, TickMath.minUsableTick(SPACING), "curator's range overwrote the park");
        assertEq(hi, TickMath.maxUsableTick(SPACING));
        assertGt(liq, 0);
        assertEq(vault.rebalancesThisEpoch(), 0, "firing call took a slot");
    }

    // ---------------------------------------------------------------------
    // [4] K: griefed rebalances revert, keep their slot; fired-path parks are uncapped
    // ---------------------------------------------------------------------

    function test_K_griefedRebalanceRevertsAndKeepsSlot() public {
        vault = _newVault(1e18); // 10e18 + 10e18 idle, spot = TWAP = ref = 0
        for (uint256 i; i < 5; ++i) {
            // attacker pins spot one tick inside the band edge: the swap has ~no room
            swapRouter.swap(
                key,
                IPoolManager.SwapParams(false, -int256(1e30), TickMath.getSqrtPriceAtTick(49)),
                PoolSwapTest.TestSettings(false, false),
                ZERO_BYTES
            );
            vm.prank(CURATOR);
            vm.expectRevert(HurdleVault.RebalanceIncomplete.selector);
            vault.rebalance(600, 1200, 3000);
            assertEq(vault.rebalancesThisEpoch(), 0, "reverted rebalance consumed a slot");
            swapRouter.swap(
                key,
                IPoolManager.SwapParams(true, -int256(1e30), TickMath.getSqrtPriceAtTick(0)),
                PoolSwapTest.TestSettings(false, false),
                ZERO_BYTES
            );
        }
        // Unpinned, the same call goes through (the honest swap leaves < 25% idle) and takes one slot.
        vm.prank(CURATOR);
        vault.rebalance(600, 1200, 3000);
        assertEq(vault.rebalancesThisEpoch(), 1);
        (,, uint128 liq) = vault.position();
        assertGt(liq, 0);
    }

    /// After firing, permissionless parking calls are not counted against MAX_REBALANCES_PER_EPOCH
    /// (and are not blocked by the counter even when it sits at the cap).
    function test_K_firedParksNotCapped() public {
        vault = _newVault(0.6e18);
        _fireViaCuratorRebalance();
        uint256 cap = vault.MAX_REBALANCES_PER_EPOCH();
        vm.store(address(vault), _rebalanceCountSlot(), bytes32(cap));
        uint256 calls;
        for (uint256 i; i < 12; ++i) {
            vm.warp(block.timestamp + 10); // stay inside the epoch the fire started, so the counter is not reset
            vm.prank(address(uint160(0xBEEF00 + i)));
            try vault.rebalance(0, 0) {
                ++calls;
            } catch (bytes memory e) {
                assertEq(bytes4(e), HurdleVault.AlreadyParked.selector, "capped or other revert");
                break;
            }
            assertEq(vault.rebalancesThisEpoch(), cap, "post-fire park counted");
        }
        assertGt(calls, 0, "no post-fire park call went through");
    }

    /// Storage slot of `rebalancesThisEpoch` (`forge inspect HurdleVault storage-layout`).
    function _rebalanceCountSlot() internal pure returns (bytes32) {
        return bytes32(uint256(15));
    }

    // ---------------------------------------------------------------------
    // F: unchanged
    // ---------------------------------------------------------------------

    /// F: settling late (after a behind->ahead round trip) vs on time. Compares curator outcome.
    function test_F_settleTiming() public {
        vault = _newVault(6e18);
        _recenter(vault, 120);
        _moveTo(400); // out of range, behind par; epoch (600s) is over
        uint256 snap = vm.snapshotState();
        vault.settle(); // on time
        for (uint256 i; i < 10; ++i) _moveTo(i % 2 == 0 ? int24(60) : int24(-60));
        _moveTo(0);
        vault.settle();
        (uint256 curA, uint256 aliceA) = (vault.bondValue() + _value(CURATOR), _value(ALICE));
        vm.revertToState(snap);
        for (uint256 i; i < 10; ++i) _moveTo(i % 2 == 0 ? int24(60) : int24(-60));
        _moveTo(0);
        vault.settle(); // late, only once ahead
        (uint256 curB, uint256 aliceB) = (vault.bondValue() + _value(CURATOR), _value(ALICE));
        emit log_named_uint("curator bond+free, on-time settles", curA);
        emit log_named_uint("curator bond+free, late settle    ", curB);
        emit log_named_uint("alice value, on-time              ", aliceA);
        emit log_named_uint("alice value, late                 ", aliceB);
        assertLe(curB, curA, "late settle favours the curator");
        assertGe(aliceB, aliceA - aliceA / 1e9, "late settle hurts the depositor");
    }

    // ---------------------------------------------------------------------
    // [7] same-block wash swaps do not lift par
    // ---------------------------------------------------------------------

    /// Bench seen by settle is unchanged by a same-block wash (block-open fee growth is used).
    function test_7_washBeforeSettleDoesNotChangeBench() public {
        vault = _newVault(1e18);
        _recenter(vault, 600);
        for (uint256 i; i < 40; ++i) _moveTo(i % 2 == 0 ? int24(300) : int24(-300));

        uint256 snap = vm.snapshotState();
        vm.recordLogs();
        vault.settle();
        (, uint256 benchClean,,,, uint160 pClean) = _lastSettled();
        vm.revertToState(snap);

        (uint256 g0,) = manager.getFeeGrowthGlobals(key.toId());
        _wash();
        (uint256 g0After,) = manager.getFeeGrowthGlobals(key.toId());
        assertGt(g0After, g0, "wash did not raise fee growth");
        vm.recordLogs();
        vault.settle();
        (, uint256 benchWash,,,, uint160 pWash) = _lastSettled();

        assertEq(pWash, pClean, "settlement price moved");
        assertEq(benchWash, benchClean, "wash lifted par");
    }

    /// The carry a mid-epoch withdrawer pays is computed against a par the wash cannot lift, and a wash
    /// never lowers it.
    function test_7_washBeforeWithdrawDoesNotChangeCarry() public {
        vault = _newVault(1e18, 50, 1 days);
        _fund(BOB, address(vault), 11e18, 11e18);
        uint256 aliceShares = vault.balanceOf(ALICE);
        vm.prank(BOB);
        vault.deposit(aliceShares, 11e18, 11e18);
        _recenter(vault, 600);
        for (uint256 i; i < 20; ++i) _moveTo(i % 2 == 0 ? int24(300) : int24(-300));
        _moveTo(0);
        uint256 shares = vault.balanceOf(BOB);

        uint256 snap = vm.snapshotState();
        vm.prank(ALICE);
        vault.withdraw(1); // realize fees, as in the washed run
        vm.prank(BOB);
        vault.withdraw(shares);
        uint256 carryClean = vault.balanceOf(CURATOR);
        assertGt(carryClean, 0, "no carry crystallized");
        vm.revertToState(snap);

        _wash();
        vm.prank(ALICE);
        vault.withdraw(1);
        uint256 navNow = vault.nav();
        uint256 benchRef = _benchRef();
        assertGt(navNow, benchRef);
        uint256 t = vault.totalSupply();
        uint256 expected = (navNow - benchRef) * shares / t * 2000 / 10_000;
        vm.prank(BOB);
        vault.withdraw(shares);
        uint256 carryWash = vault.balanceOf(CURATOR);
        emit log_named_uint("carryClean", carryClean);
        emit log_named_uint("carryWash", carryWash);
        assertGe(carryWash, carryClean, "wash lowered the carry paid");
        assertApproxEqRel(carryWash * navNow / t, expected, 1e14, "carry not computed against block-open par");
    }

    /// Par at the block-open fee growth, the same input the vault reads.
    function _benchRef() internal view returns (uint256) {
        (uint64 ts, uint160 s0, uint256 f0, uint256 f1, uint256 n) = vault.start();
        (uint256 g0, uint256 g1) = hook.referenceFeeGrowth(key.toId());
        uint160 s1 = TickMath.getSqrtPriceAtTick(hook.twapTick(key.toId()));
        unchecked {
            return vault.benchmark(n, s0, s1, g0 - f0, g1 - f1, block.timestamp - ts);
        }
    }

    // ---------------------------------------------------------------------
    // [11] in-kind deposit checks spot / block-open / TWAP agreement
    // ---------------------------------------------------------------------

    function test_11_depositRevertsWhenSpotPushed() public {
        vault = _newVault(1e18);
        _moveTo(0); // epoch over, TWAP = spot = reference
        _fund(BOB, address(vault), 100e18, 100e18);
        uint256 snap = vm.snapshotState();
        vm.prank(BOB);
        vault.deposit(1e15, 100e18, 100e18); // control: succeeds without a push
        vm.revertToState(snap);

        swapRouter.swap(
            key,
            IPoolManager.SwapParams(false, -int256(1e30), TickMath.getSqrtPriceAtTick(100)),
            PoolSwapTest.TestSettings(false, false),
            ZERO_BYTES
        ); // > maxTickDeviation (50) in the same block
        vm.prank(BOB);
        vm.expectRevert(HurdleVault.PriceDeviation.selector);
        vault.deposit(1e15, 100e18, 100e18);
    }
}
