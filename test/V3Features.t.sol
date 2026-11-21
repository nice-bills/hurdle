// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {IHurdleVault} from "../src/IHurdleVault.sol";
import {HurdleVault} from "../src/HurdleVault.sol";
import {VaultFixture} from "./VaultFixture.sol";

/// v3: 10-min TWAP gate for rebalances/parks, settler bounty.
contract V3Features is VaultFixture {
    using PoolIdLibrary for *;
    using StateLibrary for IPoolManager;

    address constant KEEPER = address(0x4EE9);

    function _swapTo(int24 tick) internal {
        uint160 target = TickMath.getSqrtPriceAtTick(tick);
        (uint160 now_,,,) = manager.getSlot0(key.toId());
        swapRouter.swap(
            key,
            IPoolManager.SwapParams(target < now_, -int256(1e30), target),
            PoolSwapTest.TestSettings(false, false),
            ZERO_BYTES
        );
    }

    function _roundTrip(uint256 amt) internal {
        (uint160 s0,,,) = manager.getSlot0(key.toId());
        swapRouter.swap(
            key,
            IPoolManager.SwapParams(true, -int256(amt), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false),
            ZERO_BYTES
        );
        swapRouter.swap(
            key, IPoolManager.SwapParams(false, -int256(1e30), s0), PoolSwapTest.TestSettings(false, false), ZERO_BYTES
        );
    }

    /// A real move, then the price stays: 11 minutes later the 30-min TWAP still lags by more than
    /// maxTickDeviation (the old gate would refuse), but the 10-min TWAP has caught up, so the curator
    /// can re-center.
    function test_rebalanceMinutesAfterRealMove() public {
        vault = _newVault(1e18);
        _recenter(vault, 60);
        _swapTo(130);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 660);
        _swapTo(131); // first swap of the block records the block-open reference tick (130)
        int24 t30 = hook.twapTick(key.toId());
        int24 t10 = hook.consult(key.toId(), 600);
        emit log_named_int("30-min TWAP", t30);
        emit log_named_int("10-min TWAP", t10);
        assertGt(_currentTick() - t30, 50, "30-min TWAP should lag beyond maxTickDeviation");
        assertLe(_currentTick() - t10, 50);
        int24 c = _floorTick();
        vm.prank(CURATOR);
        vault.rebalance(c - 60, c + 60);
        (int24 lo, int24 hi,) = vault.position();
        assertEq(lo, c - 60, "not re-centered");
        assertEq(hi, c + 60, "not re-centered");
    }

    /// The 10- and 30-min TWAPs must agree within MAX_REBALANCES_PER_EPOCH x maxTickDeviation (200 ticks
    /// here): a 10-min price hold far from the 30-min mean cannot open the gate.
    function test_rebalanceRevertsWhenShortAndLongTwapDisagree() public {
        vault = _newVault(1e18);
        _recenter(vault, 60);
        _swapTo(450);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 700);
        _swapTo(451);
        int24 d = hook.consult(key.toId(), 600) - hook.twapTick(key.toId());
        assertGt(d, 200, "scenario: TWAPs must disagree");
        int24 c = _floorTick();
        vm.prank(CURATOR);
        vm.expectRevert(HurdleVault.PriceDeviation.selector);
        vault.rebalance(c - 60, c + 60);
    }

    function _aheadAtEpochEnd() internal {
        vault = _newVault(1e18);
        _recenter(vault, 600);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 10);
        for (uint256 i; i < 4; ++i) _roundTrip(5e18);
        vm.roll(block.number + 1);
        vm.warp(vault.epochStart() + vault.epochSeconds());
    }

    /// A keeper's on-schedule settle() earns SETTLER_BOUNTY_BPS of the carry, taken from the curator only:
    /// depositors' value is the same as when the curator settles.
    function test_settlerBountyFromCarryOnly() public {
        _aheadAtEpochEnd();
        uint256 snap = vm.snapshotState();

        vm.prank(CURATOR);
        vault.settle();
        uint256 aliceByCurator = vault.balanceOf(ALICE) * vault.nav() / vault.totalSupply();
        uint256 curatorAlone = vault.balanceOf(CURATOR);
        assertGt(curatorAlone, 0, "scenario: no carry");

        vm.revertToState(snap);
        vm.recordLogs();
        vm.prank(KEEPER);
        vault.settle();
        uint256 aliceByKeeper = vault.balanceOf(ALICE) * vault.nav() / vault.totalSupply();
        uint256 bounty = vault.balanceOf(KEEPER);
        assertEq(bounty, curatorAlone * vault.SETTLER_BOUNTY_BPS() / 10_000, "bounty != 5% of carry shares");
        assertEq(vault.balanceOf(CURATOR) + bounty, curatorAlone, "bounty not taken from the curator");
        assertEq(aliceByKeeper, aliceByCurator, "depositor value changed by the bounty");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IHurdleVault.SettlerPaid.selector) seen = true;
        }
        assertTrue(seen, "SettlerPaid not emitted");
    }

    /// Settlements triggered inside withdraw / rebalance pay no bounty (only the scheduled settle() does).
    function test_noBountyOnImplicitSettle() public {
        _aheadAtEpochEnd();
        uint256 shares = vault.balanceOf(ALICE) / 10;
        vm.prank(ALICE);
        vault.withdraw(shares);
        assertGt(vault.balanceOf(CURATOR), 0, "scenario: no carry");
        assertEq(vault.balanceOf(ALICE) + vault.balanceOf(CURATOR) + vault.bondShares() + 1000, vault.totalSupply());
    }
}
