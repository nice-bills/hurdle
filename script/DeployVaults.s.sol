// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {HurdleHook} from "../src/HurdleHook.sol";
import {HurdleVault} from "../src/HurdleVault.sol";
import {HurdleVaultFactory} from "../src/HurdleVaultFactory.sol";

/// @notice Step 2 of 2. Reads the JSON written by DeployHurdleHook.s.sol and deploys the Patient (±10%) and
///         Chaser (±2%) demo vaults on that pool through a HurdleVaultFactory pinned to the hook: post bond, first deposit, rebalance. Adds `patientVault` and
///         `chaserVault` to the JSON.
/// @dev Run at least 10 minutes after step 1: HurdleHook.twapTick reverts until the pool has 10 minutes of
///      history, and the first deposit and the rebalance both price at the TWAP. No swap is needed in between
///      (the TWAP equals the pool's initial tick while nobody trades). Env: PRIVATE_KEY (same key as step 1,
///      it holds the minted mocks), DEPLOY_JSON optional (default script/out/deploy-<chainid>.json). Without
///      --broadcast the result goes to script/out/deploy-<chainid>-vaults-dryrun.json, never over the input.
///      Params: carry 20%, minBond 2%, maxTickDeviation 50, epoch 3600 s. Bond 5% of the deposit.
///      The curator (deployer) funds the first deposit; shares go to a separate depositor address, so the
///      bond really covers them.
contract DeployVaults is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    int24 constant TICK_SPACING = 10;
    uint16 constant CARRY_BPS = 2000;
    uint16 constant MIN_BOND_BPS = 200;
    int24 constant MAX_TICK_DEVIATION = 50;
    uint32 constant EPOCH = 3600;

    struct Ctx {
        IPoolManager manager;
        HurdleHook hook;
        HurdleVaultFactory factory;
        MockERC20 usdc;
        MockERC20 weth;
        PoolKey key;
        bool wethIs0;
        string json;
        string path;
    }

    function run() external returns (HurdleVault patient, HurdleVault chaser) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        Ctx memory c = _load();

        // Fail early with a readable message instead of an opaque revert inside the vault.
        try c.hook.twapTick(c.key.toId()) returns (int24) {}
        catch {
            revert("DeployVaults: pool has < 10 min of history; wait (HurdleHook.MIN_TWAP_WINDOW) and rerun");
        }

        vm.startBroadcast(pk);
        (, int24 tick,,) = c.manager.getSlot0(c.key.toId());
        address depositor = _depositor(pk);
        c.factory = new HurdleVaultFactory(c.manager, address(c.hook));
        patient = _vault(c, vm.addr(pk), depositor, tick, 950);
        chaser = _vault(c, vm.addr(pk), depositor, tick, 200);
        vm.stopBroadcast();

        _write(c, patient, chaser, depositor);
    }

    function _load() internal view returns (Ctx memory c) {
        string memory inPath =
            vm.envOr("DEPLOY_JSON", string.concat("script/out/deploy-", vm.toString(block.chainid), ".json"));
        c.json = vm.readFile(inPath);
        c.manager = IPoolManager(vm.parseJsonAddress(c.json, ".poolManager"));
        c.hook = HurdleHook(vm.parseJsonAddress(c.json, ".hook"));
        c.usdc = MockERC20(vm.parseJsonAddress(c.json, ".mUSDC"));
        c.weth = MockERC20(vm.parseJsonAddress(c.json, ".mWETH"));
        c.key = PoolKey({
            currency0: Currency.wrap(vm.parseJsonAddress(c.json, ".currency0")),
            currency1: Currency.wrap(vm.parseJsonAddress(c.json, ".currency1")),
            fee: uint24(vm.parseJsonUint(c.json, ".fee")),
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(c.hook))
        });
        c.wethIs0 = address(c.weth) < address(c.usdc);
        c.path = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)
            ? inPath
            : string.concat("script/out/deploy-", vm.toString(block.chainid), "-vaults-dryrun.json");
    }

    /// The depositor must not be the curator: the bond covers only non-curator shares. Derived from the
    /// deployer key (keccak256(pk, "hurdle-depositor")), so the deployer can rebuild its key to withdraw.
    /// Only the address is ever logged or written.
    function _depositor(uint256 pk) internal pure returns (address) {
        return vm.addr(uint256(keccak256(abi.encode(pk, "hurdle-depositor"))));
    }

    /// Deployer is curator (the factory makes msg.sender the curator); it funds the first deposit with shares minted to `depositor`.
    /// Bond 5% of the deposit (token1); deposit 1 mWETH + 3000 mUSDC.
    function _vault(Ctx memory c, address curator, address depositor, int24 tick, int24 half)
        internal
        returns (HurdleVault v)
    {
        v = c.factory.create(c.key, CARRY_BPS, MIN_BOND_BPS, MAX_TICK_DEVIATION, EPOCH);
        require(v.curator() == curator, "factory curator");
        c.usdc.approve(address(v), type(uint256).max);
        c.weth.approve(address(v), type(uint256).max);
        v.postBond(c.wethIs0 ? 300e6 : 0.1e18); // token1 is mUSDC if mWETH is currency0
        (uint256 a0, uint256 a1) = c.wethIs0 ? (uint256(1e18), uint256(3000e6)) : (uint256(3000e6), uint256(1e18));
        v.firstDeposit(a0, a1, depositor);
        int24 mid = (tick / TICK_SPACING) * TICK_SPACING;
        v.rebalance(mid - half, mid + half);
    }

    /// Re-serializes the input JSON (every key step 1 wrote) plus the two vault addresses.
    function _write(Ctx memory c, HurdleVault patient, HurdleVault chaser, address depositor) internal {
        string memory o = "vaults";
        vm.serializeUint(o, "chainId", vm.parseJsonUint(c.json, ".chainId"));
        vm.serializeAddress(o, "deployer", vm.parseJsonAddress(c.json, ".deployer"));
        vm.serializeAddress(o, "poolManager", address(c.manager));
        vm.serializeAddress(o, "hook", address(c.hook));
        vm.serializeAddress(o, "mUSDC", address(c.usdc));
        vm.serializeAddress(o, "mWETH", address(c.weth));
        vm.serializeAddress(o, "liquidityRouter", vm.parseJsonAddress(c.json, ".liquidityRouter"));
        vm.serializeAddress(o, "swapRouter", vm.parseJsonAddress(c.json, ".swapRouter"));
        vm.serializeUint(o, "poolInitializedAt", vm.parseJsonUint(c.json, ".poolInitializedAt"));
        vm.serializeAddress(o, "currency0", Currency.unwrap(c.key.currency0));
        vm.serializeAddress(o, "currency1", Currency.unwrap(c.key.currency1));
        vm.serializeUint(o, "fee", c.key.fee);
        vm.serializeInt(o, "tickSpacing", TICK_SPACING);
        vm.serializeAddress(o, "factory", address(c.factory));
        vm.serializeAddress(o, "patientVault", address(patient));
        vm.serializeAddress(o, "chaserVault", address(chaser));
        vm.serializeAddress(o, "depositor", depositor);
        string memory json = vm.serializeBool(o, "broadcast", vm.isContext(VmSafe.ForgeContext.ScriptBroadcast));
        vm.writeJson(json, c.path);
        console2.log("Patient vault", address(patient));
        console2.log("Chaser vault", address(chaser));
        console2.log("wrote", c.path);
    }
}
