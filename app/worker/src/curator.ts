import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, lc, readSlot0, computePoolId, type Client } from "./chain.js";
import { deployment, env, vaultAbi } from "./config.js";
import type { Db } from "./db.js";
import { makeSender } from "./keeper.js";
import { state } from "./state.js";
import { maxUsableTick, minUsableTick } from "./tickmath.js";
import { errMsg, log, sleep, withRetry } from "./util.js";

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

  async function tick() {
    const spot = (await withRetry(() => readSlot0(client, poolId), "slot0", 4)).tick;
    const minT = minUsableTick(spacing);
    const maxT = maxUsableTick(spacing);
    const now = Number((await withRetry(() => client.getBlock(), "latest block", 4)).timestamp);
    for (const addr of curatorVaults()) {
      const v = addr as Hex;
      try {
        const [curator, fired, pos, epochStart] = (await withRetry(
          () => client.multicall({ contracts: ["curator", "fired", "position", "epochStart"].map((functionName) => ({ address: v, abi: vaultAbi, functionName })), allowFailure: false }),
          `curator state ${addr}`,
          4,
        )) as [Hex, boolean, readonly [number, number, bigint], bigint];
        if (fired || lc(curator) !== lc(account.address)) continue;
        if (pos[2] === 0n) continue; // no position yet (before the first deposit): a rebalance would only revert
        if (now <= Number(epochStart) + DEPOSIT_WINDOW) continue; // never move liquidity under a depositor's quote
        const plan = planRecenter(spot, pos[0], pos[1], spacing, minT, maxT);
        if (!plan) continue;
        await send("curator_rebalance", addr, { address: v, abi: vaultAbi, functionName: "rebalance", args: [plan[0], plan[1], MAX_IDLE_BPS] }, `spot ${spot}: [${pos[0]},${pos[1]}] -> [${plan[0]},${plan[1]}]`);
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
