// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";
import {HurdleHook} from "../src/HurdleHook.sol";
import {HookMiner} from "../test/utils/HookMiner.sol";

/// @notice Step 1 of 2. Unichain Sepolia (1301): mine + deploy HurdleHook via the CREATE2 deployer, deploy mock
///         mUSDC/mWETH, a swap router and a liquidity router, initialize a fee-500 / tickSpacing-10 pool at
///         ~3000 USDC/ETH, seed full-range liquidity, write script/out/deploy-<chainid>.json.
///         The vaults come in step 2 (DeployVaults.s.sol), at least 10 minutes later: the hook's TWAP reverts
///         until the pool has HurdleHook.MIN_TWAP_WINDOW of history, and vault deposits/rebalances need it.
/// @dev Env: PRIVATE_KEY (required). POOL_MANAGER optional override; defaults to the Unichain Sepolia
///      PoolManager (https://developers.uniswap.org/docs/protocols/v4/deployments). DEPLOY_JSON optional
///      output path (default script/out/deploy-<chainid>.json, `-dryrun` suffix unless broadcasting).
///      Run with `FOUNDRY_CONFIG=script/foundry.deploy.toml` (adds write access to script/out). See research/deploy.md.
contract DeployHurdleHook is Script {
    address constant UNICHAIN_SEPOLIA_POOL_MANAGER = 0x00B036B58a818B1BC34d502D3fE730Db729e62AC;

    uint24 constant FEE = 500;
    int24 constant TICK_SPACING = 10;
    // MIN/MAX tick rounded to the spacing.
    int24 constant TICK_LOWER = -887270;
    int24 constant TICK_UPPER = 887270;
    // ~1.8 mWETH + ~5.5k mUSDC at 3000 USDC/ETH.
    int256 constant LIQUIDITY = 1e14;
    uint256 constant ETH_PRICE_USDC = 3000;

    struct Deployed {
        HurdleHook hook;
        MockERC20 usdc;
        MockERC20 weth;
        PoolModifyLiquidityTest router;
        PoolSwapTest swapRouter;
        PoolKey key;
    }

    function run() external returns (Deployed memory d) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        IPoolManager manager = IPoolManager(vm.envOr("POOL_MANAGER", UNICHAIN_SEPOLIA_POOL_MANAGER));

        uint160 flags = uint160(
            Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_DONATE_FLAG
        );

        // Under `forge script`, `new X{salt: s}` is sent through the deterministic CREATE2 deployer.
        (address hookAddress, bytes32 salt) =
            HookMiner.find(CREATE2_FACTORY, flags, type(HurdleHook).creationCode, abi.encode(address(manager)));

        vm.startBroadcast(pk);

        d.hook = new HurdleHook{salt: salt}(manager);
        require(address(d.hook) == hookAddress, "DeployHurdleHook: hook address mismatch");

        d.usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        d.weth = new MockERC20("Mock WETH", "mWETH", 18);
        d.usdc.mint(deployer, 1_000_000e6);
        d.weth.mint(deployer, 1_000e18);

        d.router = new PoolModifyLiquidityTest(manager);
        d.usdc.approve(address(d.router), type(uint256).max);
        d.weth.approve(address(d.router), type(uint256).max);
        d.swapRouter = new PoolSwapTest(manager);
        d.usdc.approve(address(d.swapRouter), type(uint256).max);
        d.weth.approve(address(d.swapRouter), type(uint256).max);

        // currency0 < currency1 by address.
        bool wethIs0 = address(d.weth) < address(d.usdc);
        d.key = PoolKey({
            currency0: Currency.wrap(wethIs0 ? address(d.weth) : address(d.usdc)),
            currency1: Currency.wrap(wethIs0 ? address(d.usdc) : address(d.weth)),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(d.hook))
        });
        manager.initialize(d.key, _sqrtPriceX96(wethIs0));

        d.router.modifyLiquidity(
            d.key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: TICK_LOWER, tickUpper: TICK_UPPER, liquidityDelta: LIQUIDITY, salt: 0
            }),
            ""
        );

        vm.stopBroadcast();

        _writeJson(d, deployer);
    }

    /// @dev sqrt(price * 2^192), price = currency1_raw / currency0_raw.
    ///      weth=0: 3000e6/1e18 ; usdc=0: 1e18/3000e6. Both products fit in 256 bits.
    function _sqrtPriceX96(bool wethIs0) internal pure returns (uint160) {
        uint256 usdcRaw = ETH_PRICE_USDC * 1e6;
        uint256 wethRaw = 1e18;
        uint256 num = wethIs0 ? usdcRaw : wethRaw;
        uint256 den = wethIs0 ? wethRaw : usdcRaw;
        return uint160(FixedPointMathLib.sqrt(num * (1 << 192) / den));
    }

    function _writeJson(Deployed memory d, address deployer) internal {
        string memory o = "deploy";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "deployer", deployer);
        vm.serializeAddress(o, "poolManager", address(d.hook.poolManager()));
        vm.serializeAddress(o, "hook", address(d.hook));
        vm.serializeAddress(o, "mUSDC", address(d.usdc));
        vm.serializeAddress(o, "mWETH", address(d.weth));
        vm.serializeAddress(o, "liquidityRouter", address(d.router));
        vm.serializeAddress(o, "swapRouter", address(d.swapRouter));
        vm.serializeUint(o, "poolInitializedAt", block.timestamp);
        vm.serializeAddress(o, "currency0", Currency.unwrap(d.key.currency0));
        vm.serializeAddress(o, "currency1", Currency.unwrap(d.key.currency1));
        vm.serializeUint(o, "fee", FEE);
        vm.serializeInt(o, "tickSpacing", TICK_SPACING);
        string memory json = vm.serializeBool(o, "broadcast", vm.isContext(VmSafe.ForgeContext.ScriptBroadcast));

        // Dry runs must not clobber/mimic a real deployment file.
        string memory suffix = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) ? "" : "-dryrun";
        string memory path = vm.envOr(
            "DEPLOY_JSON", string.concat("script/out/deploy-", vm.toString(block.chainid), suffix, ".json")
        );
        vm.createDir("script/out", true);
        vm.writeJson(json, path);
        console2.log("HurdleHook", address(d.hook));
        console2.log("wrote", path);
        console2.log("Run script/DeployVaults.s.sol at least 10 minutes after block time", block.timestamp);
    }
}
