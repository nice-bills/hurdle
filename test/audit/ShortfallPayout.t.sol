// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {HurdleVault} from "../../src/HurdleVault.sol";
import {VaultFixture} from "../VaultFixture.sol";

/// Luna v4 item 2: bond tokens paid into the vault are shared by every share, including the curator's free shares.
/// The payout is grossed up so depositors are made whole in the SAME settlement, with the curator holding 20% free.
contract ShortfallPayoutTest is VaultFixture {
    uint256 constant SLOT_START_NAV = 13;

    function _setStartNav(uint256 v) internal {
        vm.store(address(vault), bytes32(SLOT_START_NAV), bytes32(v));
    }

    function _val(address who) internal view returns (uint256) {
        return vault.balanceOf(who) * vault.nav() / vault.totalSupply();
    }

    /// Idle vault: Alice 80% of shares, curator 20% free shares (in-kind co-invest).
    function _curator20(uint256 bondAmount) internal {
        vault = _newVault(bondAmount);
        uint256 a = vault.balanceOf(ALICE);
        _fund(CURATOR, address(vault), 50e18, 50e18);
        vm.prank(CURATOR);
        vault.deposit(a / 4, 50e18, 50e18);
        assertApproxEqRel(vault.balanceOf(CURATOR) * 1e18 / vault.totalSupply(), 0.2e18, 1e14);
    }

    /// Returns Alice's value before, her value right after the settle (before any park swap), and the event's paid.
    function _miss(uint256 m) internal returns (uint256 aliceBefore, uint256 aliceAfter, uint256 curBefore) {
        vm.warp(block.timestamp + 600);
        aliceBefore = _val(ALICE);
        curBefore = _val(CURATOR) + vault.bondValue();
        _setStartNav(vault.nav() + m);
        vm.recordLogs();
        vm.prank(CURATOR);
        vault.settle();
        // The Settled event reports NAV before the payout and the value paid to depositors; a fired vault then parks
        // (a 50/50 swap with fees), so read depositors' result from the event, not post-park state.
        (uint256 nav,,, uint256 paid,,) = _lastSettled();
        nav;
        aliceAfter = aliceBefore + paid * vault.balanceOf(ALICE) / _depositorShares();
    }

    function _depositorShares() internal view returns (uint256) {
        return vault.totalSupply() - vault.bondShares() - vault.balanceOf(CURATOR);
    }

    /// Covered miss (bond > shortfall): Alice ends at par exactly (before + her 80% slice), not 80% short of it.
    function test_coveredMiss_depositorsAtPar_curatorHolds20pct() public {
        _curator20(4e18);
        uint256 m = 1e18; // 4% of NAV
        uint256 owed = m * vault.balanceOf(ALICE) / vault.totalSupply();
        (uint256 before, uint256 afterV, uint256 curBefore) = _miss(m);
        console2.log("alice before / after / par:", before, afterV);
        console2.log("owed:", owed);
        assertApproxEqAbs(afterV, before + owed, 1e6, "depositor not at par in the same settlement");
        assertApproxEqAbs(_val(ALICE), before + owed, 1e6, "depositor state not at par");
        // curator's own value (free shares + bond) falls by what depositors received, not more
        assertApproxEqAbs(_val(CURATOR) + vault.bondValue() + owed, curBefore, 1e6, "curator side moved more than owed");
    }

    /// Bond exactly the depositor-grossed need (= shortfall when no bond shares): still whole, bond used up.
    function test_coveredMiss_bondExactlyNeeded() public {
        _curator20(1e18);
        uint256 m = 1e18 - 1e6; // needs ~ m tokens of bond; bond is 1e18
        uint256 owed = m * vault.balanceOf(ALICE) / vault.totalSupply();
        (uint256 before, uint256 afterV,) = _miss(m);
        assertApproxEqAbs(afterV, before + owed, 1e6, "depositor not at par with bond ~= shortfall");
    }

    /// A bond worth only the depositors' slice (owed) is NOT covered: depositors end short by ~curator fraction.
    function test_bondEqualsOwed_isNotCovered_shortByCuratorFraction() public {
        _curator20(0.8e18 + 1e6);
        uint256 m = 1e18;
        uint256 owed = m * vault.balanceOf(ALICE) / vault.totalSupply();
        (uint256 before, uint256 afterV,) = _miss(m);
        uint256 got = afterV - before;
        console2.log("owed / received:", owed, got);
        assertLt(got, owed, "expected a partial payout");
        assertApproxEqRel(got, owed * 80 / 100, 2e16, "received ~ 80% of owed (depositor fraction)");
    }

    /// Fired in the same settlement (bond drained below half the floor): depositors are still made whole first.
    function test_firedVault_depositorsWholeInThatSettlement() public {
        _curator20(1e18);
        uint256 m = 1e18 - 1e6;
        uint256 owed = m * vault.balanceOf(ALICE) / vault.totalSupply();
        (uint256 before, uint256 afterV,) = _miss(m);
        assertTrue(vault.fired(), "should fire");
        assertApproxEqAbs(afterV, before + owed, 1e6, "depositor not at par in fired settlement");
    }
}
