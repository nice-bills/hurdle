# Unichain Sepolia deploy (chain id 1301)

Status: **historical.** The current deployment is v4 (hook, factory, three vaults, 2026-11-22); see the README "Unichain Sepolia" table, `script/out/deploy-1301.json` and `app/shared/deployment-1301.json`. The text below describes the second-audit deploy (2026-11-17) and older ones. The first deposit is funded by the curator (deployer) with shares minted
to a separate depositor address derived from the deployer key (`keccak256(abi.encode(pk, "hurdle-depositor"))`),
so the bond really covers it. To withdraw as the depositor, rebuild that key locally; it is never logged.
Deploy with `FOUNDRY_CONFIG=script/foundry.deploy.toml` (optimizer; vault 18.7 KB).

Superseded (first audit fixes): hook `0x9BaaB91A2DFB8fF9b9D86D5067E67435d56090a0`, Patient
`0x448071dAbcF890D6f89FB108803c20461f0D86e8`, Chaser `0x0B33F9959107469Fb0913B69f2459Cb07d18d68f`, mUSDC
`0x01b5BFD7756e9f525152D6D62569c33279816b25`, mWETH `0xa30F0653de83907C4B63dcB50cc7d019058f2B14`.

Superseded (pre-audit, deployed 2026-11-17, deployer `0xA9B480C2694aa3F16cd109FCD2C91aCbf3BC689F`, funded by bridging Ethereum Sepolia ETH through the official L1StandardBridge `0xea58fcA6849d79EAd1f26608855c2D6407d54Ce2`):

