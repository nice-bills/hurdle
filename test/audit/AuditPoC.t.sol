// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {IHurdleVault} from "../../src/IHurdleVault.sol";
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

/// Independent audit PoCs, converted to regression tests: each keeps the PoC scenario and asserts the
/// attack no longer works (research/audit-fixes.md).
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
            Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_DONATE_FLAG
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
    // F1 (fixed): deposits are in kind and only in the settlement block, so a
    // deposit/withdraw round trip cannot trade with the vault at the stale TWAP.
    // Same honest -45 tick move with TWAP lagging, now timed to the epoch end.
    // -----------------------------------------------------------------------
    function test_F1_noArbDepositWithdrawInKind() public {
        vault = new HurdleVault(manager, key, CURATOR, 2000, 200, 50, 600);
        _fund(CURATOR, address(vault), 0, 2e18);
        vm.prank(CURATOR);
        vault.postBond(2e18);
        _fund(CURATOR, address(vault), 30e18, 30e18);
        vm.prank(CURATOR);
        vault.firstDeposit(30e18, 30e18, ALICE);
        vm.prank(CURATOR);
        vault.rebalance(TickMath.minUsableTick(SPACING), TickMath.maxUsableTick(SPACING));
        _fund(ARB, address(vault), 40e18, 40e18);

        // Mid-epoch, deposits are closed.
        vm.warp(block.timestamp + 588);
        vm.prank(ARB);
        vm.expectRevert(HurdleVault.DepositWindowClosed.selector);
        vault.deposit(1e18, 40e18, 40e18);

        // Honest market move: token0 drops 45 ticks. 12 s later TWAP has barely moved and the epoch is over.
        _swapTo(-45);
        vm.warp(block.timestamp + 12);
        int24 twap = hook.twapTick(key.toId());
        assertGe(twap, -1, "TWAP still ~0");
        assertEq(_spotTick(), -45);
        vault.settle();

        uint256 vaultBefore = _vaultSpotValue(vault);
        uint256 arbBefore = _valueAtSpot(t0.balanceOf(ARB), t1.balanceOf(ARB));
        vm.startPrank(ARB);
        for (uint256 i; i < 15; ++i) {
            uint256 s = vault.totalSupply() / 2;
            vault.deposit(s, 40e18, 40e18);
            vault.withdraw(s);
        }
        vm.stopPrank();
        uint256 arbAfter = _valueAtSpot(t0.balanceOf(ARB), t1.balanceOf(ARB));
        uint256 vaultAfter = _vaultSpotValue(vault);
        console2.log("arb P&L lost (token1 wei, at spot):", arbBefore - arbAfter);
        assertLe(arbAfter, arbBefore, "arb cannot profit");
        assertGe(vaultAfter, vaultBefore, "depositors lose nothing");
    }

    // -----------------------------------------------------------------------
    // F2 (fixed): rebalances require spot, the block-open referenceTick and the
    // TWAP to agree within maxTickDeviation, and the swap is bounded by both. While
    // TWAP lags the 800-tick rally, the curator's in-band push cannot make the vault
    // trade: every rebalance reverts, the vault keeps tracking par, the bond is intact.
    // -----------------------------------------------------------------------
    function test_F2_laggedTwapRebalanceBlocked() public {
        vault = new HurdleVault(manager, key, CURATOR, 2000, 200, 50, 600);
        _fund(CURATOR, address(vault), 0, 0.5e18);
        vm.prank(CURATOR);
        vault.postBond(0.5e18); // 2.5% of 20e18 NAV, above the 2% floor
        _fund(CURATOR, address(vault), 10e18, 10e18);
        vm.prank(CURATOR);
        vault.firstDeposit(10e18, 10e18, ALICE);
        vm.prank(CURATOR);
        vault.rebalance(TickMath.minUsableTick(SPACING), TickMath.maxUsableTick(SPACING));

        // Market: token0 rallies 800 ticks (~8.3%). 12 s later TWAP is ~5 ticks.
        _swapTo(800);
        vm.warp(block.timestamp + 12);
        int24 fair = _spotTick();
        uint256 honest = _vaultSpotValue(vault);

        uint256 me0 = t0.balanceOf(address(this));
        uint256 me1 = t1.balanceOf(address(this));
        for (uint256 i; i < 3; ++i) {
            int24 twap = hook.twapTick(key.toId());
            _swapTo(twap + 45); // into the TWAP band, but far from the block-open price
            int24 c = (twap / SPACING) * SPACING;
            vm.prank(CURATOR);
            vm.expectRevert(HurdleVault.PriceDeviation.selector);
            vault.rebalance(c - 6000, c - 3000);
        }
        _swapTo(fair);
        uint256 after_ = _vaultSpotValue(vault);
        int256 d0 = int256(t0.balanceOf(address(this))) - int256(me0);
        int256 d1 = int256(t1.balanceOf(address(this))) - int256(me1);
        (uint160 sp,,,) = manager.getSlot0(key.toId());
        int256 pnl = d1 + d0 * int256(uint256(sp)) / int256(1 << 96) * int256(uint256(sp)) / int256(1 << 96);
        console2.log("attacker P&L at fair (int) :");
        console2.logInt(pnl);
        assertGe(after_, honest, "vault lost value to the push");
        assertLt(pnl, 0, "attacker only paid fees");

        uint256 shortfallUnpaid;
        for (uint256 k; k < 2; ++k) {
            vm.warp(block.timestamp + 1800);
            _swapTo(fair == _spotTick() ? fair + 1 : fair);
            vm.recordLogs();
            vault.settle();
            Vm.Log[] memory logs = vm.getRecordedLogs();
            for (uint256 i; i < logs.length; ++i) {
                if (logs[i].topics[0] == IHurdleVault.Settled.selector) {
                    (uint256 nav, uint256 bench,, uint256 paid,,) =
                        abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint160));
                    console2.log("settle nav / bench / paid:", nav, bench, paid);
                    if (nav + paid < bench) shortfallUnpaid += bench - nav - paid;
                }
            }
        }
        // Only the curator's own carry shares (from the first settle) absorb a sliver of the second miss (F11).
        assertLt(shortfallUnpaid * 1e6, honest, "depositors at par");
        assertGt(vault.bond(), 0.49e18, "bond intact");
        assertFalse(vault.fired());
    }

    // -----------------------------------------------------------------------
    // F4 (fixed; was named F3 in the PoC): a newcomer buys in kind and only at
    // the settlement, after the bond has paid what it can, so it never pays par for
    // a guarantee the bond cannot cover; an exhausted bond means zero capacity.
    // The F2 extraction that set up the under-bonded state now reverts, so a
    // narrow range trended out of range produces the same ~4% miss vs a 2.5% bond.
    // -----------------------------------------------------------------------
    function test_F4_noDepositIntoUnderBondedVault() public {
        vault = new HurdleVault(manager, key, CURATOR, 2000, 200, 50, 7200);
        _fund(CURATOR, address(vault), 0, 0.5e18);
        vm.prank(CURATOR);
        vault.postBond(0.5e18);
        _fund(CURATOR, address(vault), 10e18, 10e18);
        vm.prank(CURATOR);
        vault.firstDeposit(10e18, 10e18, ALICE);
        vm.prank(CURATOR);
        vault.rebalance(-60, 60);
        _swapTo(800);
        vm.warp(block.timestamp + 1800);
        _swapTo(801); // TWAP catches up
        assertGt(_bench(), vault.nav() + vault.bond(), "shortfall exceeds the bond");

        address bob = address(0xB0B);
        _fund(bob, address(vault), 5e18, 5e18);
        vm.prank(bob);
        vm.expectRevert(HurdleVault.DepositWindowClosed.selector);
        vault.deposit(1e18, 5e18, 5e18);

        // At the settlement the bond pays what it can and the curator is fired: the shortfall it paid is
        // still owed to the bond (deficit), so the newcomer cannot buy into the guarantee at all.
        vm.warp(block.timestamp + 7200);
        uint256 shares = vault.totalSupply() / 10;
        vm.prank(bob);
        vm.expectRevert(HurdleVault.DeficitOutstanding.selector);
        vault.deposit(shares, 5e18, 5e18);
        vault.settle();
        assertTrue(vault.fired());
        assertEq(t0.balanceOf(bob), 5e18);
        assertEq(t1.balanceOf(bob), 5e18);
    }

    function _bench() internal view returns (uint256) {
        (uint64 ts, uint160 s0, uint256 f0, uint256 f1, uint256 n) = vault.start();
        (uint256 g0, uint256 g1) = manager.getFeeGrowthGlobals(key.toId());
        uint160 s1 = TickMath.getSqrtPriceAtTick(hook.twapTick(key.toId()));
        unchecked {
            return vault.benchmark(n, s0, s1, g0 - f0, g1 - f1, block.timestamp - ts);
        }
    }

    // -----------------------------------------------------------------------
    // F3 (bounded; was named F4 in the PoC): wash-swap fee growth. The benchmark's
    // fee credit is capped at MAX_FEE_APR_BPS (300% APR) of the epoch's starting
    // NAV, so the same one-block wash in a thin pool moves at most the cap
    // (~0.57 bp of NAV per 10-min epoch) out of the bond: the attacker, paying
    // the swap fees, loses. Residual: an attacker who is also the pool's only
    // other LP gets its fees back and nets up to the cap per epoch.
    // -----------------------------------------------------------------------
    function test_F3_washSwapBoundedByFeeCap() public {
        LIQUIDITY_PARAMS = IPoolManager.ModifyLiquidityParams(
            TickMath.minUsableTick(200), TickMath.maxUsableTick(200), 10e18, 0
        );
        (key,) = initPoolAndAddLiquidity(currency0, currency1, IHooks(address(hook)), 10000, SQRT_PRICE_1_1);
        for (uint256 i; i < 40; ++i) {
            vm.warp(block.timestamp + 60);
            _swapTo(i % 2 == 0 ? int24(1) : int24(0));
        }
        vm.warp(block.timestamp + 60);

        vault = new HurdleVault(manager, key, CURATOR, 2000, 200, 50, 600);
        _fund(CURATOR, address(vault), 0, 2e18);
        vm.prank(CURATOR);
        vault.postBond(2e18);
        _fund(CURATOR, address(vault), 5e18, 5e18);
        vm.prank(CURATOR);
        vault.firstDeposit(5e18, 5e18, ALICE);
        // Attacker = this contract (it also does the swaps). Joins in kind in the same (settlement) block.
        t0.approve(address(vault), type(uint256).max);
        t1.approve(address(vault), type(uint256).max);
        uint256 a0 = t0.balanceOf(address(this));
        uint256 a1 = t1.balanceOf(address(this));
        uint256 shares = 8 * vault.totalSupply();
        vault.deposit(shares, 41e18, 41e18);
        uint256 nav0 = vault.nav();
        vm.warp(block.timestamp + 600);

        (uint160 s0,,,) = manager.getSlot0(key.toId());
        for (uint256 i; i < 25; ++i) {
            swapRouter.swap(key, IPoolManager.SwapParams(true, -int256(2e18), MIN_PRICE_LIMIT),
                PoolSwapTest.TestSettings(false, false), ZERO_BYTES);
            swapRouter.swap(key, IPoolManager.SwapParams(false, -int256(1e30), s0),
                PoolSwapTest.TestSettings(false, false), ZERO_BYTES);
        }
        uint256 bondBefore = vault.bond();
        vault.settle();
        vault.withdraw(shares);
        int256 d0 = int256(t0.balanceOf(address(this))) - int256(a0);
        int256 d1 = int256(t1.balanceOf(address(this))) - int256(a1);
        int256 pnl = d0 + d1; // price is back at 1:1
        uint256 cap = nav0 * vault.MAX_FEE_APR_BPS() * 600 / (10_000 * 365 days);
        console2.log("bond paid out / cap:", bondBefore - vault.bond(), cap);
        console2.log("attacker P&L (token1 wei):");
        console2.logInt(pnl);
        assertLe(bondBefore - vault.bond(), cap + 1, "bond drain bounded by the fee cap");
        assertLt(pnl, 0, "wash trading is unprofitable");
        assertFalse(vault.fired());
    }
}
