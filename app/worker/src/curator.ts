import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, lc, readSlot0, computePoolId, type Client } from "./chain.js";
import { deployment, env, erc20Abi, vaultAbi } from "./config.js";
import type { Db } from "./db.js";
import { makeSender } from "./keeper.js";
import { state } from "./state.js";
import { maxUsableTick, minUsableTick } from "./tickmath.js";
import { errMsg, log, sleep, withRetry } from "./util.js";

const MAX_UINT = (1n << 256n) - 1n;
const IDLE_REDEPLOY_BPS = 200; // redeploy when idle funds exceed 2% of NAV (the same bound passed as maxIdleBps)
const MAX_ROUTINE_REBALANCES = 3; // keep one of the 4 per-epoch slots for an out-of-range re-centre

/** Reverts the curator bot expects in normal operation: recorded as skipped, not failed. */
export const CURATOR_EXPECTED = new Set(["PriceDeviation", "TooManyRebalances", "BondBelowFloor", "RebalanceIncomplete"]);
const EDGE_FRACTION = 0.2; // re-center when spot is within 20% of the half-width of an edge
const MAX_IDLE_BPS = 200;
const DEPOSIT_WINDOW = 300; // seconds at the start of an epoch; matches HurdleVault.DEPOSIT_WINDOW

/** New [lo, hi] centred on `tick`, same width as the current position, aligned to tickSpacing; null when no move is needed. */
export function planRecenter(tick: number, lo: number, hi: number, spacing: number, minTick: number, maxTick: number): [number, number] | null {
  if (lo <= minTick && hi >= maxTick) return null; // full range: parked or passive, nothing to centre
  const width = hi - lo;
  const half = width / 2;
  const outside = tick < lo || tick > hi;
  const nearEdge = Math.min(tick - lo, hi - tick) < half * EDGE_FRACTION;
  if (!outside && !nearEdge) return null;
  const newLo = Math.floor((tick - half) / spacing) * spacing;
  const newHi = newLo + Math.round(width / spacing) * spacing;
  if (newLo === lo && newHi === hi) return null;
  return [newLo, newHi];
}

/**
 * Explicit allow-list: the bot manages ONLY Patient and Chaser. Reckless is deliberately unmanaged ("built to get
 * fired") and never recentred, and vaults other people create are never touched. Source: deployment-1301.json.
 */
export const curatorVaults = (): string[] => [lc(deployment.patientVault), lc(deployment.chaserVault)];

