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

import {VaultFixture} from "./VaultFixture.sol";

contract HurdleVaultTest is VaultFixture {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

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
        // The settle was called by a third party (this test contract): it gets SETTLER_BOUNTY_BPS of the carry.
        uint256 curatorValue = vault.balanceOf(CURATOR) * nav / vault.totalSupply();
        uint256 settlerValue = vault.balanceOf(address(this)) * nav / vault.totalSupply();
        assertApproxEqRel(curatorValue + settlerValue, carry, 1e12);
        assertApproxEqRel(settlerValue, carry * vault.SETTLER_BOUNTY_BPS() / 10_000, 1e12);
    }

    /// Multi-epoch: every shortfall settle pays min(shortfall, bond); a payment that leaves the bond below
    /// half the floor fires the curator. The epoch-ending call is the curator's own rebalance: it settles,
    /// fires, and returns without moving to the curator's range. Parked full range, curator locked out;
    /// anyone can finish the park, then it is closed.
    function test_fireRule() public {
        vault = _newVault(0.6e18);
        vm.recordLogs();
        _recenter(vault, 120);
        int24 tick;
        bool firedByRebalance;
        for (uint256 epoch; epoch < 12 && !vault.fired(); ++epoch) {
            for (uint256 i; i < 10; ++i) {
                tick += 100;
                _moveTo(tick);
            }
            vm.warp(block.timestamp + 600);
            int24 c = _floorTick();
            vm.prank(CURATOR);
            try vault.rebalance(c - 120, c + 120) {
                firedByRebalance = vault.fired();
            } catch {
                vault.settle(); // below the floor the curator's rebalance reverts; anyone can still settle
            }
        }
        (uint256 totalPaid,) = _checkSettlements();
        assertGt(totalPaid, 0);
        assertTrue(vault.fired(), "never fired");
        assertTrue(firedByRebalance, "should fire inside the curator's epoch-ending rebalance");
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

    /// Beating par never fires: NAV growth that drops the bond below the floor only blocks deposits and
    /// curator rebalances until postBond tops up.
    function test_beatingParNeverFires() public {
        vault = _newVault(0.4e18); // 20e18 NAV, bond exactly at the 2% floor
        vm.prank(CURATOR);
        vault.rebalance(TickMath.minUsableTick(SPACING), TickMath.maxUsableTick(SPACING));
        _moveTo(400); // NAV in token1 grows, bond does not
        (uint256 nav, uint256 bench,, uint256 paid) = _settled(vault);
        assertLt(paid * 1e6, nav, "only rounding dust paid");
        assertGe(nav + nav / 1e6, bench);
        assertFalse(vault.fired());
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
        uint256 cShares = vault.balanceOf(CURATOR);
        vm.recordLogs();
        _losingEpoch(c);
        (uint256 paid3,) = _checkSettlements(false); // bond shares absorb their own share of the miss
        assertGt(paid3, 0, "epoch 3 should trail par");
        // Burned k = b - b' + m, where m curator free shares were locked into bond shares (F11).
        uint256 burned = bShares + cShares - vault.bondShares() - vault.balanceOf(CURATOR);
        assertGt(burned, 0, "bond shares not burned first");
        if (burned < bShares) assertEq(vault.bond(), bondTokens, "tokens moved before shares ran out");
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

    /// In-kind deposits only in the settlement block: mid-epoch reverts; once the epoch is over,
    /// deposit() settles and goes through.
    /// Deposits are open for DEPOSIT_WINDOW (300 s) after an epoch settlement, then closed until the next one.
    function test_depositOnlyAtSettlement() public {
        vault = _newVault(1e18);
        _recenter(vault, 600);
        vm.warp(block.timestamp + 301);
        address bob = address(0xB0B);
        _fund(bob, address(vault), 2e18, 2e18);
        vm.prank(bob);
        vm.expectRevert(HurdleVault.DepositWindowClosed.selector);
        vault.deposit(1e18, 2e18, 2e18);
        vm.warp(block.timestamp + 299); // epoch (600 s) over: deposit settles it, then joins
        vm.prank(bob);
        vault.deposit(1e18, 2e18, 2e18);
        (uint64 ts,,,,) = vault.start();
        assertEq(ts, block.timestamp, "deposit did not settle");
        assertEq(vault.balanceOf(bob), 1e18);
    }

    /// v2 council: a third party settling one block earlier must not lock new deposits out for an epoch.
    function test_depositAfterThirdPartySettle() public {
        vault = _newVault(1e18);
        _recenter(vault, 600);
        vm.warp(block.timestamp + 600);
        vault.settle(); // keeper / griefer settles first
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 2);
        address bob = address(0xB0B);
        _fund(bob, address(vault), 2e18, 2e18);
        vm.prank(bob);
        vault.deposit(1e18, 2e18, 2e18);
        assertEq(vault.balanceOf(bob), 1e18);
    }

    /// Deposit pays exactly what withdraw pays back (rounded up): a round trip never profits.
    function test_depositInKindRoundTrip() public {
        vault = _newVault(1e18);
        _recenter(vault, 120); // position + idle
        _moveTo(60);
        address bob = address(0xB0B);
        _fund(bob, address(vault), 10e18, 10e18);
        uint256 shares = vault.balanceOf(ALICE) / 3;
        uint256 navPerShare = vault.nav() * 1e18 / vault.totalSupply();
        vm.startPrank(bob);
        (uint256 in0, uint256 in1) = vault.deposit(shares, 10e18, 10e18);
        (uint256 out0, uint256 out1) = vault.withdraw(shares);
        vm.stopPrank();
        assertGt(in0 + in1, 0);
        assertLe(out0, in0, "round trip gained token0");
        assertLe(out1, in1, "round trip gained token1");
        assertApproxEqAbs(out0, in0, 3);
        assertApproxEqAbs(out1, in1, 3);
        assertGe(vault.nav() * 1e18 / vault.totalSupply(), navPerShare, "incumbents diluted");
    }

    function test_depositSlippageAndFirstOnly() public {
        vault = _newVault(1e18);
        address bob = address(0xB0B);
        _fund(bob, address(vault), 11e18, 11e18);
        uint256 aliceShares = vault.balanceOf(ALICE);
        vm.startPrank(bob);
        vm.expectRevert(HurdleVault.Slippage.selector);
        vault.deposit(aliceShares, 11e18, 9e18); // needs ~10e18 of each
        vm.expectRevert(IHurdleVault.NotCurator.selector);
        vault.firstDeposit(1e18, 1e18, bob);
        vm.stopPrank();
        _fund(CURATOR, address(vault), 1e18, 1e18);
        vm.prank(CURATOR);
        vm.expectRevert(HurdleVault.NotFirstDeposit.selector);
        vault.firstDeposit(1e18, 1e18, ALICE);
    }

    /// [6] The first deposit is curator-only: anyone else reverts NotCurator; the curator pays, `receiver` gets the shares.
    function test_firstDepositCuratorOnly() public {
        HurdleVault v = new HurdleVault(manager, key, CURATOR, 2000, 200, 50, 600);
        _fund(ALICE, address(v), 10e18, 10e18);
        vm.prank(ALICE);
        vm.expectRevert(IHurdleVault.NotCurator.selector);
        v.firstDeposit(10e18, 10e18, ALICE);
        _fund(CURATOR, address(v), 10e18, 11e18);
        vm.prank(CURATOR);
        v.postBond(1e18);
        vm.prank(CURATOR);
        uint256 shares = v.firstDeposit(10e18, 10e18, ALICE);
        assertEq(v.balanceOf(ALICE), shares);
        assertEq(v.balanceOf(CURATOR), 0);
        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(CURATOR), 0);
    }

    /// F5: a mid-epoch exit while ahead of par pays its pro-rata share of the pending carry.
    function test_midEpochWithdrawPaysCarry() public {
        vault = _newVault(1e18, 50, 1 days);
        address bob = address(0xB0B);
        _fund(bob, address(vault), 11e18, 11e18);
        uint256 aliceShares = vault.balanceOf(ALICE);
        vm.prank(bob);
        vault.deposit(aliceShares, 11e18, 11e18);
        _recenter(vault, 600);
        for (uint256 i; i < 20; ++i) _moveTo(i % 2 == 0 ? int24(300) : int24(-300));
        _moveTo(0);
        vm.prank(ALICE);
        vault.withdraw(1); // realizes accrued fees into NAV (withdraw does this before crystallizing)

        uint256 navNow = vault.nav();
        uint256 benchNow = _benchNow();
        assertGt(navNow, benchNow, "patient should be ahead mid-epoch");
        uint256 t = vault.totalSupply();
        uint256 shares = vault.balanceOf(bob);
        uint256 take = (navNow - benchNow) * shares / t * 2000 / 10_000;
        vm.prank(bob);
        vault.withdraw(shares);
        uint256 curatorValue = vault.balanceOf(CURATOR) * navNow / t;
        assertGt(curatorValue, 0, "no carry crystallized");
        assertApproxEqRel(curatorValue, take, 1e14);
        assertEq(vault.balanceOf(bob), 0);
    }

    /// F5: with a deficit outstanding, a mid-epoch exit's take first recoups its pro-rata share of the
    /// deficit into bond shares; only the remainder pays carry.
    function test_midEpochWithdrawRecoupsDeficitFirst() public {
        vault = _newVault(6e18, 50, 1 days);
        address bob = address(0xB0B);
        _fund(bob, address(vault), 11e18, 11e18);
        uint256 aliceShares = vault.balanceOf(ALICE);
        vm.prank(bob);
        vault.deposit(aliceShares, 11e18, 11e18);
        _recenter(vault, 120);
        int24 tick;
        for (uint256 i; i < 10; ++i) {
            tick += 100;
            _moveTo(tick);
        }
        vm.warp(block.timestamp + 1 days);
        vault.settle(); // losing epoch: deficit, no curator shares
        uint256 d = vault.deficit();
        assertGt(d, 0);
        int24 c = _floorTick();
        vm.prank(CURATOR);
        vault.rebalance(c - 600, c + 600);
        for (uint256 i; i < 20; ++i) _moveTo(i % 2 == 0 ? c + 300 : c - 300);
        _moveTo(c);
        vm.prank(ALICE);
        vault.withdraw(1); // realize fees

        uint256 navNow = vault.nav();
        uint256 benchNow = _benchNow();
        assertGt(navNow, benchNow, "should be ahead mid-epoch");
        uint256 t = vault.totalSupply();
        uint256 shares = vault.balanceOf(bob) / 2;
        uint256 excess = (navNow - benchNow) * shares / t;
        uint256 owedD = vault.deficit() * shares / t;
        uint256 recoup = excess < owedD ? excess : owedD;
        uint256 carry = (excess - recoup) * 2000 / 10_000;
        d = vault.deficit();
        vm.prank(bob);
        vault.withdraw(shares);
        assertEq(d - vault.deficit(), owedD, "deficit not reduced by exactly the pro-rata share");
        assertGt(recoup, 0);
        assertApproxEqAbs(vault.bondShares() * navNow / t, recoup, 10, "recoup not locked as bond shares");
        assertApproxEqAbs(vault.balanceOf(CURATOR) * navNow / t, carry, 10, "carry not on the remainder only");
    }

    function test_selfCallsGuarded() public {
        vault = _newVault(1e18);
        vm.expectRevert(HurdleVault.OnlySelf.selector);
        vault.settleForWithdraw();
        vm.expectRevert(HurdleVault.OnlySelf.selector);
        vault.crystallize(ALICE, 1);
        vm.expectRevert(HurdleVault.OnlySelf.selector);
        vault.park();
    }

    /// F2: the rebalance swap stops at the intersection of reference ± dev and TWAP ± dev.
    /// Spot = reference = 30 after a fresh move, TWAP ~0: selling token0 stops at 30 - 50, buying at TWAP + 50.
    function test_swapBoundedByReferenceAndTwap() public {
        vault = _newVault(1e18);
        _moveTo(0);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams(false, -int256(1e30), TickMath.getSqrtPriceAtTick(30)),
            PoolSwapTest.TestSettings(false, false),
            ZERO_BYTES
        );
        vm.warp(block.timestamp + 12);
        int24 twap = hook.twapTick(key.toId());
        assertLt(twap, 5);
        assertEq(hook.referenceTick(key.toId()), 30);
        uint256 snap = vm.snapshotState();
        vm.prank(CURATOR);
        vault.rebalance(-6000, -3000); // needs all token1: sells token0
        assertGe(_currentTick(), 30 - 50 - 1, "sold below reference - dev");
        assertLe(_currentTick(), 30 - 50 + 1, "swap not bounded where expected");
        vm.revertToState(snap);
        vm.prank(CURATOR);
        vault.rebalance(3000, 6000); // needs all token0: buys token0
        assertLe(_currentTick(), twap + 50, "bought above TWAP + dev");
        assertGe(_currentTick(), twap + 50 - 1, "swap not bounded where expected");
    }

    /// F2: with spot inside both bands, a reference far from TWAP (TWAP lagging) still blocks rebalances.
    function test_rebalanceRevertsWhenTwapLagsReference() public {
        vault = _newVault(1e18);
        _moveTo(0);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams(false, -int256(1e30), TickMath.getSqrtPriceAtTick(60)),
            PoolSwapTest.TestSettings(false, false),
            ZERO_BYTES
        );
        vm.warp(block.timestamp + 12);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams(true, -int256(1e30), TickMath.getSqrtPriceAtTick(30)),
            PoolSwapTest.TestSettings(false, false),
            ZERO_BYTES
        );
        assertEq(hook.referenceTick(key.toId()), 60);
        vm.prank(CURATOR);
        vm.expectRevert(HurdleVault.PriceDeviation.selector);
        vault.rebalance(-600, 600);
    }

    /// F9: withdraw works when the oracle reverts (settlement and crystallization are skipped), and
    /// still realizes fees first, so two equal withdrawals are worth the same.
    function test_withdrawSurvivesOracleRevert() public {
        vault = _newVault(1e18, 50, 1 days);
        address bob = address(0xB0B);
        _fund(bob, address(vault), 11e18, 11e18);
        uint256 aliceShares = vault.balanceOf(ALICE);
        vm.prank(bob);
        vault.deposit(aliceShares, 11e18, 11e18);
        _recenter(vault, 600);
        for (uint256 i; i < 6; ++i) _moveTo(i % 2 == 0 ? int24(300) : int24(-300));
        _moveTo(0);
        vm.warp(block.timestamp + 1 days); // epoch over: withdraw would settle
        vm.mockCallRevert(address(hook), abi.encodeWithSelector(HurdleHook.twapTick.selector), "");
        vm.expectRevert();
        vault.settle();
        uint256 shares = vault.balanceOf(bob) / 100;
        vm.prank(bob);
        (uint256 b0, uint256 b1) = vault.withdraw(shares);
        vm.prank(ALICE);
        (uint256 c0, uint256 c1) = vault.withdraw(shares);
        vm.clearMockedCalls();
        assertGt(b0 + b1, 0);
        assertApproxEqAbs(b0, c0, 2);
        assertApproxEqAbs(b1, c1, 2);
    }

    /// F9: a park that reverts at the firing settle does not revert the settlement; anyone parks later.
    function test_firingSettleSurvivesFailedPark() public {
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
        (int24 lo,,) = vault.position();
        assertTrue(lo != TickMath.minUsableTick(SPACING), "park should have been skipped");
        _moveTo(tick);
        vault.rebalance(0, 0);
        (lo,,) = vault.position();
        assertEq(lo, TickMath.minUsableTick(SPACING));
    }

    /// F11: the curator's free (carry) shares absorb their own share of a miss: the bond pays only
    /// depositors, and the curator's free value is not topped up from its own bond.
    function test_curatorSharesAbsorbOwnMiss() public {
        vault = _newVault(6e18);
        _recenter(vault, 600);
        for (uint256 i; i < 60; ++i) _moveTo(i % 2 == 0 ? int24(300) : int24(-300));
        _moveTo(0);
        vault.settle(); // patient epoch: carry shares to the curator
        uint256 c = vault.balanceOf(CURATOR);
        assertGt(c, 0, "no carry shares");
        assertEq(vault.bondShares(), 0);

        _recenter(vault, 120);
        int24 tick;
        for (uint256 i; i < 10; ++i) {
            tick += 100;
            _moveTo(tick);
        }
        vm.warp(block.timestamp + 600);
        uint256 t = vault.totalSupply();
        uint256 bondV = vault.bondValue();
        (uint256 nav, uint256 bench,, uint256 paid) = _settled(vault);
        assertGt(bench, nav, "should trail par");
        uint256 t2 = vault.totalSupply();
        uint256 nav2 = vault.nav();
        assertApproxEqRel(paid, (bench - nav) * (t - c) / t, 1e12, "paid != depositors' share of the miss");
        assertApproxEqRel(vault.balanceOf(CURATOR) * nav2 / t2, c * nav / t, 1e12, "curator topped up from bond");
        assertApproxEqRel(bondV - vault.bondValue(), paid, 1e12, "bond fell by more than depositors got");
        uint256 depositors = t2 - vault.balanceOf(CURATOR) - vault.bondShares();
        assertApproxEqRel(depositors * nav2 / t2, (t - c) * bench / t, 1e12, "depositors not at par");
    }

    function test_constructorRejectsBadParams() public {
        vm.expectRevert(bytes("CARRY"));
        new HurdleVault(manager, key, CURATOR, 5001, 200, 50, 600);
        vm.expectRevert(bytes("BOND"));
        new HurdleVault(manager, key, CURATOR, 2000, 5001, 50, 600);
        vm.expectRevert(bytes("BOND"));
        new HurdleVault(manager, key, CURATOR, 2000, 99, 10, 600);
        vm.expectRevert(bytes("EPOCH"));
        new HurdleVault(manager, key, CURATOR, 2000, 200, 50, 599);
        PoolKey memory native = key;
        native.currency0 = Currency.wrap(address(0));
        vm.expectRevert(bytes("NATIVE"));
        new HurdleVault(manager, native, CURATOR, 2000, 200, 50, 600);
    }

    /// F3: the benchmark's fee credit is capped at MAX_FEE_APR_BPS of the starting NAV.
    function test_benchmarkFeeCreditCapped() public {
        vault = _newVault(1e18);
        uint160 s = TickMath.getSqrtPriceAtTick(0);
        uint256 huge = 1 << 127; // 0.5 token per unit L
        uint256 nav0 = 100e18;
        uint256 cap = nav0 * 30_000 * 600 / (10_000 * 365 days);
        assertEq(vault.benchmark(nav0, s, s, huge, huge, 600), nav0 + cap);
        uint256 small = 1e20;
        assertEq(vault.benchmark(nav0, s, s, 0, small, 600), nav0 + nav0 / 2 * small / (1 << 128)); // under the cap
    }

    /// Mid-epoch withdrawal gets its pro-rata share of accrued fees, not all of them.
    function test_midEpochWithdrawGetsProRataFees() public {
        vault = _newVault(1e18);
        address bob = address(0xB0B);
        _fund(bob, address(vault), 11e18, 11e18);
        uint256 aliceShares = vault.balanceOf(ALICE);
        vm.prank(bob);
        vault.deposit(aliceShares, 11e18, 11e18); // in kind, same block as the first deposit
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
        _fund(ALICE, address(vault), 21e18, 21e18);
        uint256 shares = 2 * vault.totalSupply();
        vm.prank(ALICE);
        vm.expectRevert(HurdleVault.CapacityExceeded.selector);
        vault.deposit(shares, 21e18, 21e18);
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

}
