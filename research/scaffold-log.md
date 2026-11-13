# Foundry v4 hook scaffold — run log

Date: 2026-11-13
Toolchain: `forge 1.5.1-stable` (commit `b0a9dd9ceda36f63e2326ce530c10e6916f4b8a2`), solc `0.8.26` (installed by forge).

## Reference and pins

Reference template: https://github.com/uniswapfoundation/v4-template

The template's current HEAD switched to `lib/uniswap-hooks` (OpenZeppelin) with nested
`v4-core`/`v4-periphery`. This scaffold uses the template layout that installs
`v4-core` and `v4-periphery` directly as submodules: template commit
`f4c2ed0` ("Update (#45)"). Pins are copied from that commit's gitlinks:

| Submodule | Commit |
| --- | --- |
| `lib/forge-std` | `6e05729b76f1ae0d437e74951aef1ca987788ab3` |
| `lib/v4-core` | `362c9cab7c03ca1122795aed2e8e118de9ed186e` |
| `lib/v4-periphery` | `2768c3d578a5ffeec0bc51abcd8e472cb68f8a93` |

`foundry.toml`, `remappings.txt` and `test/utils/HookMiner.sol` match that template
commit. `forge-std` is remapped to `lib/v4-core/lib/forge-std/src/` exactly as the
template does, because v4-core at this pin calls `vm.snapshotGasLastCall`, which is
absent from forge-std `6e05729` (`v1.8.2-5`).

## Install commands

GitHub clones were throttled in this environment, so the same pinned commits were
served from local bare mirrors of already-present checkouts via git URL rewriting.
The recorded `.gitmodules` URLs and the resulting SHAs are the upstream ones.

```bash
cd /home/bills/code/hurdle

forge install foundry-rs/forge-std@6e05729b76f1ae0d437e74951aef1ca987788ab3

GIT_CONFIG_COUNT=2 \
GIT_CONFIG_KEY_0='url.file:///tmp/opencode/mirrors/.insteadOf' \
GIT_CONFIG_VALUE_0='https://github.com/' \
GIT_CONFIG_KEY_1='protocol.file.allow' \
GIT_CONFIG_VALUE_1='always' \
forge install uniswap/v4-core@362c9cab7c03ca1122795aed2e8e118de9ed186e

GIT_CONFIG_COUNT=2 \
GIT_CONFIG_KEY_0='url.file:///tmp/opencode/mirrors/.insteadOf' \
GIT_CONFIG_VALUE_0='https://github.com/' \
GIT_CONFIG_KEY_1='protocol.file.allow' \
GIT_CONFIG_VALUE_1='always' \
forge install uniswap/v4-periphery@2768c3d578a5ffeec0bc51abcd8e472cb68f8a93
```

Verified submodule state:

```
+6e05729b76f1ae0d437e74951aef1ca987788ab3 lib/forge-std (v1.8.2-5-g6e05729)
 362c9cab7c03ca1122795aed2e8e118de9ed186e lib/v4-core (v4.0.0~8)
 2768c3d578a5ffeec0bc51abcd8e472cb68f8a93 lib/v4-periphery (2768c3d)
```

## Build and test commands

```bash
cd /home/bills/code/hurdle
forge build
forge test -vv
```

`forge build` result:

```
Compiling 93 files with Solc 0.8.26
Solc 0.8.26 finished in 8.27s
Compiler run successful!
```

Final `forge test -vv` output:

```
No files changed, compilation skipped

Ran 1 test for test/HurdleHook.t.sol:HurdleHookTest
[PASS] test_swapSucceeds() (gas: 586448)
Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 137.26ms (2.78ms CPU time)

Ran 1 test suite in 141.13ms (137.26ms CPU time): 1 tests passed, 0 failed, 0 skipped (1 total tests)
```

Result: **1 passed, 0 failed**.

## What the test covers

`test/HurdleHook.t.sol`:

1. Deploys `PoolManager` plus the v4 test routers, and mints/approves two mock currencies.
2. Mines a CREATE2 salt with `HookMiner` for flags
   `BEFORE_ADD_LIQUIDITY | BEFORE_REMOVE_LIQUIDITY | AFTER_SWAP`, deploys `HurdleHook`
   at that address, and asserts the mined and deployed addresses match.
3. Initializes a `3000` fee / `60` tick-spacing pool at `SQRT_PRICE_1_1` and adds
   liquidity (which exercises `beforeAddLiquidity`).
4. Executes one `zeroForOne` swap and asserts the returned `BalanceDelta` is non-zero.

`src/HurdleHook.sol` is scaffold-only: `getHookPermissions` enables
`beforeAddLiquidity`, `beforeRemoveLiquidity` and `afterSwap`, and each body returns
its selector (`afterSwap` returns `(selector, 0)`). No accounting logic yet.
