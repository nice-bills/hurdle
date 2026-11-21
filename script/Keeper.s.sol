// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {HurdleVault} from "../src/HurdleVault.sol";

/// @notice Live keeper for the Unichain Sepolia demo. One run = one keeper tick:
///   1. a trade: to TARGET_TICK if set (a scripted price move), else a small round-trip so the pool has
///      volume, fees and fresh TWAP observations;
///   2. `settle()` on each vault whose epoch is over (the keeper earns the settler bounty on carry);
///   3. if a vault is fired and not yet parked, `rebalance(0, 0)` to finish the park.
/// Env: PRIVATE_KEY (the deployer; holds the mocks), DEPLOY_JSON (default script/out/deploy-<chainid>.json),
/// TARGET_TICK (optional). Run it hourly from a shell loop; see research/deploy.md.
contract Keeper is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function run() external {
        string memory json = vm.readFile(
            vm.envOr("DEPLOY_JSON", string.concat("script/out/deploy-", vm.toString(block.chainid), ".json"))
        );
        IPoolManager manager = IPoolManager(vm.parseJsonAddress(json, ".poolManager"));
        PoolSwapTest router = PoolSwapTest(vm.parseJsonAddress(json, ".swapRouter"));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(vm.parseJsonAddress(json, ".currency0")),
            currency1: Currency.wrap(vm.parseJsonAddress(json, ".currency1")),
            fee: uint24(vm.parseJsonUint(json, ".fee")),
            tickSpacing: int24(vm.parseJsonInt(json, ".tickSpacing")),
            hooks: IHooks(vm.parseJsonAddress(json, ".hook"))
        });
        HurdleVault[2] memory vaults = [
            HurdleVault(vm.parseJsonAddress(json, ".patientVault")),
            HurdleVault(vm.parseJsonAddress(json, ".chaserVault"))
        ];

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        (uint160 sp, int24 tick,,) = manager.getSlot0(key.toId());
        PoolSwapTest.TestSettings memory st = PoolSwapTest.TestSettings(false, false);
        if (vm.envExists("TARGET_TICK")) {
            int24 target = int24(vm.envInt("TARGET_TICK"));
            uint160 limit = TickMath.getSqrtPriceAtTick(target);
            if (limit != sp) {
                router.swap(key, IPoolManager.SwapParams(limit < sp, -int256(1e30), limit), st, "");
            }
            console2.log("moved from tick", int256(tick));
            console2.log("to tick", int256(target));
        } else {
            // Round trip of ~0.05 of token0 at most 5 ticks each way: volume and fees, price unchanged.
            router.swap(key, IPoolManager.SwapParams(true, -0.05e18, TickMath.getSqrtPriceAtTick(tick - 5)), st, "");
            router.swap(key, IPoolManager.SwapParams(false, -int256(1e30), sp), st, "");
            console2.log("round trip at tick", int256(tick));
        }
        for (uint256 i; i < 2; ++i) {
            HurdleVault v = vaults[i];
            if (block.timestamp >= v.epochStart() + v.epochSeconds()) {
                v.settle();
                console2.log("settled", address(v));
            }
            if (v.fired()) {
                try v.rebalance(0, 0) {
                    console2.log("park step", address(v));
                } catch {}
            }
        }
        vm.stopBroadcast();
    }
}
