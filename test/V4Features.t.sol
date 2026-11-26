// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {HurdleHook} from "../src/HurdleHook.sol";
import {HurdleVault} from "../src/HurdleVault.sol";
import {VaultFixture} from "./VaultFixture.sol";

/// v4: postBond pays down `deficit`, fired vaults skip the capacity floor on deposit, the fee cap grows
/// over at most one epoch.
contract V4Features is VaultFixture {
    using PoolIdLibrary for *;
    using StateLibrary for IPoolManager;

    address constant BOB = address(0xB0B);

    function _t1() internal view returns (MockERC20) {
        return MockERC20(Currency.unwrap(currency1));
    }

    // ---------------------------------------------------------------------
    // 1. postBond pays down the deficit
    // ---------------------------------------------------------------------

    /// One losing epoch settled: the bond paid a shortfall, so `deficit` > 0 and a newcomer is blocked.
    function _deficitVault() internal returns (uint256 d) {
        vault = _newVault(6e18);
        _losingEpoch(0); // ends with vault.settle(): the next epoch's window opens now
        d = vault.deficit();
        assertGt(d, 0, "scenario: no deficit");
        assertFalse(vault.fired(), "scenario: fired");
        _fund(BOB, address(vault), 100e18, 100e18);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 10);
    }

    function test_postBondPaysDownDeficitAndReopensDeposits() public {
        uint256 d = _deficitVault();
        uint256 shares = vault.balanceOf(ALICE) / 10;

        vm.prank(BOB);
        vm.expectRevert(HurdleVault.DeficitOutstanding.selector);
        vault.deposit(shares, 100e18, 100e18);

        _fund(CURATOR, address(vault), 0, d);
        vm.prank(CURATOR);
        vault.postBond(d);
        assertEq(vault.deficit(), 0, "deficit not cleared by a bond >= deficit");

        vm.prank(BOB);
        vault.deposit(shares, 100e18, 100e18);
        assertEq(vault.balanceOf(BOB), shares, "newcomer not admitted");
    }

    function test_postBondMoreThanDeficitClampsToZero() public {
        uint256 d = _deficitVault();
        _fund(CURATOR, address(vault), 0, d + 5e17);
        vm.prank(CURATOR);
        vault.postBond(d + 5e17);
        assertEq(vault.deficit(), 0, "deficit not clamped to 0");
        uint256 shares = vault.balanceOf(ALICE) / 10;
        vm.prank(BOB);
        vault.deposit(shares, 100e18, 100e18);
        assertEq(vault.balanceOf(BOB), shares, "newcomer not admitted");
    }

    function test_postBondPartialReducesDeficitExactly() public {
        uint256 d = _deficitVault();
        uint256 part = d / 3;
        assertGt(part, 0);
        _fund(CURATOR, address(vault), 0, part);
        vm.prank(CURATOR);
        vault.postBond(part);
        assertEq(vault.deficit(), d - part, "partial post did not reduce deficit by exactly the amount");
        // A second partial post lowers it by exactly that amount again.
        _fund(CURATOR, address(vault), 0, part);
        vm.prank(CURATOR);
        vault.postBond(part);
        assertEq(vault.deficit(), d - 2 * part, "second partial post");
    }

    // ---------------------------------------------------------------------
    // 2. fired vaults skip the capacity floor on deposit
    // ---------------------------------------------------------------------

    /// Fire the curator (losing epochs), let the fire-time park happen, wait a full epoch, reclaim the
    /// bond (bond = 0). The reclaim settles the elapsed epoch, so the window is open right after it.
    function _firedAndReclaimed() internal {
        vault = _newVault(0.6e18);
        int24 tick;
        for (uint256 epoch; epoch < 12 && !vault.fired(); ++epoch) tick = _losingEpoch(tick);
        assertTrue(vault.fired(), "never fired");
        // Anyone finishes the park (each call is impact-bounded); then a full epoch after firing, reclaim.
        for (uint256 i; i < 10; ++i) {
            vm.roll(block.number + 1);
            vm.warp(block.timestamp + 600);
            vault.rebalance(0, 0);
            uint256 snap = vm.snapshotState();
            vm.prank(CURATOR);
            (bool ok,) = address(vault).call(abi.encodeCall(HurdleVault.reclaimBond, ()));
            vm.revertToState(snap);
            if (ok) break;
        }
        vm.prank(CURATOR);
        vault.reclaimBond();
        assertEq(vault.bond(), 0, "bond not reclaimed");
        assertEq(vault.bondShares(), 0, "bond shares not released");
        _fund(BOB, address(vault), 100e18, 100e18);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 10);
    }

    function test_firedVaultDepositIgnoresCapacityFloor() public {
        _firedAndReclaimed();
        uint256 shares = vault.balanceOf(ALICE) / 10;
        vm.prank(BOB);
        vault.deposit(shares, 100e18, 100e18); // must not revert CapacityExceeded with bond == 0
        assertEq(vault.balanceOf(BOB), shares, "newcomer not admitted");
    }

    /// Fired, parked, bond not reclaimed: reached by real calls only (losing epochs, then park steps).
    function _firedParkedUnreclaimed() internal {
        vault = _newVault(0.6e18);
        int24 tick;
        for (uint256 epoch; epoch < 12 && !vault.fired(); ++epoch) tick = _losingEpoch(tick);
        assertTrue(vault.fired(), "never fired");
        bool parkedOk;
        for (uint256 i; i < 10; ++i) {
            vm.roll(block.number + 1);
            vm.warp(block.timestamp + 600);
            (bool ok, bytes memory ret) = address(vault).call(abi.encodeWithSignature("rebalance(int24,int24)", int24(0), int24(0)));
            if (!ok) {
                assertEq(bytes4(ret), HurdleVault.AlreadyParked.selector, "park step failed for another reason");
                parkedOk = true;
                break;
            }
        }
        assertTrue(parkedOk, "never parked");
        _fund(BOB, address(vault), 100e18, 100e18);
        vm.roll(block.number + 1);
        vm.warp(vault.epochStart() + vault.epochSeconds() + 10); // the deposit settles first and opens its window
    }

    function test_firedVaultDepositSkipsDeficitGate() public {
        _firedParkedUnreclaimed();
        assertGt(vault.deficit(), 0, "scenario: no unreclaimed deficit");
        assertTrue(vault.fired());
        uint256 shares = vault.balanceOf(ALICE) / 10;
        vm.prank(BOB);
        vault.deposit(shares, 100e18, 100e18);
        assertEq(vault.balanceOf(BOB), shares, "fired vault with deficit refused a deposit");
    }

    function test_nonFiredVaultWithDeficitStillReverts() public {
        _deficitVault();
        assertGt(vault.deficit(), 0);
        assertFalse(vault.fired());
        _fund(BOB, address(vault), 100e18, 100e18);
        uint256 shares = vault.balanceOf(ALICE) / 10;
        vm.prank(BOB);
        vm.expectRevert(HurdleVault.DeficitOutstanding.selector);
        vault.deposit(shares, 100e18, 100e18);
    }

    function test_nonFiredVaultBelowFloorStillReverts() public {
        vault = _newVault(1e18); // 5% of the 20e18 NAV; floor is 2%
        _fund(BOB, address(vault), 1000e18, 1000e18);
        vm.warp(vault.epochStart() + 10);
        vm.roll(block.number + 1);
        // Triple the NAV: 1e18 bond is 1.67% < 2% floor.
        uint256 shares = vault.totalSupply() * 2;
        vm.prank(BOB);
        vm.expectRevert(HurdleVault.CapacityExceeded.selector);
        vault.deposit(shares, 1000e18, 1000e18);
        assertFalse(vault.fired());
        // A smaller deposit that stays above the floor is fine.
        shares = vault.totalSupply() / 4;
        vm.prank(BOB);
        vault.deposit(shares, 1000e18, 1000e18);
    }

    // ---------------------------------------------------------------------
    // 3. fee cap grows over at most one epoch
    // ---------------------------------------------------------------------

    function _benchAfter(uint256 elapsed) internal returns (uint256 bench, uint256 nav0) {
        (,, uint256 f0, uint256 f1, uint256 n0) = vault.start();
        nav0 = n0;
        // Fee growth far above any cap, price constant (no swaps).
        vm.mockCall(
            address(hook),
            abi.encodeWithSelector(HurdleHook.referenceFeeGrowth.selector),
            abi.encode(f0, f1 + 1e38)
        );
        vm.warp(vault.epochStart() + elapsed);
        vm.recordLogs();
        vault.settle();
        (, bench,,,,) = _lastSettled();
        vm.clearMockedCalls();
    }


    // ---------------------------------------------------------------------
    // 4. fee cap scales with the pool's fee tier
    // ---------------------------------------------------------------------

    function _vaultWithFee(uint24 fee) internal returns (HurdleVault v) {
        PoolKey memory k = key;
        k.fee = fee;
        v = new HurdleVault(manager, k, CURATOR, 2000, 200, 50, 600);
    }

    function test_feeCapScalesWithFeeTier() public {
        assertEq(_vaultWithFee(500).maxFeeAprBps(), 8_000, "0.05% tier is the calibration");
        assertEq(_vaultWithFee(100).maxFeeAprBps(), 1_600, "0.01%");
        assertEq(_vaultWithFee(3000).maxFeeAprBps(), 48_000, "0.3%");
        assertEq(_vaultWithFee(10_000).maxFeeAprBps(), 100_000, "1% hits the ceiling (160_000 -> 100_000)");
        assertEq(_vaultWithFee(0x800000).maxFeeAprBps(), 100_000, "dynamic-fee flag cannot lift the ceiling");
        // benchmark() uses the vault's own cap
        uint160 s = TickMath.getSqrtPriceAtTick(0);
        uint256 nav0 = 100e18;
        uint256 huge = 1 << 127;
        uint256 expect3000 = nav0 + nav0 * 48_000 * 600 / (10_000 * 365 days);
        assertEq(_vaultWithFee(3000).benchmark(nav0, s, s, huge, huge, 600), expect3000);
    }
}
