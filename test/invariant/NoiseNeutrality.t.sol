// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {HurdleVault} from "../../src/HurdleVault.sol";
import {VaultFixture} from "../VaultFixture.sol";

/// Audit 3 invariant 2, noise neutrality: a miss of m followed by a beat of m on a constant NAV (par is set
/// directly through start.nav, so no swaps) leaves depositor and curator values unchanged up to rounding and
/// the genuine carry on the beat (m^2/N per cycle, at most carry x that). Fuzzes m and the curator's share.
contract NoiseNeutralityTest is VaultFixture {
    uint256 constant SLOT_START_NAV = 13;

    function _setStartNav(uint256 v) internal {
        vm.store(address(vault), bytes32(SLOT_START_NAV), bytes32(v));
    }

    function _val(address who) internal view returns (uint256) {
        return vault.balanceOf(who) * vault.nav() / vault.totalSupply();
    }

    function testFuzz_noiseNeutrality(uint256 mSeed, uint256 curatorPct, uint8 cycles) public {
        curatorPct = bound(curatorPct, 1, 90); // curator's in-kind co-investment, % of Alice's shares
        uint256 m = bound(mSeed, 1e15, 2.5e18);
        cycles = uint8(bound(cycles, 1, 6));
        vault = _newVault(4e18); // NAV 20e18, bond 4e18
        uint256 a = vault.balanceOf(ALICE);
        uint256 cShares = a * curatorPct / 100;
        _fund(CURATOR, address(vault), 50e18, 50e18);
        vm.prank(CURATOR);
        vault.deposit(cShares, 50e18, 50e18);

        uint256 alice0 = _val(ALICE);
        uint256 cur0 = _val(CURATOR) + vault.bondValue();
        uint256 nav = vault.nav();
        for (uint256 i; i < cycles; ++i) {
            vm.warp(block.timestamp + 600);
            _setStartNav(vault.nav() + m);
            vm.prank(CURATOR);
            vault.settle(); // miss m
            vm.warp(block.timestamp + 600);
            _setStartNav(vault.nav() - m);
            vm.prank(CURATOR);
            vault.settle(); // beat m
            assertEq(vault.deficit(), 0, "deficit not repaid");
        }
        // genuine carry on the beat: at most m^2/N per cycle (the bond shares are burned in between)
        uint256 carryCap = uint256(cycles) * (m * m / nav) + 1e6;
        uint256 alice1 = _val(ALICE);
        uint256 cur1 = _val(CURATOR) + vault.bondValue();
        assertLe(alice1, alice0 + 1e6, "depositor gained from noise");
        assertGe(alice1 + carryCap, alice0, "depositor lost more than carry");
        assertLe(cur1, cur0 + carryCap, "curator gained more than carry");
        assertGe(cur1 + 1e6, cur0, "curator paid for noise");
    }
}
