// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Test.sol";
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
import {HurdleVaultFactory} from "../src/HurdleVaultFactory.sol";
import {VaultFixture} from "./VaultFixture.sol";

/// Tests for the deposit window, re-baselining deposits, the factory, reclaimBond and the previews.
contract V2Features is VaultFixture {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address constant BOB = address(0xB0B);

    function _bobFund() internal {
        _fund(BOB, address(vault), 100e18, 100e18);
    }

    function _t1() internal view returns (MockERC20) {
        return MockERC20(Currency.unwrap(currency1));
    }

    /// Swap the pool to `tick` without letting time pass.
    function _swapNoWarp(int24 tick) internal {
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
            key,
            IPoolManager.SwapParams(false, -int256(1e30), s0),
            PoolSwapTest.TestSettings(false, false),
            ZERO_BYTES
        );
    }

    // ---------------------------------------------------------------------
    // deposit window
    // ---------------------------------------------------------------------

    /// Proves: the window is epochStart+300 inclusive, closed at +301, and reopens when the next epoch settles.
    function test_windowClosesAt301AndReopensNextEpoch() public {
        vault = _newVault(1e18);
        _recenter(vault, 600);
        _bobFund();
        uint64 e0 = vault.epochStart();

        uint256 snap = vm.snapshotState();
        vm.warp(e0 + 300);
        vm.prank(BOB);
        vault.deposit(1e15, 100e18, 100e18); // last second of the window
        vm.revertToState(snap);

        vm.warp(e0 + 301);
        vm.prank(BOB);
        vm.expectRevert(HurdleVault.DepositWindowClosed.selector);
        vault.deposit(1e15, 100e18, 100e18);

        vm.warp(e0 + 600); // epoch over: the deposit settles it, which starts the next window
        vm.prank(BOB);
        vault.deposit(1e15, 100e18, 100e18);
        uint64 e1 = vault.epochStart();
        assertEq(e1, e0 + 600, "new epoch");

        vm.warp(e1 + 301);
        vm.prank(BOB);
        vm.expectRevert(HurdleVault.DepositWindowClosed.selector);
        vault.deposit(1e15, 100e18, 100e18);
    }

    /// Proves: a re-baselining deposit moves par's start but not epochStart or the rebalance count, so the
    /// epoch ends on schedule and a curator cannot reset its rebalance budget via deposits.
    function test_rebaselineKeepsEpochClockAndRebalanceCount() public {
        vault = _newVault(1e18);
        _recenter(vault, 600);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 10);
        _recenter(vault, 600);
        assertEq(vault.rebalancesThisEpoch(), 2);
        uint64 e0 = vault.epochStart();

        vm.roll(block.number + 1);
        vm.warp(e0 + 100);
        _bobFund();
        vm.prank(BOB);
        vault.deposit(1e18, 100e18, 100e18);

        (uint64 ts,,,,) = vault.start();
        assertEq(ts, e0 + 100, "par re-baselined to the deposit block");
        assertEq(vault.epochStart(), e0, "epochStart moved");
        assertEq(vault.rebalancesThisEpoch(), 2, "rebalance count reset");

        vm.warp(e0 + 599);
        vm.expectRevert(HurdleVault.EpochNotOver.selector);
        vault.settle();
        vm.warp(e0 + 600);
        vault.settle();
        assertEq(vault.epochStart(), e0 + 600);
        assertEq(vault.rebalancesThisEpoch(), 0);
    }

    // ---------------------------------------------------------------------
    // newcomer fairness
    // ---------------------------------------------------------------------

    struct Join {
        uint256 preNav; // Settled event of the deposit's re-baseline
        uint256 preBench;
        uint256 preTake;
        uint256 prePaid;
    }

    /// State just before the newcomer deposits, in the window and a later block than the epoch settle.
    /// ahead: ±600 range, fee wash swaps in the window => the vault is ahead of par.
    /// behind: range below spot (mostly token0 idle), TWAP pinned +20 ticks => the vault is behind par.
    function _prepWindow(bool ahead) internal {
        vault = _newVault(1e18);
        if (ahead) {
            _recenter(vault, 600);
        } else {
            vm.prank(CURATOR);
            vault.rebalance(-300, -60);
        }
        vm.warp(block.timestamp + 600);
        vault.settle(); // epoch settle by a third party: window opens at this timestamp
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 10);
        if (ahead) {
            _roundTrip(5e18);
            _roundTrip(5e18);
            _roundTrip(5e18);
        } else {
            _swapNoWarp(20);
            vm.mockCall(address(hook), abi.encodeWithSelector(HurdleHook.twapTick.selector), abi.encode(int24(20)));
        }
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 200);
        _bobFund();
    }

    function _join(uint256 shares) internal returns (Join memory j, uint256 paid0, uint256 paid1) {
        vm.recordLogs();
        vm.prank(BOB);
        (paid0, paid1) = vault.deposit(shares, 100e18, 100e18);
        (j.preNav, j.preBench, j.preTake, j.prePaid,,) = _lastSettled();
    }

    function _gapFrac(uint256 nav, uint256 bench) internal pure returns (int256) {
        return (int256(nav) - int256(bench)) * 1e18 / int256(nav);
    }

    /// Fairness: a newcomer who joins after the vault moved off par neither pays for nor collects that
    /// move. Counterfactual: the same state with a 1-share dust deposit instead (same re-baseline, no
    /// newcomer). Price is pinned after the join (ahead: no swaps left; behind: TWAP mocked), so the epoch's
    /// final settlement should show ~0 excess/shortfall in BOTH worlds if and only if the re-baseline
    /// absorbed the pre-join gap exactly. Also the newcomer's share value must equal what it paid.
    function _newcomerFair(bool ahead) internal {
        _prepWindow(ahead);
        uint256 snap = vm.snapshotState();

        // World J: big newcomer.
        uint256 shares = vault.balanceOf(ALICE) / 4;
        (Join memory j, uint256 p0, uint256 p1) = _join(shares);
        {
            uint160 s = TickMath.getSqrtPriceAtTick(hook.twapTick(key.toId()));
            uint256 paidValue = p0 * uint256(s) / (1 << 96) * uint256(s) / (1 << 96) + p1;
            uint256 shareValue = vault.balanceOf(BOB) * vault.nav() / vault.totalSupply();
            assertApproxEqRel(shareValue, paidValue, 1e-5, "newcomer value != paid");
        }
        int256 preGap = _gapFrac(j.preNav, j.preBench);
        emit log_named_int("pre-join gap, 1e18 = 100% of NAV", preGap);
        if (ahead) {
            assertGt(preGap, 1e13, "scenario not ahead");
            assertGt(j.preTake, 0, "carry not charged before the newcomer");
        } else {
            assertLt(preGap, -1e13, "scenario not behind");
            assertGt(j.prePaid, 0, "bond did not pay before the newcomer");
        }
        // After the join par equals NAV: baseline absorbed the gap (within 1e-9 of NAV).
        {
            (,,,, uint256 sNav) = vault.start();
            assertApproxEqRel(vault.nav(), sNav, 1e-9, "baseline != nav after join");
        }
        vm.warp(vault.epochStart() + 600);
        vm.recordLogs();
        vault.settle();
        (uint256 nJ, uint256 bJ, uint256 tJ, uint256 pJ,,) = _lastSettled();
        int256 endGapJ = _gapFrac(nJ, bJ);

        // World N: dust deposit.
        vm.revertToState(snap);
        vm.recordLogs();
        vm.prank(BOB);
        vault.deposit(1, 100e18, 100e18);
        vm.recordLogs();
        vm.warp(vault.epochStart() + 600);
        vault.settle();
        (uint256 nN, uint256 bN,,,,) = _lastSettled();
        int256 endGapN = _gapFrac(nN, bN);

        emit log_named_int("end gap with newcomer   ", endGapJ);
        emit log_named_int("end gap without newcomer", endGapN);
        assertLt(_abs(endGapJ), 1e9, "post-join settlement still charges pre-join performance");
        assertLt(_abs(endGapN), 1e9);
        assertEq(tJ + pJ, 0, "carry/shortfall at the next settle with no post-join move");
        assertTrue(nJ > 0 && bJ > 0 && nN > 0 && bN > 0);
    }

    /// Proves: joining after the vault pulled ahead of par pays the curator's carry before the newcomer
    /// exists, and the next settlement attributes nothing from before the join to the newcomer.
    function test_newcomerFairness_vaultAhead() public {
        _newcomerFair(true);
    }

    /// Proves: joining after the vault fell behind par makes the bond pay before the newcomer exists; the
    /// newcomer neither funds the bond nor collects that payment.
    function test_newcomerFairness_vaultBehind() public {
        _newcomerFair(false);
    }

    // ---------------------------------------------------------------------
    // factory
    // ---------------------------------------------------------------------

    /// Proves: the factory pins the hook, records its vaults and makes the caller the curator; a vault
    /// deployed directly is not registered.
    function test_factory() public {
        HurdleVaultFactory f = new HurdleVaultFactory(manager, address(hook));
        PoolKey memory bad = key;
        bad.hooks = IHooks(address(0xBEEF));
        vm.prank(CURATOR);
        vm.expectRevert(HurdleVaultFactory.WrongHook.selector);
        f.create(bad, 2000, 200, 50, 600);

        vm.prank(CURATOR);
        HurdleVault v = f.create(key, 2000, 200, 50, 600);
        assertTrue(f.isVault(address(v)), "not registered");
        assertEq(v.curator(), CURATOR, "curator != caller");
        assertEq(address(v.oracle()), address(hook));

        HurdleVault direct = _newVault(1e18);
        assertFalse(f.isVault(address(direct)), "direct vault registered");
        assertEq(address(f.manager()), address(manager));
        assertEq(f.hook(), address(hook));
    }

    // ---------------------------------------------------------------------
    // reclaimBond
    // ---------------------------------------------------------------------

    function _failingEpochs(bool mockPark) internal returns (int24 tick) {
        vault = _newVault(0.6e18);
        for (uint256 epoch; epoch < 12 && !vault.fired(); ++epoch) {
            _recenter(vault, 120);
            for (uint256 i; i < 10; ++i) {
                tick += 100;
                _moveTo(tick);
            }
            vm.warp(block.timestamp + 600);
            if (mockPark) vm.mockCallRevert(address(hook), abi.encodeWithSelector(HurdleHook.referenceTick.selector), "");
            vault.settle();
            vm.clearMockedCalls();
        }
        assertTrue(vault.fired(), "never fired");
    }

    /// Proves: only the curator, only once fired, and not before a full epoch after firing.
    function test_reclaimBond_guards() public {
        vault = _newVault(1e18);
        vm.prank(BOB);
        vm.expectRevert(HurdleVault.NotCurator.selector);
        vault.reclaimBond();
        vm.prank(CURATOR);
        vm.expectRevert(HurdleVault.NotFired.selector);
        vault.reclaimBond();

        _failingEpochs(false);
        (int24 lo,,) = vault.position();
        assertEq(lo, TickMath.minUsableTick(SPACING), "fire-time park did not happen");
        vm.prank(BOB);
        vm.expectRevert(HurdleVault.NotCurator.selector);
        vault.reclaimBond();
        vm.prank(CURATOR);
        vm.expectRevert(HurdleVault.EpochNotOver.selector);
        vault.reclaimBond();
        vm.warp(vault.firedAt() + 599);
        vm.prank(CURATOR);
        vm.expectRevert(HurdleVault.EpochNotOver.selector);
        vault.reclaimBond();
    }

    /// Proves: NotParked while the fire-time park failed; after anyone parks, reclaim pays out the bond
    /// tokens and unlocks the bond shares; later misses pay nothing and nothing reverts; postBond stays shut.
    function test_reclaimBond_notParkedThenSuccess() public {
        int24 tick = _failingEpochs(true);
        (int24 lo,,) = vault.position();
        assertTrue(lo != TickMath.minUsableTick(SPACING), "park should have been skipped");
        _moveTo(tick); // an epoch passes and the TWAP catches up
        vm.prank(CURATOR);
        vm.expectRevert(HurdleVault.NotParked.selector);
        vault.reclaimBond();

        vault.rebalance(0, 0); // anyone finishes the park
        uint256 bond0 = vault.bond();
        uint256 bs0 = vault.bondShares();
        uint256 free0 = vault.balanceOf(CURATOR);
        uint256 tok0 = _t1().balanceOf(CURATOR);
        assertGt(bond0 + bs0, 0, "nothing left to reclaim");

        vm.prank(CURATOR);
        vault.reclaimBond();
        assertEq(_t1().balanceOf(CURATOR) - tok0, bond0, "bond tokens");
        assertEq(vault.balanceOf(CURATOR) - free0, bs0, "bond shares unlocked");
        assertEq(vault.bond(), 0);
        assertEq(vault.bondShares(), 0);
        assertEq(vault.deficit(), 0);

        // A miss now: par inflated past the fee cap by a mocked fee growth.
        (,, uint256 f0, uint256 f1,) = vault.start();
        vm.mockCall(
            address(hook),
            abi.encodeWithSelector(HurdleHook.referenceFeeGrowth.selector),
            abi.encode(f0, f1 + 1e38)
        );
        vm.warp(block.timestamp + 600);
        vm.recordLogs();
        vault.settle();
        (uint256 nav, uint256 bench,, uint256 paid,,) = _lastSettled();
        assertLt(nav, bench, "no miss constructed");
        assertEq(paid, 0, "paid from a reclaimed bond");
        vm.clearMockedCalls();

        _fund(CURATOR, address(vault), 0, 1e18);
        vm.prank(CURATOR);
        vm.expectRevert(HurdleVault.CuratorFired.selector);
        vault.postBond(1e18);
    }

    // ---------------------------------------------------------------------
    // previews
    // ---------------------------------------------------------------------

    /// Proves: previewDeposit never under-quotes the actual cost and is within 1 bp + 2 wei; previewWithdraw
    /// is within 1 bp of the actual payout when no carry is pending.
    function test_previews() public {
        vault = _newVault(1e18);
        _recenter(vault, 600);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 100);
        _bobFund();
        uint256 shares = vault.balanceOf(ALICE) / 5;

        (uint256 q0, uint256 q1) = vault.previewDeposit(shares);
        uint256 snap = vm.snapshotState();
        vm.prank(BOB);
        (uint256 a0, uint256 a1) = vault.deposit(shares, 100e18, 100e18);
        vm.revertToState(snap);
        assertGt(a0, 0);
        assertGt(a1, 0);
        assertGe(q0, a0, "previewDeposit token0 under-quotes");
        assertGe(q1, a1, "previewDeposit token1 under-quotes");
        assertLe(q0, a0 + a0 / 10_000 + 2, "previewDeposit token0 too loose");
        assertLe(q1, a1 + a1 / 10_000 + 2, "previewDeposit token1 too loose");

        (uint256 w0, uint256 w1) = vault.previewWithdraw(shares);
        vm.prank(ALICE);
        (uint256 r0, uint256 r1) = vault.withdraw(shares);
        assertApproxEqRel(w0, r0, 1e14, "previewWithdraw token0");
        assertApproxEqRel(w1, r1, 1e14, "previewWithdraw token1");
    }

    // ---------------------------------------------------------------------
    // "par is endogenous to the curator's own liquidity" (Opus council)
    // ---------------------------------------------------------------------

    struct EndoResult {
        uint256 nav;
        uint256 bench;
        uint256 take;
        uint256 creditUncapped; // l * dfg valued at TWAP, no cap
        uint256 vaultShareBp; // vault liquidity / in-range liquidity at the start, bp
    }

    function _feeCredit(uint256 nav0, uint160 s0, uint256 dfg0, uint256 dfg1, uint160 s1) internal pure returns (uint256) {
        uint256 l = nav0 * (1 << 96) / (2 * uint256(s0));
        uint256 f0 = l * dfg0 >> 128;
        uint256 f1 = l * dfg1 >> 128;
        return f0 * uint256(s1) / (1 << 96) * uint256(s1) / (1 << 96) + f1;
    }

    function _endoSwaps() internal {
        for (uint256 i; i < 40; ++i) {
            vm.roll(block.number + 1);
            vm.warp(block.timestamp + 60);
            _roundTrip(2e18);
        }
        vm.warp(block.timestamp + 600);
    }

    /// Fixed-volume wash swaps on a thin pool where the vault's concentrated position is most of the
    /// in-range liquidity. World A: the vault's position. World B: same capital idle, replaced by a real
    /// full-range LP of the vault's starting NAV. Same swaps. Par's fee credit comes from fee growth per
    /// unit liquidity, which the vault's own depth dilutes (volume is fixed), so par undercounts what a
    /// real full-range position would have earned: asserts gap >= 0, logs the numbers.
    function test_endogenousPar() public {
        // Thin pool: 60e18 background, so the vault (+/-600 ticks, ~10e18 of each token) dominates.
        LIQUIDITY_PARAMS.liquidityDelta = 60e18;
        (key,) = initPoolAndAddLiquidity(currency0, currency1, IHooks(address(hook)), 2500, SQRT_PRICE_1_1);
        vm.warp(block.timestamp + 600);
        vault = _newVault(1e18);
        uint256 snap = vm.snapshotState();
        (,,,, uint256 nav0) = vault.start();
        (uint160 s0,,,) = manager.getSlot0(key.toId());

        // ---- World A
        _recenter(vault, 600);
        (,, uint128 vl) = vault.position();
        EndoResult memory a;
        a.vaultShareBp = uint256(vl) * 10_000 / (uint256(vl) + 60e18);
        (uint256 g0a, uint256 g1a) = manager.getFeeGrowthGlobals(key.toId());
        _endoSwaps();
        {
            vm.recordLogs();
            vault.settle();
            (a.nav, a.bench, a.take,,,) = _lastSettled();
            (uint256 g0e, uint256 g1e) = manager.getFeeGrowthGlobals(key.toId());
            uint160 s1 = TickMath.getSqrtPriceAtTick(hook.twapTick(key.toId()));
            a.creditUncapped = _feeCredit(nav0, s0, g0e - g0a, g1e - g1a, s1);
        }

        // ---- World B
        vm.revertToState(snap);
        (uint256 g0b, uint256 g1b) = manager.getFeeGrowthGlobals(key.toId());
        modifyLiquidityRouter.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams(
                TickMath.minUsableTick(SPACING), TickMath.maxUsableTick(SPACING), int256(nav0 / 2), bytes32(uint256(1))
            ),
            ZERO_BYTES
        );
        _endoSwaps();
        (uint256 g0f, uint256 g1f) = manager.getFeeGrowthGlobals(key.toId());
        uint160 s1b = TickMath.getSqrtPriceAtTick(hook.twapTick(key.toId()));
        // a full-range LP of liquidity nav0/2 earns (nav0/2) * dfg per token
        uint256 realFullRange = _feeCredit(nav0, s0, g0f - g0b, g1f - g1b, s1b);

        emit log_named_uint("vault share of in-range liquidity, bp  ", a.vaultShareBp);
        emit log_named_int("A: excess nav-bench (wei)               ", int256(a.nav) - int256(a.bench));
        emit log_named_int("A: excess, bp of start NAV              ", (int256(a.nav) - int256(a.bench)) * 10_000 / int256(nav0));
        emit log_named_uint("A: carry (wei, take)                    ", a.take);
        emit log_named_uint("A: par fee credit used (bench - principal, capped)", a.bench - _principal(nav0, s0));
        emit log_named_uint("A: par fee credit uncapped (l*dfg_A)    ", a.creditUncapped);
        emit log_named_uint("B: real full-range LP fees (l*dfg_B)    ", realFullRange);
        emit log_named_int("gap B - A_uncapped, bp of start NAV     ", (int256(realFullRange) - int256(a.creditUncapped)) * 10_000 / int256(nav0));
        emit log_named_int("gap B - A_used (capped), bp of start NAV ", (int256(realFullRange) - int256(a.bench - _principal(nav0, s0))) * 10_000 / int256(nav0));
        assertGe(a.vaultShareBp, 5000, "vault is not the majority of in-range liquidity");
        assertGe(realFullRange, a.creditUncapped, "par does not undercount");
    }

    function _principal(uint256 nav0, uint160 s0) internal view returns (uint256) {
        uint160 s1 = TickMath.getSqrtPriceAtTick(hook.twapTick(key.toId()));
        return nav0 * uint256(s1) / uint256(s0);
    }
}
