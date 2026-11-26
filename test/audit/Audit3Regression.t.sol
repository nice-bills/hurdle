// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {HurdleHook} from "../../src/HurdleHook.sol";
import {HurdleVault} from "../../src/HurdleVault.sol";
import {IHurdleVault} from "../../src/IHurdleVault.sol";
import {VaultFixture} from "../VaultFixture.sol";

/// Audit 3 (research/audit3-accounting.md) regression tests: the PoCs now assert the fixed behaviour.
contract Audit3Regression is VaultFixture {
    address constant BOB = address(0xB0B);
    uint256 constant SLOT_START_NAV = 13; // Start{ts|sqrtP @10, fg0 @11, fg1 @12, nav @13}

    function _setStartNav(uint256 v) internal {
        vm.store(address(vault), bytes32(SLOT_START_NAV), bytes32(v));
    }

    function _val(address who) internal view returns (uint256) {
        return vault.balanceOf(who) * vault.nav() / vault.totalSupply();
    }

    /// Curator side = free shares + bond (tokens + bond shares).
    function _curatorTotal() internal view returns (uint256) {
        return _val(CURATOR) + vault.bondValue();
    }

    /// Idle vault, 50% of supply held by the curator (in-kind deposit). No swaps, so NAV and TWAP are constant
    /// and par is set directly through start.nav.
    function _idleHalfCuratorVault() internal {
        vault = _newVault(4e18); // NAV 20e18, bond 4e18
        uint256 a = vault.balanceOf(ALICE);
        _fund(CURATOR, address(vault), 50e18, 50e18);
        vm.prank(CURATOR);
        vault.deposit(a, 50e18, 50e18); // same block as firstDeposit: in the window
        assertApproxEqRel(vault.balanceOf(CURATOR), a, 1e12);
    }

    /// One miss of m then one beat of m. Net performance is zero, yet deficit returns to 0 while the
    /// bond has paid depositors ~ m*d*x/t^2*(1-carry) that is never recouped.
    function _missThenBeat(uint256 m) internal {
        vm.warp(block.timestamp + 600);
        _setStartNav(vault.nav() + m);
        vm.prank(CURATOR); // no settler bounty, so the curator/depositor split is exact
        vault.settle(); // miss m
        vm.warp(block.timestamp + 600);
        _setStartNav(vault.nav() - m);
        vm.prank(CURATOR);
        vault.settle(); // beat m
    }

    /// A: a miss of m then a beat of m on constant NAV is neutral between curator and depositors.
    function test_A_noiseNetsOut_singleCycle() public {
        _idleHalfCuratorVault();
        uint256 alice0 = _val(ALICE);
        uint256 cur0 = _curatorTotal();
        uint256 m = 1e18; // 2.5% of NAV
        _missThenBeat(m);
        uint256 alice1 = _val(ALICE);
        uint256 cur1 = _curatorTotal();
        console2.log("alice value before", alice0);
        console2.log("alice value after", alice1);
        assertEq(vault.deficit(), 0, "deficit not fully repaid");
        // Fixed: no transfer beyond rounding (the report measured alice +/-0 and curator -2 wei).
        assertApproxEqAbs(alice1, alice0, 1e6, "depositor kept bond money");
        assertApproxEqAbs(cur1, cur0, 1e6, "curator paid for noise");
        assertEq(vault.bondValue() + _val(CURATOR), cur1, "curator side accounting");
    }

    /// A: 60 zero-sum +-2.5% cycles. Before the fix Alice gained +53% from the curator; now she ends
    /// slightly below start (genuine carry on the m^2/N beat), and never gains.
    function test_A_noiseDoesNotDrainCurator_overEpochs() public {
        _idleHalfCuratorVault();
        uint256 alice0 = _val(ALICE);
        uint256 cur0 = _curatorTotal();
        for (uint256 i; i < 60; ++i) {
            _missThenBeat(vault.nav() / 40);
            assertEq(vault.deficit(), 0, "deficit not cleared");
        }
        uint256 alice1 = _val(ALICE);
        console2.log("alice value start", alice0);
        console2.log("alice value end", alice1);
        assertLe(alice1, alice0 + alice0 / 1000, "depositor gained from noise");
        assertGe(alice1, alice0 * 98 / 100, "depositor lost more than carry on m^2/N");
        assertGe(_curatorTotal() + alice0 / 50, cur0, "curator drained");
        assertFalse(vault.fired());
    }

    /// A: the deposit gate compares the deficit with depositors' NAV, not total NAV.
    function test_A_depositGateUsesDepositorShares() public {
        _idleHalfCuratorVault(); // curator holds half
        vm.warp(block.timestamp + 600);
        _setStartNav(vault.nav() + 1e18);
        vm.prank(CURATOR);
        vault.settle(); // miss: deficit = 0.5e18 (1.25% of NAV, 2.5% of depositor NAV)
        uint256 d = vault.deficit();
        assertGt(d, 0);
        _fund(BOB, address(vault), 10e18, 10e18);
        vm.prank(BOB);
        vm.expectRevert(HurdleVault.DeficitOutstanding.selector);
        vault.deposit(1e18, 10e18, 10e18);
        // deficit within 1 bp of the depositors' NAV (but above 1 bp of total NAV) after a partial repay: still closed.
        // Leave 0.75 bp of NAV: inside the old per-total-NAV tolerance, outside the depositors' (half the NAV).
        uint256 left = vault.nav() * 75 / 1_000_000;
        vm.prank(CURATOR);
        vault.postBond(d - left);
        vm.prank(BOB);
        vm.expectRevert(HurdleVault.DeficitOutstanding.selector);
        vault.deposit(1e18, 10e18, 10e18);
        vm.prank(CURATOR);
        vault.postBond(left / 2);
        vm.prank(BOB);
        vault.deposit(1e18, 10e18, 10e18);
    }

    /// A/I4: when the last depositor leaves, no deficit is left behind; the curator's own withdrawal
    /// never forgives or consumes deficit.
    function test_A_withdrawDeficitDepositorsOnly() public {
        _idleHalfCuratorVault();
        vm.warp(block.timestamp + 600);
        _setStartNav(vault.nav() + 1e18);
        vm.prank(CURATOR);
        vault.settle();
        uint256 d = vault.deficit();
        assertGt(d, 0);
        uint256 cur = vault.balanceOf(CURATOR);
        vm.prank(CURATOR);
        vault.withdraw(cur / 2);
        assertEq(vault.deficit(), d, "curator withdrawal touched the deficit");
        uint256 a = vault.balanceOf(ALICE);
        vm.prank(ALICE);
        vault.withdraw(a);
        assertLe(vault.deficit(), 100, "deficit left behind after the last depositor exited");
    }

    /// I3: a 1-share withdraw or a deposit after the epoch end cannot front-run the keeper's bounty.
    function test_I3_implicitSettlePaysBounty() public {
        vault = _newVault(4e18);
        vm.warp(block.timestamp + 600);
        _setStartNav(vault.nav() - 1e18); // beat par by 1e18
        vm.expectEmit(true, false, false, false, address(vault));
        emit IHurdleVault.SettlerPaid(ALICE, 0);
        vm.prank(ALICE);
        vault.withdraw(1);

        // the curator calling through a rebalance is not paid (it is the curator)
        vault = _newVault(4e18);
        vm.warp(block.timestamp + 600);
        _setStartNav(vault.nav() - 1e18);
        uint256 cBefore = vault.balanceOf(CURATOR);
        vm.prank(CURATOR);
        vault.withdraw(1); // curator withdraw: no bounty, and no deficit/crystallize on itself
        assertGe(vault.balanceOf(CURATOR), cBefore, "curator carry reduced");
    }

    /// B: a fired vault whose fire-time park failed still takes in-kind deposits (no deficit/floor gate,
    /// no parked check), so a newcomer buys into the fired curator's narrow range with < half-floor bond.
    function test_B_depositIntoFiredUnparkedVault() public {
        vault = _newVault(0.6e18);
        int24 tick;
        for (uint256 epoch; epoch < 12 && !vault.fired(); ++epoch) {
            _recenter(vault, 120);
            for (uint256 i; i < 10; ++i) {
                tick += 100;
                _moveTo(tick);
            }
            vm.warp(block.timestamp + 600);
            vm.mockCallRevert(address(hook), abi.encodeWithSelector(HurdleHook.referenceTick.selector), "");
            vault.settle();
            vm.clearMockedCalls();
        }
        assertTrue(vault.fired(), "never fired");
        (int24 lo, int24 hi,) = vault.position();
        assertTrue(lo != TickMath.minUsableTick(SPACING), "parked");
        console2.log("range width ticks", uint256(int256(hi - lo)));

        // Same block as the firing settle: the window is open, but the vault is not parked.
        _fund(BOB, address(vault), 100e18, 100e18);
        uint256 shares = vault.totalSupply();
        vm.prank(BOB);
        vm.expectRevert(HurdleVault.NotParked.selector);
        vault.deposit(shares, 100e18, 100e18);

        // Once anyone parks it (permissionless after firing), deposits are accepted again, ungated by the deficit.
        for (uint256 i; i < 12; ++i) {
            vm.warp(block.timestamp + 1800); // TWAP catches up
            try vault.rebalance(0, 0) {} catch { break; }
        }
        (lo, hi,) = vault.position();
        assertEq(lo, TickMath.minUsableTick(SPACING), "not parked");
        vm.warp(block.timestamp + 600); // next epoch, then a deposit inside its window
        vault.settle();
        vm.prank(BOB);
        vault.deposit(shares / 100, 100e18, 100e18);
        assertEq(vault.balanceOf(BOB), shares / 100, "parked fired vault refused a deposit");
    }
}
