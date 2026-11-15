// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {HurdleHook} from "../src/HurdleHook.sol";
import {HurdleVault} from "../src/HurdleVault.sol";
import {IHurdleVault} from "../src/IHurdleVault.sol";
import {HookMiner} from "./utils/HookMiner.sol";

contract HurdleVaultTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    int24 constant SPACING = 60;
    address constant CURATOR = address(0xC0);
    address constant ALICE = address(0xA1);

    HurdleHook hook;
    HurdleVault vault;

    function setUp() public {
        vm.warp(1_000_000);
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        uint160 flags = uint160(
            Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
                | Hooks.AFTER_INITIALIZE_FLAG
        );
        (, bytes32 salt) = HookMiner.find(address(this), flags, type(HurdleHook).creationCode, abi.encode(manager));
        hook = new HurdleHook{salt: salt}(manager);

        // Background passive LP so swaps have depth outside the vault's range.
        LIQUIDITY_PARAMS = IPoolManager.ModifyLiquidityParams(
            TickMath.minUsableTick(SPACING), TickMath.maxUsableTick(SPACING), 100e18, 0
        );
        (key,) = initPoolAndAddLiquidity(currency0, currency1, IHooks(address(hook)), 3000, SQRT_PRICE_1_1);
    }

    // ---------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------

    function _newVault(uint256 bondAmount) internal returns (HurdleVault v) {
        v = new HurdleVault(manager, key, CURATOR, 2000, 200, 2000);
        _fund(ALICE, address(v), 10e18, 10e18);
        vm.prank(ALICE);
        v.deposit(10e18, 10e18);
        _fund(CURATOR, address(v), 0, bondAmount);
        vm.prank(CURATOR);
        v.postBond(bondAmount);
    }

    function _fund(address who, address spender, uint256 a0, uint256 a1) internal {
        MockERC20(Currency.unwrap(currency0)).transfer(who, a0);
        MockERC20(Currency.unwrap(currency1)).transfer(who, a1);
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(spender, type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(spender, type(uint256).max);
        vm.stopPrank();
    }

    /// Swap the pool to `tick` (exact price), then let 60s pass.
    function _moveTo(int24 tick) internal {
        uint160 target = TickMath.getSqrtPriceAtTick(tick);
        (uint160 now_,,,) = manager.getSlot0(key.toId());
        if (target != now_) {
            swapRouter.swap(
                key,
                IPoolManager.SwapParams(target < now_, -int256(1e30), target),
                PoolSwapTest.TestSettings(false, false),
                ZERO_BYTES
            );
        }
        vm.warp(block.timestamp + 60);
    }

    function _settled(HurdleVault v)
        internal
        returns (uint256 nav, uint256 bench, uint256 carry, uint256 paid)
    {
        vm.recordLogs();
        v.settle();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IHurdleVault.Settled.selector) {
                (nav, bench, carry, paid,,) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint160));
            }
        }
    }

    function _currentTick() internal view returns (int24 t) {
        (, t,,) = manager.getSlot0(key.toId());
    }

    function _recenter(HurdleVault v, int24 halfWidth) internal {
        int24 c = (_currentTick() / SPACING) * SPACING;
        vm.prank(CURATOR);
        v.rebalance(c - halfWidth, c + halfWidth);
    }

    // ---------------------------------------------------------------------
    // tests
    // ---------------------------------------------------------------------

    /// A vault that just sits full range IS the benchmark: no carry, no shortfall (within 1 bp).
    function test_passiveVaultSettlesAtPar() public {
        vault = _newVault(1e18);
        vm.prank(CURATOR);
        vault.rebalance(TickMath.minUsableTick(SPACING), TickMath.maxUsableTick(SPACING));
        for (uint256 i; i < 40; ++i) {
            _moveTo(i % 2 == 0 ? int24(int256(i) * 30) : -int24(int256(i) * 20));
        }
        (uint256 nav, uint256 bench,,) = _settled(vault);
        uint256 diff = nav > bench ? nav - bench : bench - nav;
        assertLe(diff * 10_000, nav, "passive vault drifts from par by > 1 bp");
    }

    /// Chaser: narrow range, re-centered on a trend. Trails par; bond pays depositors up to par.
    function test_chaserShortfallPaidFromBond() public {
        vault = _newVault(3e18);
        _recenter(vault, 120);
        for (uint256 i = 1; i <= 30; ++i) {
            _moveTo(int24(int256(i) * 100));
            if (i % 3 == 0) _recenter(vault, 120);
        }
        uint256 bondBefore = vault.bond();
        (uint256 nav, uint256 bench, uint256 carry, uint256 paid) = _settled(vault);
        assertEq(carry, 0);
        assertGt(paid, 0, "chaser should trail par");
        assertEq(bondBefore - vault.bond(), paid);
        assertEq(nav, bench, "depositors made whole to par");
        assertFalse(vault.fired());
    }

    /// Patient: tight range in a choppy, flat market earns concentrated fees, beats par, earns carry.
    function test_patientBeatsParAndEarnsCarry() public {
        vault = _newVault(1e18);
        _recenter(vault, 600);
        for (uint256 i; i < 60; ++i) {
            _moveTo(i % 2 == 0 ? int24(300) : int24(-300));
        }
        _moveTo(0);
        (uint256 nav, uint256 bench, uint256 carry, uint256 paid) = _settled(vault);
        assertEq(paid, 0);
        assertGt(nav, bench, "patient should beat par");
        assertApproxEqAbs(carry, (nav - bench) * 2000 / 10_000, 1);
        // Curator's new shares are worth exactly the carry.
        uint256 curatorValue = vault.balanceOf(CURATOR) * nav / vault.totalSupply();
        assertApproxEqRel(curatorValue, carry, 1e12);
    }

    /// Bond exhausted => fired, parked full range, curator locked out, anyone can re-park.
    function test_fireRule() public {
        vault = _newVault(0.25e18); // 1.25% of NAV, below the 2% floor once any shortfall hits
        _recenter(vault, 120);
        for (uint256 i = 1; i <= 30; ++i) {
            _moveTo(int24(int256(i) * 100));
            if (i % 3 == 0) _recenter(vault, 120);
        }
        vault.settle();
        assertTrue(vault.fired());
        (int24 lo, int24 hi,) = vault.position();
        assertEq(lo, TickMath.minUsableTick(SPACING));
        assertEq(hi, TickMath.maxUsableTick(SPACING));
        vm.prank(CURATOR);
        vm.expectRevert(IHurdleVault.CuratorFired.selector);
        vault.postBond(1);
        vault.rebalance(0, 0); // anyone; range forced to full
    }

    /// A same-block spot manipulation before settle does not move the settlement price,
    /// and moves the curator's excess by far less than a spot-valued NAV would.
    function test_sameBlockManipulationDoesNotMoveSettlement() public {
        vault = _newVault(1e18);
        _recenter(vault, 600);
        for (uint256 i; i < 40; ++i) _moveTo(i % 2 == 0 ? int24(300) : int24(-300));

        uint256 snap = vm.snapshotState();
        vm.recordLogs();
        vault.settle();
        (uint256 navClean, uint256 benchClean,,, , uint160 pClean) = _lastSettled();
        vm.revertToState(snap);

        uint256 spotNavBefore = vault.navAt(TickMath.getSqrtPriceAtTick(_currentTick()));
        swap(key, false, 5e18, ZERO_BYTES); // pump token1 price-of-token0 up hard, same block
        uint256 spotNavAfter = vault.navAt(TickMath.getSqrtPriceAtTick(_currentTick()));
        vm.recordLogs();
        vault.settle();
        (uint256 navAtk, uint256 benchAtk,,,, uint160 pAtk) = _lastSettled();

        assertEq(pAtk, pClean, "settlement price moved");
        int256 excessShift = (int256(navAtk) - int256(benchAtk)) - (int256(navClean) - int256(benchClean));
        uint256 spotShift = spotNavAfter > spotNavBefore ? spotNavAfter - spotNavBefore : spotNavBefore - spotNavAfter;
        assertLt(_abs(excessShift) * 20, spotShift, "excess moved by more than 5% of the spot-valued shift");
    }

    function test_depositWithdrawProRata() public {
        vault = _newVault(1e18);
        _recenter(vault, 600);
        _moveTo(120);
        uint256 shares = vault.balanceOf(ALICE);
        vm.prank(ALICE);
        (uint256 a0, uint256 a1) = vault.withdraw(shares / 2);
        assertGt(a0 + a1, 0);
        assertEq(vault.balanceOf(ALICE), shares - shares / 2);
        (,, uint128 liq) = vault.position();
        assertGt(liq, 0);
    }

    function _lastSettled() internal returns (uint256 nav, uint256 bench, uint256 carry, uint256 paid, uint256 b, uint160 p) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IHurdleVault.Settled.selector) {
                (nav, bench, carry, paid, b, p) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint160));
            }
        }
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return uint256(x >= 0 ? x : -x);
    }
}
