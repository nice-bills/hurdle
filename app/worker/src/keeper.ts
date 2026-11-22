import { BaseError, ContractFunctionRevertedError, createWalletClient, decodeAbiParameters, decodeErrorResult, http, formatEther, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, lc, readSlot0, computePoolId, type Client } from "./chain.js";
import { deployment, env, erc20Abi, hookAbi, swapTestAbi, vaultAbi } from "./config.js";
import type { Db } from "./db.js";
import { state } from "./state.js";
import { getSqrtPriceAtTick, maxUsableTick, minUsableTick } from "./tickmath.js";
import { errMsg, log, sleep, withRetry } from "./util.js";

const MIN_ETH = BigInt(process.env.KEEPER_MIN_ETH_WEI ?? "300000000000000"); // default 0.0003 ETH: below this the keeper skips transactions
const USDC = 10n ** 6n;
const WETH = 10n ** 18n;
const MIN_USDC = 20_000n * USDC;
const MINT_USDC = 1_000_000n * USDC;
const MIN_WETH = 10n * WETH;
const MINT_WETH = 100n * WETH;
const MAX_UINT = (1n << 256n) - 1n;

/** Reverts the keeper expects in normal operation: a simulation failing with one of these is skipped, not a failure. */
export const EXPECTED_REVERTS = new Set(["AlreadyParked", "EpochNotOver", "PriceDeviation"]);
const SKIP_EVERY_MS = 60 * 60 * 1000; // record one skipped row per vault/action per hour
const WRAPPED_ERROR = "0x90bfb865"; // PoolManager WrappedError(address target, bytes4 selector, bytes reason, bytes details)

/** Custom-error name from raw revert data; unwraps PoolManager WrappedError (hook reverts surface that way). */
export function revertNameFromRaw(raw: unknown, depth = 0): string | undefined {
  if (typeof raw !== "string" || raw.length < 10 || depth > 2) return undefined;
  if (raw.slice(0, 10).toLowerCase() === WRAPPED_ERROR) {
    try {
      const [, , reason] = decodeAbiParameters([{ type: "address" }, { type: "bytes4" }, { type: "bytes" }, { type: "bytes" }], ("0x" + raw.slice(10)) as Hex);
      return revertNameFromRaw(reason, depth + 1);
    } catch {
      return undefined;
    }
  }
  for (const abi of [vaultAbi, hookAbi]) {
    try {
      return decodeErrorResult({ abi, data: raw as Hex }).errorName;
    } catch {
      /* try next ABI */
    }
  }
  return undefined;
}

/** Decoded custom-error name of a simulation/call revert, or undefined when it is not a decodable revert. */
export function revertName(e: unknown): string | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const rev = e.walk((x) => x instanceof ContractFunctionRevertedError);
  if (!(rev instanceof ContractFunctionRevertedError)) return undefined;
  return rev.data?.errorName ?? revertNameFromRaw((rev as unknown as { raw?: string }).raw);
}

