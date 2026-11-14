// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {HurdleHook} from "../src/HurdleHook.sol";
import {HookMiner} from "../test/utils/HookMiner.sol";

/// @notice Mines a flag-correct salt and deploys HurdleHook via CREATE2.
/// @dev Set POOL_MANAGER to the v4 PoolManager address before running.
contract DeployHurdleHook is Script {
    function run() external returns (HurdleHook hook) {
        IPoolManager manager = IPoolManager(vm.envAddress("POOL_MANAGER"));

        uint160 flags = uint160(
            Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
                | Hooks.AFTER_INITIALIZE_FLAG
        );

        // The deployer must match the account broadcasting the CREATE2 transaction.
        (address hookAddress, bytes32 salt) =
            HookMiner.find(msg.sender, flags, type(HurdleHook).creationCode, abi.encode(address(manager)));

        vm.startBroadcast();
        hook = new HurdleHook{salt: salt}(manager);
        vm.stopBroadcast();

        require(address(hook) == hookAddress, "DeployHurdleHook: hook address mismatch");
        console2.log("HurdleHook deployed at", address(hook));
    }
}
