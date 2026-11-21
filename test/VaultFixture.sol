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
import {LiquidityAmounts} from "v4-core/test/utils/LiquidityAmounts.sol";

/// Shared setUp and helpers for the vault tests (no tests here, so inheriting suites do not rerun each other).
abstract contract VaultFixture is Test, Deployers {
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
            Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_DONATE_FLAG
        );
        (, bytes32 salt) = HookMiner.find(address(this), flags, type(HurdleHook).creationCode, abi.encode(manager));
        hook = new HurdleHook{salt: salt}(manager);

        // Background passive LP so swaps have depth outside the vault's range.
        LIQUIDITY_PARAMS = IPoolManager.ModifyLiquidityParams(
            TickMath.minUsableTick(SPACING), TickMath.maxUsableTick(SPACING), 2000e18, 0
        );
        (key,) = initPoolAndAddLiquidity(currency0, currency1, IHooks(address(hook)), 3000, SQRT_PRICE_1_1);
        vm.warp(block.timestamp + 600); // the hook's TWAP needs 10 min of history
    }

    // ---------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------

    function _newVault(uint256 bondAmount) internal returns (HurdleVault v) {
        return _newVault(bondAmount, 50);
    }

    function _newVault(uint256 bondAmount, int24 maxDev) internal returns (HurdleVault v) {
        return _newVault(bondAmount, maxDev, 600);
    }

    function _newVault(uint256 bondAmount, int24 maxDev, uint32 epoch) internal returns (HurdleVault v) {
        v = new HurdleVault(manager, key, CURATOR, 2000, 200, maxDev, epoch);
        _fund(CURATOR, address(v), 0, bondAmount);
        vm.prank(CURATOR);
        v.postBond(bondAmount);
        _fund(CURATOR, address(v), 10e18, 10e18);
        vm.prank(CURATOR);
        v.firstDeposit(10e18, 10e18, ALICE);
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
        // Hold each price for a full TWAP window, so TWAP has caught up when the curator acts
        // (rebalances require |spot - TWAP| <= 50 ticks).
        vm.warp(block.timestamp + 1800);
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

    function _floorTick() internal view returns (int24 c) {
        int24 t = _currentTick();
        c = (t / SPACING) * SPACING;
        if (t < 0 && t % SPACING != 0) c -= SPACING;
    }

    function _recenter(HurdleVault v, int24 halfWidth) internal {
        int24 c = _floorTick();
        vm.prank(CURATOR);
        v.rebalance(c - halfWidth, c + halfWidth);
    }

    /// Chaser re-anchor without swaps: a range just below spot if it mostly holds token1, just above if token0.
    function _chase(HurdleVault v, int24 width) internal {
        (int24 lo, int24 hi, uint128 liq) = v.position();
        (uint160 sp,,,) = manager.getSlot0(key.toId());
        (uint256 a0, uint256 a1) = LiquidityAmounts.getAmountsForLiquidity(
            sp, TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), liq
        );
        a0 += MockERC20(Currency.unwrap(currency0)).balanceOf(address(v));
        a1 += MockERC20(Currency.unwrap(currency1)).balanceOf(address(v)) - v.bond();
        uint256 v0 = a0 * uint256(sp) / (1 << 96) * uint256(sp) / (1 << 96);
        int24 c = _floorTick();
        vm.prank(CURATOR);
        if (v0 > a1) v.rebalance(c + SPACING, c + SPACING + width);
        else v.rebalance(c - width, c);
        (,, uint128 newLiq) = v.position();
        assertGt(newLiq, 0, "chaser deployed nothing");
    }

    /// Reads every Settled event since recordLogs and checks the settlement rules on each.
    function _checkSettlements() internal returns (uint256 totalPaid, uint256 n) {
        return _checkSettlements(true);
    }

    /// strict: no bond shares existed, so each shortfall is paid in full (nav + paid == bench) while bond lasts.
    function _checkSettlements(bool strict) internal returns (uint256 totalPaid, uint256 n) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != IHurdleVault.Settled.selector) continue;
            (uint256 nav, uint256 bench, uint256 take, uint256 paid, uint256 bondV,) =
                abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint160));
            ++n;
            totalPaid += paid;
            if (nav >= bench) {
                assertEq(paid, 0, "paid while at/above par");
            } else {
                assertEq(take, 0, "curator paid while below par");
                if (strict) {
                    assertTrue(nav + paid == bench || bondV == 0, "shortfall not fully paid while bond remained");
                }
            }
        }
    }

    /// One narrow re-center per epoch on a steady trend.
    function _losingEpoch(int24 tick) internal returns (int24) {
        _recenter(vault, 120);
        for (uint256 i; i < 10; ++i) {
            tick += 100;
            _moveTo(tick);
        }
        vm.warp(block.timestamp + 600);
        vault.settle();
        return tick;
    }

    function _benchNow() internal view returns (uint256) {
        (uint64 ts, uint160 s0, uint256 f0, uint256 f1, uint256 n) = vault.start();
        (uint256 g0, uint256 g1) = manager.getFeeGrowthGlobals(key.toId());
        uint160 s1 = TickMath.getSqrtPriceAtTick(hook.twapTick(key.toId()));
        unchecked {
            return vault.benchmark(n, s0, s1, g0 - f0, g1 - f1, block.timestamp - ts);
        }
    }

    function _positionValue(HurdleVault v, uint128 liq) internal view returns (uint256) {
        (int24 lo, int24 hi,) = v.position();
        (uint160 sp,,,) = manager.getSlot0(key.toId());
        (uint256 a0, uint256 a1) = LiquidityAmounts.getAmountsForLiquidity(
            sp, TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), liq
        );
        return a0 * uint256(sp) / (1 << 96) * uint256(sp) / (1 << 96) + a1;
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