| Contract | Address |
|---|---|
| HurdleHook | [`0xd0d744918B9a2657B6097e034D51B2D93524dA80`](https://sepolia.uniscan.xyz/address/0xd0d744918B9a2657B6097e034D51B2D93524dA80) |
| Patient vault (±10%) | [`0x72E67e9263E8c60811291d4e3F759612090316ca`](https://sepolia.uniscan.xyz/address/0x72E67e9263E8c60811291d4e3F759612090316ca) |
| Chaser vault (±2%) | [`0x8e7665e30D6bB124c5Ea7b4D340Cd6F07513603C`](https://sepolia.uniscan.xyz/address/0x8e7665e30D6bB124c5Ea7b4D340Cd6F07513603C) |
| mUSDC (currency0) | `0xAFdaE2704a1B9F3404125c2F7fbDB07fC427eB1c` |
| mWETH (currency1) | `0xd6BfbD3eb5ED7C718Ca6579E61034669Bc8a4349` |
| Liquidity router | `0xBFF633e3b4e1F0C9bD76F734062AeD0fa677ce8E` |

Pre-audit output: `script/out/deploy-1301-preaudit.json` (renamed so the redeploy does not overwrite it), `broadcast/DeployHurdleHook.s.sol/1301/run-latest.json`.

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

## Why two steps

`HurdleHook.twapTick` reverts until the pool has 10 minutes of history (`MIN_TWAP_WINDOW`). The vault's first
deposit and every rebalance price at the TWAP, so vaults cannot be set up in the same transaction batch as the
pool. Step 1 creates the pool; step 2 runs at least 10 minutes later. No swap is needed in between: while
nobody trades, the TWAP equals the initial tick. (`PoolSwapTest` is deployed in step 1 as `swapRouter` for
demo trades; step 2 does not use it.)

## What the scripts do

`script/DeployHurdleHook.s.sol` (step 1):

1. Mines a salt (HookMiner, deployer = CREATE2 deployer) for flags `afterInitialize | beforeSwap | beforeDonate`.
2. Deploys `HurdleHook` via CREATE2.
3. Deploys `mUSDC` (6 dec) and `mWETH` (18 dec) (solmate `MockERC20`), mints 1,000,000 mUSDC and 1,000 mWETH to the deployer.
4. Deploys a `PoolModifyLiquidityTest` router and a `PoolSwapTest` router, initializes a fee 500 / tickSpacing 10 pool with the hook at 3000 USDC/ETH, adds full-range liquidity (`L = 1e14`, about 1.8 mWETH + 5.5k mUSDC).
5. Writes `script/out/deploy-<chainid>.json` (`-dryrun` suffix when not broadcasting; `DEPLOY_JSON` overrides the path).

`script/DeployVaults.s.sol` (step 2, at least 10 minutes later, same key):

1. Reads the JSON from step 1 (`DEPLOY_JSON`, default `script/out/deploy-<chainid>.json`) and checks `hook.twapTick` does not revert. If it does it stops with "pool has < 10 min of history".
2. Deploys Patient (±950 ticks ≈ ±10%) and Chaser (±200 ticks ≈ ±2%) `HurdleVault`s with the deployer as curator and depositor. Parameters: carry 2000 bps (20%), minBond 200 bps (2%), maxTickDeviation 50, epoch 3600 s.
3. Each vault: `postBond` (5% of the deposit, in token1), first `deposit` of 1 mWETH + 3000 mUSDC, `rebalance` around the current tick.
4. Adds `patientVault` and `chaserVault` to the JSON. Without `--broadcast` it writes `script/out/deploy-<chainid>-vaults-dryrun.json` instead and leaves the input alone.

Env: `PRIVATE_KEY` (required, env only). `POOL_MANAGER` optional override (step 1).

Both scripts need `FOUNDRY_CONFIG=script/foundry.deploy.toml`. It is `foundry.toml` plus write access to
`script/out/` and **`optimizer = true`**: with the default (unoptimized) build the vault's runtime is 28.4 KB,
over the 24,576-byte EIP-170 limit, and the vault deploy fails with `CreateContractSizeLimit`. With the
optimizer it is 18.3 KB. The mined hook address depends on the build, so always compile with this config.
`FOUNDRY_FS_PERMISSIONS` env did not work.

Check the output for `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL` before trusting the JSON: the JSON is
written during the simulation, before forge sends the transactions.

## Dry run (no broadcast)

```sh
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # public anvil key, never fund it
FOUNDRY_CONFIG=script/foundry.deploy.toml \
forge script script/DeployHurdleHook.s.sol --fork-url https://sepolia.unichain.org
```

Step 2 cannot be dry-run against the real chain until step 1 is broadcast and 10 minutes old (it needs the pool).

## Tested on a local anvil fork (passed)

```sh
anvil --fork-url https://sepolia.unichain.org --chain-id 31337 --port 8546 &   # 31337 keeps run-latest.json for 1301 untouched
export FOUNDRY_CONFIG=script/foundry.deploy.toml DEPLOY_JSON=script/out/deploy-anvil.json
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
forge script script/DeployHurdleHook.s.sol --rpc-url http://127.0.0.1:8546 --broadcast
forge script script/DeployVaults.s.sol --rpc-url http://127.0.0.1:8546 --broadcast   # fails with "< 10 min of history"
cast rpc --rpc-url http://127.0.0.1:8546 evm_increaseTime 700 && cast rpc --rpc-url http://127.0.0.1:8546 evm_mine
forge script script/DeployVaults.s.sol --rpc-url http://127.0.0.1:8546 --broadcast   # succeeds
```

Result (2026-11-17): step 1 succeeded; step 2 reverted before the time bump with the readable message and
succeeded after it. Patient range 195300–197200, Chaser 196050–196450, bond 0.1 mWETH (token1) each, not fired.

## Broadcast commands (for the user)

Fund the deployer first (faucets above). **Step 1**:

```sh
export PRIVATE_KEY=0x<your key>
FOUNDRY_CONFIG=script/foundry.deploy.toml \
forge script script/DeployHurdleHook.s.sol \
  --rpc-url https://sepolia.unichain.org \
  --broadcast
```

Wait **at least 10 minutes** (`MIN_TWAP_WINDOW`; 15 is safe given block-time slop). Then **step 2** with the same
`PRIVATE_KEY`:

```sh
FOUNDRY_CONFIG=script/foundry.deploy.toml \
forge script script/DeployVaults.s.sol \
  --rpc-url https://sepolia.unichain.org \
  --broadcast
```

Output: `script/out/deploy-1301.json` (hook, mocks, routers, pool; then vault addresses added by step 2) plus
forge's `broadcast/<script>/1301/run-latest.json`. If step 2 stops with "< 10 min of history", it failed in the simulation and sent nothing: wait and rerun it.
No `--verify` set: add `--verify --verifier blockscout --verifier-url https://unichain-sepolia.blockscout.com/api/` only if you have confirmed that explorer endpoint.

Before broadcasting, re-run the step 1 dry run: the mined hook address depends on `HurdleHook` bytecode, so any `src/` change moves it.
Redeploy done 2026-11-17 (step 1 11:25 UTC, step 2 12 min later); the superseded table above is history.

## Operations notes (round 4)

- **Live flow is synthetic.** Nothing trades the testnet pool except the worker keeper (round trips, `ROUNDTRIP_WETH`,
  `ROUNDTRIP_TICKS`) and the arbitrage leg that returns spot to `TARGET_TICK` (default: the 1 h TWAP at first start,
  then the value stored in the `cursor` table). Carry on the live vaults is that script's output.
- **Do not deploy the worker near the deadline.** Each worker redeploy restarts the process: the keeper's first
  tick is delayed (15 s boot + a full interval), uptime resets, and a deploy in the judging window can leave a
  settlement or park step unserved for minutes. Freeze worker deploys (code and env) well before submission; the
  target tick and all state live in Postgres, so a late restart is safe, only late.
- Fee cap scales by tier since the v6 vault: redeploying the factory/vaults is needed to get it onchain
  (`research/fee-cap.md` section 6). Size check: `HurdleVaultFactory` embeds the vault, runtime 24,559 B vs 24,576
  (EIP-170) with `script/foundry.deploy.toml` (optimizer on, 200 runs): 17 B of headroom, so any further vault change
  must be re-measured with `forge build --sizes`.


## Deployment history

Moved here from the README (v3/v4/v5 detail and superseded deployments). Full outputs: `script/out/deploy-1301-v*.json`.

**Earlier deployment (v5, 2026-11-26): Reckless was fired on-chain.** Kept read-only in the app; full output: `script/out/deploy-1301-v5.json`. Factory `0x77d21c4464290826651583eF6cF43dC1018d9e74` (start block 68852678), hook `0x3FB6cbbAA8c703830c126F59416DBe249d5D50A0`, Patient `0xE4192E10c36d46bfBE8aCD7dDe5e1e0978410c50`, Chaser `0xd4D69331910E6753B26984d6a082bb16Aa972398`, Reckless `0x594560B41d30DC10D82a2633757036b840C07075`. A scripted -593-tick move at 15:00 UTC fired Reckless at the 15:58 UTC settle; Patient and Chaser paid 50 / 40 mUSDC and were refilled; the curator bot re-centred Chaser at 16:46 UTC.

**v6 redeploy:** same audited contracts plus the round-4 fixes (fee cap scaled by tier, deposit gate mirrors v5, keeper arbitrage, curator auto-refill). See `research/council/v4-changelog.md`.

**Earlier still (v4, 2026-11-22): Reckless was fired on-chain.** History only; full output: `script/out/deploy-1301-v4.json`. Factory `0x17a372d93D5c11dfadfe453325315b9Dcfc98FdE` (start block 68509070), hook `0x9375e143A60547FAFaa22b53e5777A33667550A0`, Patient `0x5126c9Ebf2cF62e9f121F55886c57075a190b22d`, Chaser `0x1f4Db529B5a7a766D859E9EC25Dba3C01BeF0985`, Reckless `0x711fAb3A68aEAFbFE6Df493e676070D550ac5EEC`, mUSDC (currency0) `0x19e9DC387bbFf0c035d12dEFceEFF1fc0D859C49`, mWETH (currency1, bond token) `0x4F4C59E9089C43785ecc2B8780F61Ca349946bb4`.

The v4 vaults were deployed before the "fired vaults skip the deficit gate" fix, so the fired Reckless deficit was cleared by the curator's `reclaimBond` (done 2026-11-23, after the park completed). Pool depth was added with `script/AddDepth.s.sol` so the park could finish: before that, each park step converted only ~5% on the thin pool. A fresh deployment needs neither step.

What happened on-chain (v4). At 2026-11-22 15:46 UTC a scripted trade moved the price up 544 ticks (~5.6%),
out of Reckless's ±1% range (rehearsed on a fork first). At the 16:39 UTC settlement (block 68513152):
- Reckless missed par by 0.0487 mWETH (2.4% of NAV); its bond paid it, fell below ½ of the 2% floor, and the
  curator was fired in the same transaction (`Settled`, `Fired`, `Rebalanced` to full range). One hour later
  the last 0.0013 mWETH of bond paid the next shortfall; since then the vault tracks par passively.
- Patient and Chaser stayed in charge: their 10% bonds paid shortfalls of 0.014 and 0.012 mWETH. On
  2026-11-23 the curator posted that amount back (`postBond` pays the deficit down first), which reopened
  deposits on both.

**Earlier still (v3, 2026-11-21): Patient v3 was fired on-chain.** History only (no longer shown in the app); full output: `script/out/deploy-1301-v3.json`.

| Contract | Address |
|---|---|
| HurdleHook | [`0x7EECdD6507E77db3247C9E9bccFA0AcFf5F410a0`](https://sepolia.uniscan.xyz/address/0x7EECdD6507E77db3247C9E9bccFA0AcFf5F410a0) |
| HurdleVaultFactory | [`0x6afcE6f48644eECBA68d0b88E45496953720A904`](https://sepolia.uniscan.xyz/address/0x6afcE6f48644eECBA68d0b88E45496953720A904) |
| Patient vault (±10%), fired on-chain | [`0xa8F0dbf46b7C87477E6fe8FB4aE9474F7AF3Ba7D`](https://sepolia.uniscan.xyz/address/0xa8F0dbf46b7C87477E6fe8FB4aE9474F7AF3Ba7D) |
| Chaser vault (±2%) | [`0xB66277b0C38B99afcbeD6AB5554d2C3505E5749e`](https://sepolia.uniscan.xyz/address/0xB66277b0C38B99afcbeD6AB5554d2C3505E5749e) |
| mUSDC / mWETH | `0x16dED02f19B86f66335f0d05448D8EBAf2BBC18b` / `0x6Fe21Df36b9f00E9279640B0C5a2006d3a92F318` |

Both vaults: bond 5% of the deposit (0.1 mWETH), 1 mWETH + 3000 mUSDC deposited. What happened on-chain (events visible in the app and on Uniscan):


- 2026-11-21 19:46 UTC: scripted ETH −9.5% move. Both vaults missed par at the next settlements; their bonds
  paid depositors (Patient 0.054 mWETH, Chaser 0.031 mWETH).
- 2026-11-22 10:50 UTC: a second −9.5% leg. At 11:02 Patient's settlement paid its last 0.046 mWETH of bond and
  fired it (`Fired`); the vault was then parked full range by the keeper (`Rebalanced` to full range).
- Patient's 5% bond was not enough for two 9.5% drops on this thin test pool: its depositors end 0.77% below
  par. The guarantee is "par while the bond lasts"; sizing the bond is the curator's and depositors' choice.

Superseded (do not use):
- second-audit fixes: hook `0x23C23680100b77Acb606995dAD2Be470A30590A0`, vaults
  `0xc3A2f6f4BE0b437A2cC1C3844F86c999c7391b47`, `0x3CD34e0A6E6f9606F17e00e37544DcC2a70fE586`;
- first audit fixes: hook `0x9BaaB91A2DFB8fF9b9D86D5067E67435d56090a0`, vaults
  `0x448071dAbcF890D6f89FB108803c20461f0D86e8`, `0x0B33F9959107469Fb0913B69f2459Cb07d18d68f`;
- pre-audit: hook `0xd0d744918B9a2657B6097e034D51B2D93524dA80`, vaults
  `0x72E67e9263E8c60811291d4e3F759612090316ca`, `0x8e7665e30D6bB124c5Ea7b4D340Cd6F07513603C`.

