# Unichain Sepolia deploy (chain id 1301)

Status: **deployed 2026-11-17** (deployer `0xA9B480C2694aa3F16cd109FCD2C91aCbf3BC689F`, funded by bridging Ethereum Sepolia ETH through the official L1StandardBridge `0xea58fcA6849d79EAd1f26608855c2D6407d54Ce2`).

| Contract | Address |
|---|---|
| HurdleHook | [`0xd0d744918B9a2657B6097e034D51B2D93524dA80`](https://sepolia.uniscan.xyz/address/0xd0d744918B9a2657B6097e034D51B2D93524dA80) |
| Patient vault (±10%) | [`0x72E67e9263E8c60811291d4e3F759612090316ca`](https://sepolia.uniscan.xyz/address/0x72E67e9263E8c60811291d4e3F759612090316ca) |
| Chaser vault (±2%) | [`0x8e7665e30D6bB124c5Ea7b4D340Cd6F07513603C`](https://sepolia.uniscan.xyz/address/0x8e7665e30D6bB124c5Ea7b4D340Cd6F07513603C) |
| mUSDC (currency0) | `0xAFdaE2704a1B9F3404125c2F7fbDB07fC427eB1c` |
| mWETH (currency1) | `0xd6BfbD3eb5ED7C718Ca6579E61034669Bc8a4349` |
| Liquidity router | `0xBFF633e3b4e1F0C9bD76F734062AeD0fa677ce8E` |

Full output: `script/out/deploy-1301.json`, `broadcast/DeployHurdleHook.s.sol/1301/run-latest.json`.

## Addresses and sources

| Item | Value | Source |
| --- | --- | --- |
| Chain id | `1301` | https://developers.uniswap.org/docs/unichain/technical-information/network-information |
| Public RPC | `https://sepolia.unichain.org` (rate limited, not for production) | same |
| Explorer | https://sepolia.uniscan.xyz | same |
| PoolManager | `0x00b036b58a818b1bc34d502d3fe730db729e62ac` | https://developers.uniswap.org/docs/protocols/v4/deployments (Unichain Sepolia: 1301) |
| PositionManager | `0xf969aee60879c54baaed9f3ed26147db216fd664` | same (not used by the script) |
| CREATE2 deployer | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | Standard deterministic deployer; not on the Uniswap page. Verified on-chain: `cast code` on 1301 returns the proxy bytecode. forge-std `CREATE2_FACTORY`. |

PoolManager and PositionManager were also confirmed to have code on 1301 via `cast code`.

## Faucets (Unichain Sepolia ETH)

Source: https://developers.uniswap.org/docs/unichain/tools/faucets

- Superchain faucet: https://app.optimism.io/faucet (0.05 ETH / 24h)
- QuickNode: https://faucet.quicknode.com/unichain/sepolia (12h)
- thirdweb: https://thirdweb.com/unichain-sepolia-testnet (24h)
- Circle (USDC only, not needed; script deploys mocks): https://faucet.circle.com/
- Bridge from Sepolia L1: https://superbridge.app/unichain-sepolia

Script cost is small (hook + 2 mocks + router + pool init + liquidity); 0.05 ETH is plenty.

## What the script does

`script/DeployHurdleHook.s.sol`:

1. Mines a salt (HookMiner, deployer = CREATE2 deployer) for flags `afterInitialize | beforeAddLiquidity | beforeRemoveLiquidity | beforeSwap` (`0x1A80`).
2. Deploys `HurdleHook` via CREATE2.
3. Deploys `mUSDC` (6 dec) and `mWETH` (18 dec) (solmate `MockERC20`), mints 1,000,000 mUSDC and 1,000 mWETH to the deployer.
4. Deploys a `PoolModifyLiquidityTest` router, initializes a fee 500 / tickSpacing 10 pool with the hook at 3000 USDC/ETH (tick 196256 with mUSDC as currency0), adds full-range liquidity (`L = 1e14`, about 1.8 mWETH + 5.5k mUSDC).
5. Writes `script/out/deploy-1301.json` (`-dryrun` suffix when not broadcasting).

Env: `PRIVATE_KEY` (required, env only). `POOL_MANAGER` optional override.

`vm.writeJson` needs write access to `script/out/`. `foundry.toml` is not changed; use `FOUNDRY_CONFIG=script/foundry.deploy.toml` (copy of foundry.toml plus that permission). `FOUNDRY_FS_PERMISSIONS` env did not work.

## Dry run (no broadcast), passed

```sh
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
FOUNDRY_CONFIG=script/foundry.deploy.toml \
forge script script/DeployHurdleHook.s.sol --fork-url https://sepolia.unichain.org
```

(That key is the public anvil key. Never fund it.)

## Broadcast command (for the user)

Fund the deployer first (faucets above), then:

```sh
export PRIVATE_KEY=0x<your key>
FOUNDRY_CONFIG=script/foundry.deploy.toml \
forge script script/DeployHurdleHook.s.sol \
  --rpc-url https://sepolia.unichain.org \
  --broadcast
```

Output: `script/out/deploy-1301.json` plus forge's `broadcast/DeployHurdleHook.s.sol/1301/run-latest.json`.
No `--verify` set: add `--verify --verifier blockscout --verifier-url https://unichain-sepolia.blockscout.com/api/` only if you have confirmed that explorer endpoint.

Before broadcasting, re-run the dry run: the mined hook address depends on `HurdleHook` bytecode, so any `src/` change moves it.

## Vaults

After the pool, the script deploys two `HurdleVault`s with the deployer as curator and depositor:
Patient (±950 ticks ≈ ±10%) and Chaser (±200 ticks ≈ ±2%). Each posts a bond of 5% of the
deposit value in token1, deposits 1 mWETH + 3000 mUSDC, and sets its range. Parameters: carry 20%,
fire below 2% bond/NAV, max spot–TWAP deviation 300 ticks, hourly epochs. Addresses land in the
JSON as `patientVault` / `chaserVault`. Dry run on a 1301 fork passed (2026-11-17).
