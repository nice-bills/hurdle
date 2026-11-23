// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

/// @notice Adds passive full-range depth to the demo pool (testnet mocks only), so a fired vault's park swap
/// (bounded to maxTickDeviation from the TWAP) can convert its whole idle balance in one call, as it would on a
/// real pool with arbitrageurs. Env: PRIVATE_KEY, DEPLOY_JSON, DEPTH_L (liquidity units, default 1e17 ≈ 1.9k
/// mWETH + 5M mUSDC at tick ~197k).
contract AddDepth is Script {
    function run() external {
        string memory json = vm.readFile(vm.envOr("DEPLOY_JSON", string("script/out/deploy-1301.json")));
        PoolModifyLiquidityTest router = PoolModifyLiquidityTest(vm.parseJsonAddress(json, ".liquidityRouter"));
        MockERC20 c0 = MockERC20(vm.parseJsonAddress(json, ".currency0"));
        MockERC20 c1 = MockERC20(vm.parseJsonAddress(json, ".currency1"));
        int24 spacing = int24(vm.parseJsonInt(json, ".tickSpacing"));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(c0)),
            currency1: Currency.wrap(address(c1)),
            fee: uint24(vm.parseJsonUint(json, ".fee")),
            tickSpacing: spacing,
            hooks: IHooks(vm.parseJsonAddress(json, ".hook"))
        });
        uint256 l = vm.envOr("DEPTH_L", uint256(1e17));
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        vm.startBroadcast(pk);
        c0.mint(me, 50_000_000 * 10 ** c0.decimals());
        c1.mint(me, 20_000 * 10 ** c1.decimals());
        c0.approve(address(router), type(uint256).max);
        c1.approve(address(router), type(uint256).max);
        router.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(spacing),
                tickUpper: TickMath.maxUsableTick(spacing),
                liquidityDelta: int256(l),
                salt: bytes32(uint256(0xde97))
            }),
            ""
        );
        vm.stopBroadcast();
        console2.log("added full-range liquidity", l);
    }
}
