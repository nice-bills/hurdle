import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, lc, readSlot0, computePoolId, type Client } from "./chain.js";
import { deployment, env, erc20Abi, vaultAbi } from "./config.js";
import type { Db } from "./db.js";
import { bus } from "./bus.js";
import { makeSender } from "./keeper.js";
import { state } from "./state.js";
import { maxUsableTick, minUsableTick } from "./tickmath.js";
import { errMsg, log, sleep, withRetry } from "./util.js";

const MAX_UINT = (1n << 256n) - 1n;
const IDLE_REDEPLOY_BPS = 200; // redeploy when idle funds exceed 2% of NAV (the same bound passed as maxIdleBps)
const MAX_ROUTINE_REBALANCES = 3; // idle redeploys keep the last per-epoch slot for an out-of-range re-centre
const FALLBACK_MAX_REBALANCES = 4; // HurdleVault.MAX_REBALANCES_PER_EPOCH, used only if the constant cannot be read
const RECENTRE_MAX_IDLE_BPS = 10_000; // step 1 of a re-centre accepts any idle amount; step 2 (idle redeploy) enforces 200
const SKIP_WARN_AFTER = 2; // consecutive identical skips before the warning shows (RebalanceIncomplete warns at once)

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
  const { record, send } = makeSender(
    db,
    client,
    account,
    wallet,
    CURATOR_EXPECTED,
    (action, vault, _tx, ok, note) => {
      // a success or a hard failure of an action replaces its skip streak
      if (vault) for (const k of [...streaks.keys()]) if (k.startsWith(`${lc(vault)}:${action}:`)) streaks.delete(k);
      if (!vault) return;
      if (ok) state.curatorWarnings.delete(`${lc(vault)}:${action}`);
      else if (action.startsWith("curator_")) state.curatorWarnings.set(`${lc(vault)}:${action}`, `${action} failed: ${note ?? "unknown"}`);
    },
    (action, vault, reason) => {
      if (!vault) return;
      const key = `${lc(vault)}:${action}:${reason}`;
      const n = (streaks.get(key) ?? 0) + 1;
      streaks.set(key, n);
      if (reason === "RebalanceIncomplete" || n >= SKIP_WARN_AFTER) state.curatorWarnings.set(`${lc(vault)}:${action}`, `${action} skipped ${n}x in a row (${reason})`);
    },
  );
  const streaks = new Map<string, number>();
  /** Vaults whose re-centre step 1 landed and still wait for the idle redeploy (step 2), tried on the fast ticks. */
  const pendingRedeploy = new Set<string>();
  let maxRebalances: number | null = null;
  const getMaxRebalances = async () => {
    if (maxRebalances === null) {
      try {
        maxRebalances = Number(await read<bigint>(lc(deployment.patientVault) as Hex, vaultAbi, "MAX_REBALANCES_PER_EPOCH"));
      } catch {
        return FALLBACK_MAX_REBALANCES;
      }
    }
    return maxRebalances;
  };
  const spacing = deployment.tickSpacing;

  const REPAY_COOLDOWN_MS = 120_000;
  const repaidAt = new Map<string, number>();
  const read = <T,>(address: Hex, abi: unknown, functionName: string, args: unknown[] = []) =>
    withRetry(() => client.readContract({ address, abi, functionName, args } as never), `${functionName} ${address}`, 4) as Promise<T>;

  /**
   * After a settlement with a shortfall the vault owes its bond `deficit`, and deposits stay closed until it is
   * repaid. The curator repays it itself: mint the vault's token1 (testnet mocks only, by token identity),
   * approve, postBond(deficit). A cap keeps a runaway deficit from minting without bound.
   */
  async function repayDeficit(addr: string, v: Hex, nav: bigint): Promise<void> {
    // A lagging RPC can still show the old deficit for a few seconds after a repay; queued passes then paid it 2-3x
    // (seen live on v6 Chaser). A new deficit only appears at the next settle (hourly), so a short cooldown is safe.
    if (Date.now() - (repaidAt.get(lc(addr)) ?? 0) < REPAY_COOLDOWN_MS) return;
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
    if (await send("curator_post_bond", addr, { address: v, abi: vaultAbi, functionName: "postBond", args: [deficit] }, `repaid deficit ${deficit}`)) repaidAt.set(lc(addr), Date.now());
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

  /** One pass over the managed vaults. `full` = the 10-min pass (may re-centre); otherwise the cheap 60 s pass (deficit repay + pending step 2). */
  async function tickOnce(full: boolean) {
    if (full) state.curatorBalanceWei = await withRetry(() => client.getBalance({ address: account.address }), "balance", 4).catch(() => state.curatorBalanceWei);
    const slot = await withRetry(() => readSlot0(client, poolId), "slot0", 4);
    const spot = slot.tick;
    const minT = minUsableTick(spacing);
    const maxT = maxUsableTick(spacing);
    const now = Number((await withRetry(() => client.getBlock(), "latest block", 4)).timestamp);
    const maxReb = await getMaxRebalances();
    for (const addr of curatorVaults()) {
      const v = addr as Hex;
      try {
        const [curator, fired, pos, epochStart, nav, rebalances] = (await withRetry(
          () => client.multicall({ contracts: ["curator", "fired", "position", "epochStart", "nav", "rebalancesThisEpoch"].map((functionName) => ({ address: v, abi: vaultAbi, functionName })), allowFailure: false }),
          `curator state ${addr}`,
          4,
        )) as [Hex, boolean, readonly [number, number, bigint], bigint, bigint, bigint];
        if (fired || lc(curator) !== lc(account.address)) {
          state.outOfRangeSince.delete(lc(addr));
          continue;
        }
        // Bond repayment moves no liquidity, so it is allowed inside the deposit window (it is what reopens deposits).
        await repayDeficit(addr, v, nav);
        if (pos[2] === 0n) continue; // no position yet (before the first deposit): a rebalance would only revert
        const fullRange = pos[0] <= minT && pos[1] >= maxT;
        if (!fullRange && (spot < pos[0] || spot > pos[1])) {
          if (!state.outOfRangeSince.has(lc(addr))) state.outOfRangeSince.set(lc(addr), Date.now());
        } else state.outOfRangeSince.delete(lc(addr));
        if (now <= Number(epochStart) + DEPOSIT_WINDOW) continue; // never move liquidity under a depositor's quote
        const used = Number(rebalances);
        const idleStep = async (limit: number, why: string) => {
          const idle = await idleBps(v, nav, slot.sqrtPriceX96);
          if (idle <= IDLE_REDEPLOY_BPS) {
            pendingRedeploy.delete(lc(addr));
            return;
          }
          if (used >= limit) {
            if (pendingRedeploy.has(lc(addr))) state.curatorWarnings.set(`${lc(addr)}:curator_rebalance`, `idle ${idle} bps after re-centre but ${used}/${maxReb} rebalances used this epoch; redeploy waits for the next epoch`);
            return;
          }
          const ok = await send("curator_rebalance", addr, { address: v, abi: vaultAbi, functionName: "rebalance", args: [pos[0], pos[1], MAX_IDLE_BPS] }, `${why}idle ${idle} bps of NAV > ${IDLE_REDEPLOY_BPS}: redeploy [${pos[0]},${pos[1]}]`);
          if (ok) pendingRedeploy.delete(lc(addr));
        };
        if (!full) {
          if (pendingRedeploy.has(lc(addr))) await idleStep(maxReb, "step 2 of re-centre: ");
          continue;
        }
        const plan = planRecenter(spot, pos[0], pos[1], spacing, minT, maxT);
        if (plan) {
          // Step 1 of a two-step re-centre: accept whatever idle the move leaves (maxIdleBps 10000). A far move cannot
          // convert enough in one swap-limited call to pass 200, and a strict first step reverts RebalanceIncomplete forever.
          if (used >= maxReb) {
            state.curatorWarnings.set(`${lc(addr)}:curator_rebalance`, `needs re-centre to [${plan[0]},${plan[1]}] (spot ${spot}) but ${used}/${maxReb} rebalances used this epoch`);
            continue;
          }
          const ok = await send("curator_rebalance", addr, { address: v, abi: vaultAbi, functionName: "rebalance", args: [plan[0], plan[1], RECENTRE_MAX_IDLE_BPS] }, `step 1 of re-centre, spot ${spot}: [${pos[0]},${pos[1]}] -> [${plan[0]},${plan[1]}]`);
          if (ok) pendingRedeploy.add(lc(addr)); // step 2 (idle redeploy at 200 bps) follows on the next tick(s)
          continue;
        }
        // In range and centred, but funds drifted idle (a re-centre's step 1, a settle that realised fees, a bond top-up): redeploy.
        await idleStep(pendingRedeploy.has(lc(addr)) ? maxReb : MAX_ROUTINE_REBALANCES, pendingRedeploy.has(lc(addr)) ? "step 2 of re-centre: " : "");
      } catch (e) {
        await record("curator_check", addr, null, false, errMsg(e));
      }
    }
    if (full) state.lastCuratorRunAt = Date.now();
  }

  /** Passes never overlap (one wallet, one nonce): the loop, the settle kick and manual calls queue here. */
  let chain_: Promise<unknown> = Promise.resolve();
  const tick = (full = true) => (chain_ = chain_.catch(() => undefined).then(() => tickOnce(full)));

  return {
    address: account.address,
    tick,
    async run(signal: { stopped: boolean }) {
      const fastMs = Math.min(env.curatorMs, env.curatorFastMs);
      log("curator", `starting; curator bot ${account.address}, re-centre every ${env.curatorMs / 1000}s, deficit check every ${fastMs / 1000}s and right after a keeper settle`);
      // The keeper settled a vault: a shortfall may be owed. Check now, and again after the RPC (load-balanced) has caught up.
      bus.on("settled", () => {
        for (const delay of [0, 6_000, 20_000]) setTimeout(() => void tick(false).catch((e) => log("curator", `post-settle check error: ${errMsg(e)}`)), delay).unref();
      });
      await sleep(25_000);
      let lastFull = 0;
      while (!signal.stopped) {
        const full = Date.now() - lastFull >= env.curatorMs - 1000;
        if (full) lastFull = Date.now();
        try {
          await tick(full);
        } catch (e) {
          log("curator", `tick error (continuing): ${errMsg(e)}`);
        }
        await sleep(fastMs);
      }
    },
  };
}
