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
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";

contract BenchmarkTest is Test, Deployers {
    using StateLibrary for IPoolManager;
    uint128 constant L = 1e18;
    uint256 constant Q128 = 1 << 128;
    uint160 constant SQRT_1_1 = uint160(1 << 96);

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        (key,) = initPool(currency0, currency1, IHooks(address(0)), 3000, 60, SQRT_1_1);
    }

    function test_realAccounting_matchesFormula() public {
        _check(0x123456789abcdef, 240);
    }

    function testFuzz_realAccounting_matchesFormula(uint256 seed, uint8 count) public {
        _check(seed, 200 + uint256(count) % 101);
    }

    function _check(uint256 seed, uint256 n) internal {
        int24 lo = TickMath.minUsableTick(60);
        int24 hi = TickMath.maxUsableTick(60);
        uint256 b0 = currency0.balanceOf(address(this));
        uint256 b1 = currency1.balanceOf(address(this));
        IPoolManager.ModifyLiquidityParams memory p = IPoolManager.ModifyLiquidityParams(lo, hi, int256(uint256(L)), bytes32(uint256(77)));
        modifyLiquidityRouter.modifyLiquidity(key, p, ZERO_BYTES);
        uint256 x0 = b0 - currency0.balanceOf(address(this));
        uint256 y0 = b1 - currency1.balanceOf(address(this));
        PoolId id = key.toId();
        (uint160 s0,,,) = manager.getSlot0(id);
        (uint256 f0, uint256 f1) = manager.getFeeGrowthGlobals(id);

        uint256 rng = seed;
        uint256 gasBefore = gasleft();
        for (uint256 i; i < n; ++i) {
            rng = uint256(keccak256(abi.encode(rng, i)));
            bool zfo = rng & 1 == 0;
            // Exact input and exact output are both exercised; size is bounded to keep price in range.
            uint256 size = 1e15 + (rng >> 8) % 2e17;
            bool exactIn = (rng >> 3) & 1 == 0;
            swap(key, zfo, exactIn ? -int256(size) : int256(size), ZERO_BYTES);
        }
        uint256 plainSwapGas = gasBefore - gasleft();
        emit log_named_uint("plain swap loop gas (N swaps)", plainSwapGas);

        (uint160 s1,,,) = manager.getSlot0(id);
        (uint256 g0, uint256 g1) = manager.getFeeGrowthGlobals(id);
        uint256 P1 = FullMath.mulDiv(uint256(s1), uint256(s1), 1 << 192);
        uint256 fee0 = FullMath.mulDiv(uint256(L), g0 - f0, Q128);
        uint256 fee1 = FullMath.mulDiv(uint256(L), g1 - f1, Q128);
        uint256 fees = FullMath.mulDiv(fee0, P1, 1) + fee1;
        uint256 ds = uint256(s1) > s0 ? uint256(s1) - s0 : uint256(s0) - s1;
        uint256 loss = FullMath.mulDiv(uint256(L), FullMath.mulDiv(ds, ds, s0), 1 << 96);
        int256 excess = int256(fees) - int256(loss);

        p.liquidityDelta = -int256(uint256(L));
        uint256 a0 = currency0.balanceOf(address(this));
        uint256 a1 = currency1.balanceOf(address(this));
        modifyLiquidityRouter.modifyLiquidity(key, p, ZERO_BYTES);
        uint256 x1 = currency0.balanceOf(address(this)) - a0;
        uint256 y1 = currency1.balanceOf(address(this)) - a1;
        int256 truth = int256(x1 * P1 + y1) - int256(x0 * P1 + y0);
        uint256 err = uint256(excess > truth ? excess - truth : truth - excess);
        uint256 capital = x0 * P1 + y0;
        emit log_named_uint("absolute error token1-wei", err);
        emit log_named_uint("initial capital token1-wei", capital);
        assertLe(err * 10_000, capital, "benchmark exceeds 1bp");
    }
}
