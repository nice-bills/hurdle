// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {HurdleHook} from "../src/HurdleHook.sol";
import {HookMiner} from "./utils/HookMiner.sol";

contract HurdleHookTest is Test, Deployers {
    HurdleHook hook;

    function setUp() public {
        // Deploy the pool manager, test routers, and two mock currencies.
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        // Mine a CREATE2 salt that gives the hook the permission bits it declares.
        uint160 flags = uint160(
            Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.AFTER_SWAP_FLAG
        );
        (address hookAddress, bytes32 salt) = HookMiner.find(
            address(this), flags, type(HurdleHook).creationCode, abi.encode(address(manager))
        );

        hook = new HurdleHook{salt: salt}(manager);
        assertEq(address(hook), hookAddress, "hook deployed to an unmined address");

        // Initialize the pool and seed liquidity (exercises beforeAddLiquidity).
        (key,) = initPoolAndAddLiquidity(currency0, currency1, IHooks(address(hook)), 3000, SQRT_PRICE_1_1);
    }

    function test_swapSucceeds() public {
        BalanceDelta delta = swap(key, true, -1e18, ZERO_BYTES);

        assertTrue(delta.amount0() != 0 || delta.amount1() != 0, "swap produced an empty delta");
    }
}
