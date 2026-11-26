// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {HurdleVault} from "../src/HurdleVault.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";

contract BenchmarkTest is Test, Deployers {
    using StateLibrary for IPoolManager;
    uint128 constant L = 1e18;
    uint256 constant Q128 = 1 << 128;
    uint160 constant SQRT_1_1 = uint160(1 << 96);

    struct Snapshot {
        uint160 sqrtPriceX96;
        uint256 feeGrowth0X128;
        uint256 feeGrowth1X128;
    }

    /// The deployed contract's `benchmark` (public pure): the test checks the real code, not a copy.
    HurdleVault vault;
    /// Large enough that MAX_FEE_APR_BPS never binds: fees are credited in full.
    uint256 constant UNCAPPED = 100_000 * 365 days;
    uint256 public maxErrQ27; // worst relative error seen, 1e27 scale (1e27 = 100% of capital)

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        (key,) = initPool(currency0, currency1, IHooks(address(0)), 3000, 60, SQRT_1_1);
        // benchmark() reads no state, so the oracle (key.hooks = 0) is never touched.
        vault = new HurdleVault(manager, key, address(0xC0), 2000, 100, 1, 3600);
    }

    function test_realAccounting_matchesFormula() public {
        _check(0x123456789abcdef, 240);
    }

    function test_measureMaxError() public {
        uint256 maxRelativeErrorQ27;
        for (uint256 i; i < 8; ++i) {
            uint256 relativeErrorQ27 = _check(i + 1, 240);
            if (relativeErrorQ27 > maxRelativeErrorQ27) maxRelativeErrorQ27 = relativeErrorQ27;
        }
        emit log_named_uint("max relative error (1e27 scale)", maxRelativeErrorQ27);
        // Observed max 1.43e-18 of capital over these 8 seeds; README claims ~2.5e-18.
        assertLe(maxRelativeErrorQ27, 2.5e9, "error above the README's 2.5e-18 claim");
    }

    function testFuzz_realAccounting_matchesFormula(uint256 seed, uint8 count) public {
        _check(seed, 200 + uint256(count) % 101);
    }

    function _check(uint256 seed, uint256 n) internal returns (uint256 relativeErrorQ27) {
        (uint256 x0, uint256 y0) = _deposit();
        Snapshot memory before_ = _snapshot();
        _runSwaps(seed, n);
        Snapshot memory after_ = _snapshot();
        uint256 p1Q64 = FullMath.mulDiv(uint256(after_.sqrtPriceX96), uint256(after_.sqrtPriceX96), 1 << 128);
        // benchmark() values a full-range position worth nav0 at s0 once moved to s1 plus fees; the
        // passive position here holds (x0,y0), so excess over holding them = benchmark - hold value.
        uint256 nav0 = FullMath.mulDiv(FullMath.mulDiv(x0, before_.sqrtPriceX96, 1 << 96), before_.sqrtPriceX96, 1 << 96) + y0;
        uint256 bench = vault.benchmark(
            nav0,
            before_.sqrtPriceX96,
            after_.sqrtPriceX96,
            after_.feeGrowth0X128 - before_.feeGrowth0X128,
            after_.feeGrowth1X128 - before_.feeGrowth1X128,
            UNCAPPED
        );
        int256 excessQ64 = int256(bench << 64) - int256(_valueQ64(x0, y0, p1Q64));

        (uint256 x1, uint256 y1) = _withdraw();
        int256 truth = int256(_valueQ64(x1, y1, p1Q64)) - int256(_valueQ64(x0, y0, p1Q64));
        uint256 errQ64 = uint256(excessQ64 > truth ? excessQ64 - truth : truth - excessQ64);
        uint256 capitalQ64 = _valueQ64(x0, y0, p1Q64);
        emit log_named_uint("absolute error token1-wei Q64", errQ64);
        emit log_named_uint("initial capital token1-wei Q64", capitalQ64);
        relativeErrorQ27 = FullMath.mulDiv(errQ64, 1e27, capitalQ64);
        if (relativeErrorQ27 > maxErrQ27) maxErrQ27 = relativeErrorQ27;
        emit log_named_uint("relative error (1e27 scale)", relativeErrorQ27);
        emit log_named_uint(
            "ending price (1e6 scale)", FullMath.mulDiv(p1Q64, 1e6, 1 << 64)
        );
        assertLe(errQ64 * 10_000, capitalQ64, "benchmark exceeds 1bp");
    }

    function _deposit() internal returns (uint256 x0, uint256 y0) {
        uint256 b0 = currency0.balanceOf(address(this));
        uint256 b1 = currency1.balanceOf(address(this));
        modifyLiquidityRouter.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams(
                TickMath.minUsableTick(60), TickMath.maxUsableTick(60), int256(uint256(L)), bytes32(uint256(77))
            ),
            ZERO_BYTES
        );
        x0 = b0 - currency0.balanceOf(address(this));
        y0 = b1 - currency1.balanceOf(address(this));
    }

    function _snapshot() internal view returns (Snapshot memory snap) {
        (snap.sqrtPriceX96,,,) = manager.getSlot0(key.toId());
        (snap.feeGrowth0X128, snap.feeGrowth1X128) = manager.getFeeGrowthGlobals(key.toId());
    }

    function _runSwaps(uint256 seed, uint256 n) internal {
        uint256 rng = seed;
        for (uint256 i; i < n; ++i) {
            rng = uint256(keccak256(abi.encode(rng, i)));
            // A long directional leg followed by a shorter retrace gives a meaningful,
            // reproducible price excursion without random walks reaching TickMath limits.
            bool zeroForOne = (i < (n * 7 / 10)) == ((seed & 1) == 0);
            uint256 size = 1e15 + (rng >> 8) % 2e15;
            bool exactIn = (rng >> 3) & 1 == 0;
            swap(key, zeroForOne, exactIn ? -int256(size) : int256(size), ZERO_BYTES);
        }
    }

    function _withdraw() internal returns (uint256 x1, uint256 y1) {
        uint256 b0 = currency0.balanceOf(address(this));
        uint256 b1 = currency1.balanceOf(address(this));
        modifyLiquidityRouter.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams(
                TickMath.minUsableTick(60), TickMath.maxUsableTick(60), -int256(uint256(L)), bytes32(uint256(77))
            ),
            ZERO_BYTES
        );
        x1 = currency0.balanceOf(address(this)) - b0;
        y1 = currency1.balanceOf(address(this)) - b1;
    }

    function _valueQ64(uint256 amount0, uint256 amount1, uint256 p1Q64) internal pure returns (uint256) {
        return amount0 * p1Q64 + amount1 * (1 << 64);
    }

    /// With a tiny `elapsed` the fee credit is clamped to nav0 * MAX_FEE_APR_BPS * elapsed / (1e4 * 1 year).
    function test_feeCapBindsWhenElapsedTiny() public {
        (uint256 x0, uint256 y0) = _deposit();
        Snapshot memory a = _snapshot();
        _runSwaps(1, 200);
        Snapshot memory b = _snapshot();
        uint256 nav0 = FullMath.mulDiv(FullMath.mulDiv(x0, a.sqrtPriceX96, 1 << 96), a.sqrtPriceX96, 1 << 96) + y0;
        uint256 d0 = b.feeGrowth0X128 - a.feeGrowth0X128;
        uint256 d1 = b.feeGrowth1X128 - a.feeGrowth1X128;
        uint256 principal = vault.benchmark(nav0, a.sqrtPriceX96, b.sqrtPriceX96, 0, 0, 1);
        uint256 full = vault.benchmark(nav0, a.sqrtPriceX96, b.sqrtPriceX96, d0, d1, UNCAPPED) - principal;
        uint256 capped = vault.benchmark(nav0, a.sqrtPriceX96, b.sqrtPriceX96, d0, d1, 1) - principal;
        // 8_000 bps APR over 1 second, written out: nav0 * 0.8 / 31_536_000.
        assertEq(capped, nav0 * vault.maxFeeAprBps() / (10_000 * 365 days), "capped credit = cap");
        assertGt(capped, 0);
        assertLt(capped, full, "cap must bind");
    }

    function test_plainSwapGasBaseline() public {
        uint256 gasBefore = gasleft();
        swap(key, true, -int256(1e16), ZERO_BYTES);
        emit log_named_uint("plain swap gas", gasBefore - gasleft());
    }
}