interface TxReq {
  address: Hex;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export function makeKeeper(db: Db, client: Client) {
  if (!env.keeperKey) return null;
  const account = privateKeyToAccount(env.keeperKey);
  const wallet = createWalletClient({ account, chain, transport: http(env.rpcUrl, { retryCount: 2, retryDelay: 800, timeout: 30_000 }) });
  state.keeperAddress = account.address;

  const key = {
    currency0: deployment.currency0,
    currency1: deployment.currency1,
    fee: deployment.fee,
    tickSpacing: deployment.tickSpacing,
    hooks: deployment.hook,
  };
  const poolId = computePoolId();

  async function record(action: string, vault: string | null, tx: string | null, ok: boolean, note: string | null) {
    state.lastKeeperAction = { ts: new Date().toISOString(), action, vault, tx, ok, note };
    log("keeper", `${action}${vault ? " " + vault : ""} ${ok ? "ok" : "FAILED"}${tx ? " " + tx : ""}${note ? " :: " + note : ""}`);
    await insertRun(action, vault, tx, ok, false, note);
  }

  async function insertRun(action: string, vault: string | null, tx: string | null, ok: boolean, skipped: boolean, note: string | null) {
    try {
      await db.query("INSERT INTO keeper_runs (action,vault,tx,ok,skipped,note) VALUES ($1,$2,$3,$4,$5,$6)", [action, vault ? lc(vault) : null, tx, ok, skipped, note]);
    } catch (e) {
      log("keeper", `could not record run: ${errMsg(e)}`);
    }
  }

  /** The call would revert for an expected reason: nothing to do. Logged always, stored at most once per hour per vault/action. */
  async function recordSkipped(action: string, vault: string | null, reason: string) {
    log("keeper", `${action}${vault ? " " + vault : ""} skipped (${reason})`);
    try {
      const recent = await db.query(
        "SELECT 1 FROM keeper_runs WHERE skipped AND action=$1 AND vault IS NOT DISTINCT FROM $2 AND ts > now() - ($3 * interval '1 millisecond') LIMIT 1",
        [action, vault ? lc(vault) : null, SKIP_EVERY_MS],
      );
      if (recent.rows.length) return;
    } catch (e) {
      log("keeper", `skip throttle lookup failed: ${errMsg(e)}`);
      return;
    }
    await insertRun(action, vault, null, false, true, reason);
  }

  /** simulate -> send -> wait. Never throws; returns whether it succeeded on chain.
   *  A simulation that reverts with an expected reason (EXPECTED_REVERTS) is recorded as skipped, not failed. */
  async function send(action: string, vault: string | null, req: TxReq, note?: string): Promise<boolean> {
    let hash: Hex | undefined;
    try {
      let request: unknown;
      try {
        ({ request } = await withRetry(() => client.simulateContract({ account, ...req } as never), `simulate ${action}`, 4));
      } catch (e) {
        const name = revertName(e);
        if (name && EXPECTED_REVERTS.has(name)) {
          await recordSkipped(action, vault, name);
          return false;
        }
        throw e;
      }
      hash = await wallet.writeContract(request as never);
      const rc = await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
      const ok = rc.status === "success";
      await record(action, vault, hash, ok, ok ? (note ?? null) : "transaction reverted on chain");
      return ok;
    } catch (e) {
      await record(action, vault, hash ?? null, false, errMsg(e));
      return false;
    }
  }

  async function refreshBalance() {
    try {
      state.keeperBalanceWei = await withRetry(() => client.getBalance({ address: account.address }), "balance", 4);
    } catch (e) {
      log("keeper", `balance read failed: ${errMsg(e)}`);
    }
    return state.keeperBalanceWei;
  }

  const bal = (token: Hex) =>
    withRetry(() => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }) as Promise<bigint>, "erc20 balance", 4);

  async function ensureMocks(): Promise<boolean> {
    let ok = true;
    const router = deployment.swapRouter;
    for (const [token, min, mint, label] of [
      [deployment.currency0, MIN_USDC, MINT_USDC, "mUSDC"],
      [deployment.currency1, MIN_WETH, MINT_WETH, "mWETH"],
    ] as const) {
      if ((await bal(token)) < min) {
        ok = (await send(`mint_${label}`, null, { address: token, abi: erc20Abi, functionName: "mint", args: [account.address, mint] })) && ok;
      }
      const allowance = (await withRetry(
        () => client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account.address, router] }),
        "allowance",
        4,
      )) as bigint;
      if (allowance < MAX_UINT / 2n) {
        ok = (await send(`approve_${label}`, null, { address: token, abi: erc20Abi, functionName: "approve", args: [router, MAX_UINT] })) && ok;
      }
    }
    return ok;
  }

  /** Small round trip: ~5 ticks down then back to the starting price. Volume, fees and fresh TWAP observations. */
  async function roundTrip() {
    const s0 = await withRetry(() => readSlot0(client, poolId), "slot0", 4);
    const settings = { takeClaims: false, settleUsingBurn: false };
    const swap = (zeroForOne: boolean, amount: bigint, limit: bigint) => ({
      address: deployment.swapRouter,
      abi: swapTestAbi,
      functionName: "swap",
      args: [key, { zeroForOne, amountSpecified: amount, sqrtPriceLimitX96: limit }, settings, "0x"],
    });
    const down = await send(
      "swap_down",
      null,
      swap(true, -(5n * 10n ** 16n), getSqrtPriceAtTick(s0.tick - 5)) as TxReq,
      `from tick ${s0.tick}`,
    );
    // Return leg even if the first failed after landing? Only when it succeeded, otherwise price is unchanged.
    if (!down) return;
    // The public RPC is load-balanced and can answer from a block before the down leg; simulating the
    // return leg there reverts PriceLimitAlreadyExceeded (spot == limit). Wait until spot is visibly below s0.
    for (let i = 0; i < 15; i++) {
      const s1 = await withRetry(() => readSlot0(client, poolId), "slot0", 4);
      if (s1.sqrtPriceX96 < s0.sqrtPriceX96) {
        await send("swap_up", null, swap(false, -(10n ** 30n), s0.sqrtPriceX96) as TxReq, `back to sqrtPrice ${s0.sqrtPriceX96}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    log("keeper", "swap_up skipped: RPC never showed the down leg");
  }

  async function vaultList(): Promise<string[]> {
    const set = new Set<string>([lc(deployment.patientVault), lc(deployment.chaserVault)]);
    try {
      for (const r of (await db.query("SELECT address FROM vaults")).rows) set.add(r.address as string);
    } catch (e) {
      log("keeper", `vault list from DB failed, using deployment vaults only: ${errMsg(e)}`);
    }
    return [...set];
  }

  async function maintainVaults() {
    const block = await withRetry(() => client.getBlock(), "latest block", 4);
    const now = block.timestamp;
    const full = { lo: minUsableTick(deployment.tickSpacing), hi: maxUsableTick(deployment.tickSpacing) };
    for (const addr of await vaultList()) {
      const v = addr as Hex;
      try {
        const r = await withRetry(
          () =>
            client.multicall({
              contracts: ["epochStart", "epochSeconds", "fired", "position", "totalSupply"].map((functionName) => ({ address: v, abi: vaultAbi as Abi, functionName })),
              allowFailure: false,
            }),
          `vault state ${addr}`,
          4,
        );
        const [epochStart, epochSeconds, fired, pos] = r as [bigint, number, boolean, readonly [number, number, bigint]];
        const due = now >= epochStart + BigInt(epochSeconds);
        log("keeper", `vault ${addr}: ${due ? "epoch over, settling" : `epoch ends in ${Number(epochStart) + Number(epochSeconds) - Number(now)}s`}${fired ? ", FIRED" : ""}`);
        if (due) {
          await send("settle", addr, { address: v, abi: vaultAbi, functionName: "settle" });
        }
        if (fired) {
          const parked = Number(pos[0]) === full.lo && Number(pos[1]) === full.hi;
          if (!parked) {
            // Anyone may finish the park after firing. Reverts (e.g. AlreadyParked, price bands) are recorded, not fatal.
            await send("rebalance_park", addr, { address: v, abi: vaultAbi, functionName: "rebalance", args: [0, 0] });
          }
        }
      } catch (e) {
        await record("vault_check", addr, null, false, errMsg(e));
      }
    }
  }

  async function tick() {
    const eth = await refreshBalance();
    if (eth !== null && eth < MIN_ETH) {
      await record("skip_low_gas", null, null, false, `keeper balance ${formatEther(eth)} ETH is below ${formatEther(MIN_ETH)}; fund ${account.address}`);
      return;
    }
    // Swaps need funded, approved mocks; settling/parking does not, so it runs regardless.
    if (await ensureMocks()) await roundTrip();
    await maintainVaults();
    await refreshBalance();
    state.lastKeeperRunAt = Date.now();
  }

  return {
    address: account.address,
    tick,
    async run(signal: { stopped: boolean }) {
      log("keeper", `starting; keeper ${account.address}, every ${env.keeperMs / 1000}s`);
      await refreshBalance();
      await sleep(15_000);
      while (!signal.stopped) {
        try {
          await tick();
        } catch (e) {
          state.lastKeeperError = errMsg(e);
          log("keeper", `tick error (continuing): ${errMsg(e)}`);
        }
        await sleep(env.keeperMs);
      }
    },
  };
}
