// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {HurdleVault} from "./HurdleVault.sol";

/// Deploys HurdleVaults only on pools whose hook is the canonical HurdleHook, so the vault's oracle
/// (the pool's hook) is pinned onchain: a depositor checks `isVault(vault)` instead of the hook by hand.
contract HurdleVaultFactory {
    IPoolManager public immutable manager;
    address public immutable hook;
    mapping(address => bool) public isVault;

    event VaultCreated(address indexed vault, address indexed curator, bytes32 indexed poolId);

    error WrongHook();

    constructor(IPoolManager _manager, address _hook) {
        manager = _manager;
        hook = _hook;
    }

    /// The caller becomes the vault's curator.
    function create(PoolKey calldata key, uint16 carryBps, uint16 minBondBps, int24 maxTickDeviation, uint32 epochSeconds)
        external
        returns (HurdleVault vault)
    {
        if (address(key.hooks) != hook) revert WrongHook();
        vault = new HurdleVault(manager, key, msg.sender, carryBps, minBondBps, maxTickDeviation, epochSeconds);
        isVault[address(vault)] = true;
        emit VaultCreated(address(vault), msg.sender, keccak256(abi.encode(key)));
    }
}
