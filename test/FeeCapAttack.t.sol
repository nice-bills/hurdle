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
import {HurdleHook} from "../src/HurdleHook.sol";
import {HurdleVault} from "../src/HurdleVault.sol";
import {Vm} from "forge-std/Vm.sol";
import {IHurdleVault} from "../src/IHurdleVault.sol";
import {HookMiner} from "./utils/HookMiner.sol";

/// Cross-block wash trading by the pool's dominant full-range LP, every block for a whole epoch
/// (research/fee-cap.md). The vault sits idle (earns nothing), so every wei of par's fee credit is bond drain.
/// The drain per epoch must be bounded by MAX_FEE_APR_BPS x elapsed, whether the settle is on time or late.
contract FeeCapAttackTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address constant CURATOR = address(0xC0);
    address constant ALICE = address(0xA1);
    uint32 constant EPOCH = 3600;
    uint256 constant BLOCK_TIME = 30; // one attacker swap pair per 30 s block: 120 blocks per epoch

    HurdleHook hook;
    HurdleVault vault;
    MockERC20 t0;
    MockERC20 t1;

    function setUp() public {
        vm.warp(1_000_000);
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_DONATE_FLAG);
        (, bytes32 salt) = HookMiner.find(address(this), flags, type(HurdleHook).creationCode, abi.encode(manager));
        hook = new HurdleHook{salt: salt}(manager);
        // The attacker (this contract) is the dominant full-range LP: 2000e18 of liquidity vs the vault's ~10e18.
        LIQUIDITY_PARAMS = IPoolManager.ModifyLiquidityParams(
            TickMath.minUsableTick(60), TickMath.maxUsableTick(60), 2000e18, 0
        );
        (key,) = initPoolAndAddLiquidity(currency0, currency1, IHooks(address(hook)), 3000, SQRT_PRICE_1_1);
        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));
        for (uint256 i; i < 40; ++i) { // oracle history
            vm.warp(block.timestamp + 60);
            vm.roll(block.number + 1);
            _wash(1e15);
        }
        vm.warp(block.timestamp + 60);
        vm.roll(block.number + 1);

        vault = new HurdleVault(manager, key, CURATOR, 2000, 200, 50, EPOCH);
        _fund(CURATOR, 0, 2e18);
        vm.prank(CURATOR);
        vault.postBond(2e18); // 20% of NAV
        _fund(CURATOR, 5e18, 5e18);
        vm.prank(CURATOR);
        vault.firstDeposit(5e18, 5e18, ALICE); // stays idle: earns no fees, par earns the wash credit
    }

    function _fund(address who, uint256 a0, uint256 a1) internal {
        t0.transfer(who, a0);
        t1.transfer(who, a1);
        vm.startPrank(who);
        t0.approve(address(vault), type(uint256).max);
        t1.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    /// One round trip in one block: sell `amt` token0, then buy back to the starting price.
    function _wash(uint256 amt) internal {
        (uint160 s0,,,) = manager.getSlot0(key.toId());
        swapRouter.swap(
            key, IPoolManager.SwapParams(true, -int256(amt), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false), ZERO_BYTES
        );
        swapRouter.swap(
            key, IPoolManager.SwapParams(false, -int256(1e30), s0), PoolSwapTest.TestSettings(false, false), ZERO_BYTES
        );
    }

    /// Wash every block for `span` seconds, then settle. Returns the bond paid out, the cap, and the
    /// fee credit par would have taken with no cap.
    function _attack(uint256 span) internal returns (uint256 drain, uint256 cap, uint256 uncapped) {
        (uint64 ts, uint160 sStart, uint256 f0, uint256 f1, uint256 nav0) = vault.start();
        uint256 bondBefore = vault.bond();
        for (uint256 t; t < span; t += BLOCK_TIME) {
            vm.warp(block.timestamp + BLOCK_TIME);
            vm.roll(block.number + 1);
            _wash(5e18);
        }
        vm.warp(ts + span);
        vm.roll(block.number + 1);
        (uint256 g0, uint256 g1) = hook.referenceFeeGrowth(key.toId());
        uint160 s1 = TickMath.getSqrtPriceAtTick(hook.twapTick(key.toId()));
        uint256 principal = vault.benchmark(nav0, sStart, s1, 0, 0, 1);
        unchecked {
            uncapped = vault.benchmark(nav0, sStart, s1, g0 - f0, g1 - f1, type(uint64).max / 10_000) - principal;
        }
        cap = nav0 * vault.MAX_FEE_APR_BPS() * span / (10_000 * 365 days);
        vault.settle();
        drain = bondBefore - vault.bond();
    }

    function test_attack_onTimeEpochDrainBoundedByCap() public {
        (uint256 drain, uint256 cap, uint256 uncapped) = _attack(EPOCH);
        console2.log("on-time epoch: bond drain / cap / uncapped credit (token1 wei):", drain, cap, uncapped);
        console2.log("drain in bp of NAV x1000:", drain * 10_000_000 / vault.nav());
        assertGt(uncapped, 5 * cap, "the wash really generates far more than the cap");
        assertLe(drain, cap + 1, "drain bounded by the cap");
        assertGe(drain + 1e12, cap, "...and the attacker does reach it");
        assertFalse(vault.fired());
    }

    /// A settle several epochs late: the drain is still capped at the same rate per hour.
    function test_attack_lateSettleDrainSameRatePerHour() public {
        (uint256 drain, uint256 cap,) = _attack(3 * EPOCH);
        console2.log("3-epoch-late settle: bond drain / cap:", drain, cap);
        assertLe(drain, cap + 1, "drain bounded by the cap x elapsed");
        (,,,, uint256 nav0) = vault.start();
        assertLe(drain / 3, nav0 * vault.MAX_FEE_APR_BPS() * EPOCH / (10_000 * 365 days) + 1, "per-hour rate unchanged");
    }

    /// The same dominant-LP wash, but the vault is IN RANGE (re-centred, +-120 ticks). It earns its share of the wash
    /// fees as a real LP, far above par's full-range credit, so nothing is paid out: only an idle/out-of-range vault
    /// is exposed (research/fee-cap.md section 5).
    function _washEpoch() internal {
        for (uint256 t; t < EPOCH; t += BLOCK_TIME) {
            vm.warp(block.timestamp + BLOCK_TIME);
            vm.roll(block.number + 1);
            _wash(5e18);
        }
        (uint64 ts,,,,) = vault.start();
        vm.warp(ts + EPOCH);
        vm.roll(block.number + 1);
    }

    /// Par's uncapped fee credit and the cap over one epoch, from the vault's start snapshot.
    function _credits() internal view returns (uint256 uncapped, uint256 cap) {
        (, uint160 sStart, uint256 f0, uint256 f1, uint256 nav0) = vault.start();
        (uint256 g0, uint256 g1) = hook.referenceFeeGrowth(key.toId());
        uint160 s1 = TickMath.getSqrtPriceAtTick(hook.twapTick(key.toId()));
        uint256 principal = vault.benchmark(nav0, sStart, s1, 0, 0, 1);
        unchecked {
            uncapped = vault.benchmark(nav0, sStart, s1, g0 - f0, g1 - f1, type(uint64).max / 10_000) - principal;
        }
        cap = nav0 * vault.MAX_FEE_APR_BPS() * EPOCH / (10_000 * 365 days);
    }

    function test_attack_inRangeVaultIsNotDrained() public {
        vm.prank(CURATOR);
        vault.rebalance(-120, 120);
        uint256 bondBefore = vault.bond();
        _washEpoch();
        (uint256 uncapped, uint256 cap) = _credits();
        (,,,, uint256 nav0) = vault.start();
        vm.recordLogs();
        vault.settle();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 navNow;
        uint256 bench;
        uint256 paid;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IHurdleVault.Settled.selector) {
                (navNow, bench,, paid,,) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint160));
            }
        }
        console2.log("in-range: vault real fee gain (nav - start nav, wei):", navNow - nav0);
        console2.log("in-range: par credit uncapped / cap (wei):", uncapped, cap);
        console2.log("in-range: nav / bench / paid:", navNow, bench, paid);
        assertEq(paid, 0, "bond paid out to an in-range vault");
        assertEq(vault.bond(), bondBefore, "bond drained");
        assertGe(navNow, bench, "in-range vault fell below par under wash trading");
        assertGe(navNow - nav0 + 1e12, uncapped, "vault earned less than the full-range credit");
        assertFalse(vault.fired());
    }
}