/** Optional bot: keeps the curator's own demo vaults centred on spot. Enabled only with CURATOR_PRIVATE_KEY. */
export function makeCurator(db: Db, client: Client) {
  if (!env.curatorKey) return null;
  const account = privateKeyToAccount(env.curatorKey);
  const wallet = createWalletClient({ account, chain, transport: http(env.rpcUrl, { retryCount: 2, retryDelay: 800, timeout: 30_000 }) });
  state.curatorAddress = account.address;
  const poolId = computePoolId();
  const { record, send } = makeSender(db, client, account, wallet, CURATOR_EXPECTED);
  const spacing = deployment.tickSpacing;

  const read = <T,>(address: Hex, abi: unknown, functionName: string, args: unknown[] = []) =>
    withRetry(() => client.readContract({ address, abi, functionName, args } as never), `${functionName} ${address}`, 4) as Promise<T>;

  /**
   * After a settlement with a shortfall the vault owes its bond `deficit`, and deposits stay closed until it is
   * repaid. The curator repays it itself: mint the vault's token1 (testnet mocks only, by token identity),
   * approve, postBond(deficit). A cap keeps a runaway deficit from minting without bound.
   */
  async function repayDeficit(addr: string, v: Hex, nav: bigint): Promise<void> {
    const deficit = await read<bigint>(v, vaultAbi, "deficit");
    if (deficit === 0n) return;
    if (nav > 0n && deficit > nav) {
      await record("curator_post_bond", addr, null, false, `deficit ${deficit} exceeds NAV ${nav}; not auto-repaying`);
      return;
    }
    const token1 = (await read<Hex>(v, vaultAbi, "token1")) as Hex;
    if (lc(token1) !== lc(deployment.mUSDC) && lc(token1) !== lc(deployment.mWETH)) {
      await record("curator_post_bond", addr, null, false, `bond token ${token1} is not a mintable mock; top up by hand`);
      return;
    }
    const have = await read<bigint>(token1, erc20Abi, "balanceOf", [account.address]);
    if (have < deficit && !(await send("curator_mint_bond_token", addr, { address: token1, abi: erc20Abi, functionName: "mint", args: [account.address, deficit - have] }))) return;
    const allowance = await read<bigint>(token1, erc20Abi, "allowance", [account.address, v]);
    if (allowance < deficit && !(await send("curator_approve", addr, { address: token1, abi: erc20Abi, functionName: "approve", args: [v, MAX_UINT] }))) return;
    await send("curator_post_bond", addr, { address: v, abi: vaultAbi, functionName: "postBond", args: [deficit] }, `repaid deficit ${deficit}`);
  }

  /** Idle (undeployed) funds as a share of NAV, in bps, valued at spot. idle1 excludes the posted bond. */
  async function idleBps(v: Hex, nav: bigint, sqrtP: bigint): Promise<number> {
    if (nav === 0n) return 0;
    const [token0, token1, bond] = await Promise.all([read<Hex>(v, vaultAbi, "token0"), read<Hex>(v, vaultAbi, "token1"), read<bigint>(v, vaultAbi, "bond")]);
    const [b0, b1] = await Promise.all([read<bigint>(token0, erc20Abi, "balanceOf", [v]), read<bigint>(token1, erc20Abi, "balanceOf", [v])]);
    const idle1 = b1 > bond ? b1 - bond : 0n;
    const value0 = (((b0 * sqrtP) >> 96n) * sqrtP) >> 96n; // token0 -> token1 at spot
    return Number(((value0 + idle1) * 10_000n) / nav);
  }

  async function tick() {
    state.curatorBalanceWei = await withRetry(() => client.getBalance({ address: account.address }), "balance", 4).catch(() => state.curatorBalanceWei);
    const slot = await withRetry(() => readSlot0(client, poolId), "slot0", 4);
    const spot = slot.tick;
    const minT = minUsableTick(spacing);
    const maxT = maxUsableTick(spacing);
    const now = Number((await withRetry(() => client.getBlock(), "latest block", 4)).timestamp);
    for (const addr of curatorVaults()) {
      const v = addr as Hex;
      try {
        const [curator, fired, pos, epochStart, nav, rebalances] = (await withRetry(
          () => client.multicall({ contracts: ["curator", "fired", "position", "epochStart", "nav", "rebalancesThisEpoch"].map((functionName) => ({ address: v, abi: vaultAbi, functionName })), allowFailure: false }),
          `curator state ${addr}`,
          4,
        )) as [Hex, boolean, readonly [number, number, bigint], bigint, bigint, bigint];
        if (fired || lc(curator) !== lc(account.address)) continue;
        // Bond repayment moves no liquidity, so it is allowed inside the deposit window (it is what reopens deposits).
        await repayDeficit(addr, v, nav);
        if (pos[2] === 0n) continue; // no position yet (before the first deposit): a rebalance would only revert
        if (now <= Number(epochStart) + DEPOSIT_WINDOW) continue; // never move liquidity under a depositor's quote
        let plan = planRecenter(spot, pos[0], pos[1], spacing, minT, maxT);
        let why = `spot ${spot}: [${pos[0]},${pos[1]}] -> `;
        if (!plan && Number(rebalances) < MAX_ROUTINE_REBALANCES) {
          // In range and centred, but funds drifted idle (a settle realised fees, a bond top-up, a partial swap): redeploy.
          const idle = await idleBps(v, nav, slot.sqrtPriceX96);
          if (idle > IDLE_REDEPLOY_BPS) {
            plan = [pos[0], pos[1]];
            why = `idle ${idle} bps of NAV > ${IDLE_REDEPLOY_BPS}: redeploy [${pos[0]},${pos[1]}] -> `;
          }
        }
        if (!plan) continue;
        await send("curator_rebalance", addr, { address: v, abi: vaultAbi, functionName: "rebalance", args: [plan[0], plan[1], MAX_IDLE_BPS] }, `${why}[${plan[0]},${plan[1]}]`);
      } catch (e) {
        await record("curator_check", addr, null, false, errMsg(e));
      }
    }
    state.lastCuratorRunAt = Date.now();
  }

  return {
    address: account.address,
    tick,
    async run(signal: { stopped: boolean }) {
      log("curator", `starting; curator bot ${account.address}, every ${env.curatorMs / 1000}s`);
      await sleep(25_000);
      while (!signal.stopped) {
        try {
          await tick();
        } catch (e) {
          log("curator", `tick error (continuing): ${errMsg(e)}`);
        }
        await sleep(env.curatorMs);
      }
    },
  };
}
