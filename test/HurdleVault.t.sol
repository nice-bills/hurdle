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
            Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_DONATE_FLAG
        );
        (, bytes32 salt) = HookMiner.find(address(this), flags, type(HurdleHook).creationCode, abi.encode(manager));
        hook = new HurdleHook{salt: salt}(manager);

        // Background passive LP so swaps have depth outside the vault's range.
        LIQUIDITY_PARAMS = IPoolManager.ModifyLiquidityParams(
            TickMath.minUsableTick(SPACING), TickMath.maxUsableTick(SPACING), 2000e18, 0
        );
        (key,) = initPoolAndAddLiquidity(currency0, currency1, IHooks(address(hook)), 3000, SQRT_PRICE_1_1);
    }

    // ---------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------

    function _newVault(uint256 bondAmount) internal returns (HurdleVault v) {
        return _newVault(bondAmount, 50);
    }

    function _newVault(uint256 bondAmount, int24 maxDev) internal returns (HurdleVault v) {
        v = new HurdleVault(manager, key, CURATOR, 2000, 200, maxDev, 600);
        _fund(CURATOR, address(v), 0, bondAmount);
        vm.prank(CURATOR);
        v.postBond(bondAmount);
        _fund(ALICE, address(v), 10e18, 10e18);
        vm.prank(ALICE);
        v.deposit(10e18, 10e18);
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

    /// Chaser: narrow range, re-centered on a trend. Every settlement along the way (rebalances
    /// settle a finished epoch first) pays depositors up to par from the bond.
    function test_chaserShortfallPaidFromBond() public {
        vault = _newVault(6e18);
        uint256 bond0 = vault.bond();
        vm.recordLogs();
        _recenter(vault, 120);
        for (uint256 i = 1; i <= 30; ++i) {
            _moveTo(int24(int256(i) * 100));
            if (i % 3 == 0) _chase(vault, 240);
        }
        vm.warp(block.timestamp + 600);
        vault.settle();
        (uint256 totalPaid, uint256 n) = _checkSettlements();
        assertGt(n, 5);
        assertGt(totalPaid, 0, "chaser should trail par");
        assertEq(bond0 - vault.bond(), totalPaid, "bond pays exactly the shortfalls");
        assertFalse(vault.fired());
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

    /// Multi-epoch: every settle pays min(shortfall, bond); bond exhausted => fired, parked full range,
    /// curator locked out; anyone can finish the park once, then it is closed.
    function test_fireRule() public {
        vault = _newVault(0.6e18);
        vm.recordLogs();
        int24 tick;
        for (uint256 epoch; epoch < 12 && !vault.fired(); ++epoch) tick = _losingEpoch(tick);
        (uint256 totalPaid,) = _checkSettlements();
        assertGt(totalPaid, 0);
        assertTrue(vault.fired(), "never fired");
        (int24 lo, int24 hi,) = vault.position();
        assertEq(lo, TickMath.minUsableTick(SPACING));
        assertEq(hi, TickMath.maxUsableTick(SPACING));
        vm.prank(CURATOR);
        vm.expectRevert(IHurdleVault.CuratorFired.selector);
        vault.postBond(1);
        // Anyone may finish the park. Each call's swap is impact-bounded, so a large vault parks over
        // several calls as arbitrage restores the price (simulated by _moveTo).
        for (uint256 i; i < 20; ++i) {
            _moveTo(tick);
            try vault.rebalance(0, 0) {}
            catch (bytes memory e) {
                assertEq(bytes4(e), HurdleVault.AlreadyParked.selector);
                break;
            }
        }
        vm.expectRevert(HurdleVault.AlreadyParked.selector);
        vault.rebalance(0, 0);
    }

    /// A curator who loses one epoch then wins earns the shortfall back before any carry.
    function test_deficitRecoupedBeforeCarry() public {
        vault = _newVault(6e18);
        vm.recordLogs();
        _losingEpoch(0);
        (uint256 paid,) = _checkSettlements();
        assertGt(paid, 0);
        assertFalse(vault.fired());
        assertEq(vault.deficit(), paid);
        // Epoch 2: range just below spot, harvest chop inside it, end where it started.
        int24 c = _floorTick();
        vm.prank(CURATOR);
        vault.rebalance(c - 240, c);
        for (uint256 i; i < 80; ++i) _moveTo(i % 2 == 0 ? c - 200 : c - 40);
        _moveTo(c);
        (uint256 nav, uint256 bench, uint256 carry,) = _settled(vault);
        assertGt(nav, bench, "second epoch should beat par");
        uint256 excess = nav - bench;
        uint256 recoup = excess < paid ? excess : paid;
        assertEq(vault.deficit(), paid - recoup);
        assertApproxEqAbs(carry, recoup + (excess - recoup) * 2000 / 10_000, 1);
        // The recoup refilled the bond as locked shares, not free curator shares.
        assertGt(vault.bondShares(), 0, "recoup should mint bond shares");

        // Epoch 3 loses again: bond shares are burned before any bond tokens move.
        uint256 bondTokens = vault.bond();
        uint256 bShares = vault.bondShares();
        vm.recordLogs();
        _losingEpoch(c);
        (uint256 paid3,) = _checkSettlements(false); // bond shares absorb their own share of the miss
        assertGt(paid3, 0, "epoch 3 should trail par");
        assertLt(vault.bondShares(), bShares, "bond shares not burned first");
        if (vault.bondShares() > 0) assertEq(vault.bond(), bondTokens, "tokens moved before shares ran out");
    }

    /// Sanity: a par-tracking (full range) curator settling every epoch keeps its bond.
    /// The refill path itself is covered by test_deficitRecoupedBeforeCarry.
    function test_parTrackingCuratorKeepsBond() public {
        vault = _newVault(1e18);
        vm.prank(CURATOR);
        vault.rebalance(TickMath.minUsableTick(SPACING), TickMath.maxUsableTick(SPACING));
        uint256 bond0 = vault.bondValue();
        int24 tick;
        for (uint256 epoch; epoch < 24; ++epoch) {
            for (uint256 i; i < 12; ++i) {
                tick = int24(int256(uint256(keccak256(abi.encode(epoch, i))) % 1200)) - 600;
                _moveTo(tick);
            }
            vm.warp(block.timestamp + 600);
            vault.settle();
        }
        assertFalse(vault.fired());
        // A par-tracking curator ends with its bond intact to within rounding (1 bp of NAV).
        assertApproxEqAbs(vault.bondValue(), bond0, vault.nav() / 10_000);
    }

    /// After firing, the vault is parked 50/50 full range, so from then on it tracks par.
    function test_firedVaultTracksPar() public {
        vault = _newVault(0.6e18);
        int24 tick;
        for (uint256 epoch; epoch < 12 && !vault.fired(); ++epoch) tick = _losingEpoch(tick);
        assertTrue(vault.fired());
        _moveTo(tick);
        try vault.rebalance(0, 0) {} catch {} // finish the park if the fire-time park hit its bound
        (,, uint128 liq) = vault.position();
        (uint160 sp,,,) = manager.getSlot0(key.toId());
        uint256 idle0 = MockERC20(Currency.unwrap(currency0)).balanceOf(address(vault));
        uint256 idle1 = MockERC20(Currency.unwrap(currency1)).balanceOf(address(vault)) - vault.bond();
        uint256 idle = idle0 * uint256(sp) / (1 << 96) * uint256(sp) / (1 << 96) + idle1;
        assertLt(idle * 100, (_positionValue(vault, liq) + idle) * 2, "fired vault left > 2% idle");
        vm.warp(block.timestamp + 600);
        vault.settle(); // start a clean epoch from the parked state
        for (uint256 i; i < 30; ++i) _moveTo(tick + (i % 2 == 0 ? int24(800) : int24(-500)));
        (uint256 nav, uint256 bench,,) = _settled(vault);
        uint256 diff = nav > bench ? nav - bench : bench - nav;
        assertLe(diff * 10_000, nav * 10, "fired vault drifts from par by > 10 bp");
    }

    /// The cap that bounds sandwich losses per epoch: a 5th rebalance in one epoch reverts.
    function test_rebalancesCappedPerEpoch() public {
        vault = _newVault(1e18);
        vm.startPrank(CURATOR);
        for (uint256 i; i < 4; ++i) vault.rebalance(-600 - int24(int256(i)) * 60, 600);
        vm.expectRevert(HurdleVault.TooManyRebalances.selector);
        vault.rebalance(-600, 600);
        vm.stopPrank();
        vm.warp(block.timestamp + 600); // next epoch: rebalance settles first and resets the count
        vm.prank(CURATOR);
        vault.rebalance(-600, 600);
        assertEq(vault.rebalancesThisEpoch(), 1);
    }

    /// Unsafe configs (sandwich budget per epoch above the bond floor) cannot be deployed.
    function test_constructorRejectsUnsafeDeviation() public {
        vm.expectRevert(bytes("DEV"));
        new HurdleVault(manager, key, CURATOR, 2000, 200, 51, 600);
    }

    /// A newcomer cannot buy in below par and collect a top-up for a shortfall that predates them:
    /// mid-epoch, with the vault trailing par, shares are priced at par (fewer than NAV pricing gives).
    function test_depositPricedAtParWhenTrailing() public {
        vault = _newVault(6e18);
        _recenter(vault, 120);
        vm.warp(block.timestamp + 600);
        vault.settle();
        int24 c = _currentTick();
        swapRouter.swap(
            key,
            IPoolManager.SwapParams(false, -int256(1e30), TickMath.getSqrtPriceAtTick(c + 45)),
            PoolSwapTest.TestSettings(false, false),
            ZERO_BYTES
        );
        vm.warp(block.timestamp + 300); // still inside the 600s epoch
        uint256 navNow = vault.nav();
        uint256 supply = vault.totalSupply();
        uint160 s = TickMath.getSqrtPriceAtTick(hook.twapTick(key.toId()));
        uint256 value = uint256(1e18) * s / (1 << 96) * s / (1 << 96) + 1e18;
        address bob = address(0xB0B);
        _fund(bob, address(vault), 1e18, 1e18);
        vm.prank(bob);
        uint256 shares = vault.deposit(1e18, 1e18);
        assertLt(shares, value * supply / navNow, "priced at NAV although the vault trails par");
    }

    function _positionValue(HurdleVault v, uint128 liq) internal view returns (uint256) {
        (int24 lo, int24 hi,) = v.position();
        (uint160 sp,,,) = manager.getSlot0(key.toId());
        (uint256 a0, uint256 a1) = LiquidityAmounts.getAmountsForLiquidity(
            sp, TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), liq
        );
        return a0 * uint256(sp) / (1 << 96) * uint256(sp) / (1 << 96) + a1;
    }

    /// Mid-epoch withdrawal gets its pro-rata share of accrued fees, not all of them.
    function test_midEpochWithdrawGetsProRataFees() public {
        vault = _newVault(1e18);
        address bob = address(0xB0B);
        _fund(bob, address(vault), 10e18, 10e18);
        vm.prank(bob);
        vault.deposit(10e18, 10e18);
        _recenter(vault, 600);
        vm.warp(block.timestamp + 600);
        vault.settle();
        for (uint256 i; i < 6; ++i) _moveTo(i % 2 == 0 ? int24(300) : int24(-300));
        _moveTo(0);

        // Two equal withdrawals back to back must be worth the same: the first must not take all accrued fees.
        uint256 shares = vault.balanceOf(bob) / 100;
        vm.prank(bob);
        (uint256 b0, uint256 b1) = vault.withdraw(shares);
        vm.prank(ALICE);
        (uint256 c0, uint256 c1) = vault.withdraw(shares);
        (uint160 sp,,,) = manager.getSlot0(key.toId());
        uint256 first = b0 * uint256(sp) / (1 << 96) * uint256(sp) / (1 << 96) + b1;
        uint256 second = c0 * uint256(sp) / (1 << 96) * uint256(sp) / (1 << 96) + c1;
        assertApproxEqRel(first, second, 1e12);
    }

    function test_depositCappedByBond() public {
        vault = _newVault(1e18); // 1e18 bond, 2% floor => cap 50e18 NAV; 20e18 deposited
        _fund(ALICE, address(vault), 20e18, 20e18);
        vm.prank(ALICE);
        vm.expectRevert(HurdleVault.CapacityExceeded.selector);
        vault.deposit(20e18, 20e18);
    }

    function test_publicSettleGatedByEpoch() public {
        vault = _newVault(1e18);
        vm.expectRevert(HurdleVault.EpochNotOver.selector);
        vault.settle();
    }

    function test_rebalanceRevertsOnSpotDeviation() public {
        vault = _newVault(1e18, 50);
        for (uint256 i; i < 5; ++i) _moveTo(0);
        swap(key, false, 200e18, ZERO_BYTES); // same-block spot pump, TWAP unchanged
        vm.prank(CURATOR);
        vm.expectRevert(HurdleVault.PriceDeviation.selector);
        vault.rebalance(-600, 600);
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
