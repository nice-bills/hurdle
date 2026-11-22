import { decodeEventLog, type Abi, type Hex, type Log } from "viem";
import { computePoolId, lc, readSlot0, type Client } from "./chain.js";
import { deployment, env, factoryAbi, vaultAbi } from "./config.js";
import { getCursor, type Db } from "./db.js";
import { state } from "./state.js";
import { errMsg, log, sleep, withRetry } from "./util.js";

export interface VaultRec {
  address: string;
  curator: string;
  pool_id: string;
  created_block: number;
  created_tx: string;
  carry_bps: number | null;
  min_bond_bps: number | null;
  max_tick_dev: number | null;
  epoch_seconds: number | null;
  label: string | null;
}
export interface EventRec {
  vault: string;
  block: number;
  tx: string;
  log_index: number;
  ts: Date;
  name: string;
  args: Record<string, unknown>;
}
export interface ScanResult {
  created: VaultRec[];
  events: EventRec[];
}

const LABELS: Record<string, string> = {
  [lc(deployment.patientVault)]: "Patient",
  [lc(deployment.chaserVault)]: "Chaser",
  [lc(deployment.recklessVault)]: "Reckless",
  ...(deployment.legacy
    ? { [lc(deployment.legacy.patientVault)]: "Patient (v3)", [lc(deployment.legacy.chaserVault)]: "Chaser (v3)" }
    : {}),
};

/** bigint -> decimal string, address -> lowercase, so jsonb args are stable and queryable. */
function jsonArgs(args: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!args || typeof args !== "object") return out;
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (typeof v === "bigint") out[k] = v.toString();
    else if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) out[k] = lc(v);
    else out[k] = v;
  }
  return out;
}

/** eth_getLogs for [from,to] on the given addresses. Rate limits are retried with backoff. */
async function getLogs(client: Client, address: string[], from: number, to: number) {
  return withRetry(
    () => client.getLogs({ address: address as Hex[], fromBlock: BigInt(from), toBlock: BigInt(to) }),
    `getLogs ${from}-${to}`,
  );
}

async function readVaultMeta(client: Client, address: Hex, block: bigint) {
  const calls = ["carryBps", "minBondBps", "maxTickDeviation", "epochSeconds"].map((functionName) => ({
    address,
    abi: vaultAbi as Abi,
    functionName,
  }));
  try {
    const r = await withRetry(() => client.multicall({ contracts: calls, blockNumber: block, allowFailure: true }), "vault meta");
    const g = (i: number) => (r[i].status === "success" ? Number(r[i].result as bigint | number) : null);
    return { carry_bps: g(0), min_bond_bps: g(1), max_tick_dev: g(2), epoch_seconds: g(3) };
  } catch (e) {
    log("indexer", `vault meta read failed for ${address}: ${errMsg(e)}`);
    return { carry_bps: null, min_bond_bps: null, max_tick_dev: null, epoch_seconds: null };
  }
}

/** Pure chain -> records scan for [from,to]. `known` is the set of vault addresses (lowercase) already indexed. */
export async function scanRange(client: Client, known: Set<string>, from: number, to: number): Promise<ScanResult> {
  const created: VaultRec[] = [];
  const events: EventRec[] = [];
  const blockTs = new Map<number, Date>();
  const tsOf = async (n: bigint) => {
    const k = Number(n);
    let t = blockTs.get(k);
    if (!t) {
      const b = await withRetry(() => client.getBlock({ blockNumber: n }), `getBlock ${k}`);
      t = new Date(Number(b.timestamp) * 1000);
      blockTs.set(k, t);
    }
    return t;
  };

  // 1. factory: new vaults
  const factoryLogs = await getLogs(client, [deployment.factory], from, to);
  for (const l of factoryLogs) {
    let dec;
    try {
      dec = decodeEventLog({ abi: factoryAbi, data: l.data, topics: l.topics });
    } catch {
      continue;
    }
    if (dec.eventName !== "VaultCreated") continue;
    const a = dec.args as unknown as { vault: Hex; curator: Hex; poolId: Hex };
    const addr = lc(a.vault);
    const meta = await readVaultMeta(client, a.vault, l.blockNumber!);
    created.push({
      address: addr,
      curator: lc(a.curator),
      pool_id: lc(a.poolId),
      created_block: Number(l.blockNumber),
      created_tx: l.transactionHash!,
      label: LABELS[addr] ?? null,
      ...meta,
    });
    events.push({
      vault: addr,
      block: Number(l.blockNumber),
      tx: l.transactionHash!,
      log_index: l.logIndex!,
      ts: await tsOf(l.blockNumber!),
      name: "VaultCreated",
      args: jsonArgs(dec.args),
    });
  }

  // 2. vault events, for vaults known before this chunk plus those just created in it
  const vaultSet = new Set(known);
  for (const c of created) vaultSet.add(c.address);
  if (vaultSet.size) {
    const logs: Log[] = await getLogs(client, [...vaultSet], from, to);
    for (const l of logs) {
      let dec;
      try {
        dec = decodeEventLog({ abi: vaultAbi, data: l.data, topics: l.topics });
      } catch {
        continue; // not one of ours (e.g. an ERC20 event on the vault address)
      }
      events.push({
        vault: lc(l.address),
        block: Number(l.blockNumber),
        tx: l.transactionHash!,
        log_index: l.logIndex!,
        ts: await tsOf(l.blockNumber!),
        name: String(dec.eventName),
        args: jsonArgs(dec.args),
      });
    }
  }
  return { created, events };
}

/** Cursor per factory: a redeploy (new factory) indexes from its own start block; old rows stay. */
const CURSOR = `events:${deployment.factory.toLowerCase()}`;

export async function persist(db: Db, res: ScanResult, cursorTo: number) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    for (const v of res.created) {
      await c.query(
        `INSERT INTO vaults (address,curator,pool_id,created_block,created_tx,carry_bps,min_bond_bps,max_tick_dev,epoch_seconds,label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (address) DO UPDATE SET
           carry_bps=COALESCE(vaults.carry_bps,EXCLUDED.carry_bps), min_bond_bps=COALESCE(vaults.min_bond_bps,EXCLUDED.min_bond_bps),
           max_tick_dev=COALESCE(vaults.max_tick_dev,EXCLUDED.max_tick_dev), epoch_seconds=COALESCE(vaults.epoch_seconds,EXCLUDED.epoch_seconds),
           label=COALESCE(vaults.label,EXCLUDED.label)`,
        [v.address, v.curator, v.pool_id, v.created_block, v.created_tx, v.carry_bps, v.min_bond_bps, v.max_tick_dev, v.epoch_seconds, v.label],
      );
    }
    for (const e of res.events) {
      await c.query(
        `INSERT INTO events (vault,block,tx,log_index,ts,name,args) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT (tx,log_index) DO NOTHING`,
        [e.vault, e.block, e.tx, e.log_index, e.ts, e.name, JSON.stringify(e.args)],
      );
    }
    await c.query(
      `INSERT INTO cursor (name,block) VALUES ($2,$1) ON CONFLICT (name) DO UPDATE SET block=GREATEST(cursor.block,EXCLUDED.block)`,
      [cursorTo, CURSOR],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const SNAP_FUNCS = ["nav", "bond", "bondValue", "deficit", "fired", "totalSupply", "position"] as const;

export interface SnapshotRec {
  vault: string;
  block: number;
  ts: Date;
  nav: string | null;
  bond: string | null;
  bond_value: string | null;
  deficit: string | null;
  fired: boolean | null;
  total_supply: string | null;
  lo: number | null;
  hi: number | null;
  tick: number | null;
}

/** State of every vault (and the pool) at `block`. Individual call failures (e.g. TWAP history) become nulls. */
export async function takeSnapshots(client: Client, vaults: { address: string; pool_id: string }[], block: bigint) {
  const b = await withRetry(() => client.getBlock({ blockNumber: block }), "snapshot block");
  const ts = new Date(Number(b.timestamp) * 1000);
  const slotCache = new Map<string, { tick: number; sqrtPriceX96: bigint } | null>();
  const slot = async (poolId: string) => {
    if (!slotCache.has(poolId)) {
      try {
        slotCache.set(poolId, await withRetry(() => readSlot0(client, poolId as Hex, block), "slot0"));
      } catch (e) {
        log("indexer", `slot0 read failed: ${errMsg(e)}`);
        slotCache.set(poolId, null);
      }
    }
    return slotCache.get(poolId)!;
  };
  const snaps: SnapshotRec[] = [];
  for (const v of vaults) {
    const r = await withRetry(
      () =>
        client.multicall({
          contracts: SNAP_FUNCS.map((functionName) => ({ address: v.address as Hex, abi: vaultAbi as Abi, functionName })),
          blockNumber: block,
          allowFailure: true,
        }),
      `snapshot ${v.address}`,
    );
    const big = (i: number) => (r[i].status === "success" ? String(r[i].result as bigint) : null);
    const pos = r[6].status === "success" ? (r[6].result as readonly [number, number, bigint]) : null;
    const s0 = await slot(v.pool_id);
    snaps.push({
      vault: v.address,
      block: Number(block),
      ts,
      nav: big(0),
      bond: big(1),
      bond_value: big(2),
      deficit: big(3),
      fired: r[4].status === "success" ? (r[4].result as boolean) : null,
      total_supply: big(5),
      lo: pos ? Number(pos[0]) : null,
      hi: pos ? Number(pos[1]) : null,
      tick: s0 ? s0.tick : null,
    });
  }
  const poolId = lc(computePoolId());
  const s0 = await slot(poolId);
  return { snaps, poolTick: s0 ? { block: Number(block), ts, tick: s0.tick, sqrt_price: s0.sqrtPriceX96.toString() } : null };
}

export async function persistSnapshots(db: Db, res: Awaited<ReturnType<typeof takeSnapshots>>) {
  for (const s of res.snaps) {
    await db.query(
      `INSERT INTO snapshots (vault,block,ts,nav,bond,bond_value,deficit,fired,total_supply,lo,hi,tick)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (vault,block) DO NOTHING`,
      [s.vault, s.block, s.ts, s.nav, s.bond, s.bond_value, s.deficit, s.fired, s.total_supply, s.lo, s.hi, s.tick],
    );
  }
  if (res.poolTick) {
    const p = res.poolTick;
    await db.query(`INSERT INTO pool_ticks (block,ts,tick,sqrt_price) VALUES ($1,$2,$3,$4) ON CONFLICT (block) DO NOTHING`, [p.block, p.ts, p.tick, p.sqrt_price]);
  }
}

/** The long-running indexer loop. Never throws: errors are logged and the loop continues. */
export async function runIndexer(db: Db, client: Client, signal: { stopped: boolean }) {
  const known = new Set<string>((await db.query("SELECT address FROM vaults")).rows.map((r) => r.address as string));
  state.vaults = known.size;
  let lastSnapshot = 0;
  log("indexer", `starting; ${known.size} known vaults, rpc ${env.rpcUrl}`);

  while (!signal.stopped) {
    try {
      const head = Number(await withRetry(() => client.getBlockNumber(), "blockNumber"));
      const safe = head - env.confirmations;
      state.head = head;
      const cur = await getCursor(db, CURSOR);
      let from = Math.max((cur ?? deployment.factoryStartBlock - 1) + 1, deployment.factoryStartBlock);
      while (from <= safe && !signal.stopped) {
        const to = Math.min(from + env.chunk - 1, safe);
        const res = await scanRange(client, known, from, to);
        await persist(db, res, to);
        for (const v of res.created) known.add(v.address);
        state.vaults = known.size;
        state.indexedBlock = to;
        if (res.created.length || res.events.length) {
          log("indexer", `blocks ${from}-${to}: ${res.created.length} vaults, ${res.events.length} events`);
        }
        from = to + 1;
        if (from <= safe) await sleep(150); // be gentle with the public RPC while catching up
      }
      if (cur !== null) state.indexedBlock = Math.max(state.indexedBlock, cur, Math.min(from - 1, safe));
      state.lastIndexerOkAt = Date.now();
      state.lastIndexerError = "";

      if (Date.now() - lastSnapshot >= env.snapshotMs && known.size) {
        const vs = (await db.query("SELECT address, pool_id FROM vaults WHERE created_block >= $1", [deployment.factoryStartBlock])).rows as { address: string; pool_id: string }[];
        const snap = await takeSnapshots(client, vs, BigInt(safe));
        await persistSnapshots(db, snap);
        lastSnapshot = Date.now();
        state.lastSnapshotAt = lastSnapshot;
        log("indexer", `snapshot @${safe}: ${snap.snaps.length} vaults, pool tick ${snap.poolTick?.tick ?? "n/a"}`);
      }
    } catch (e) {
      state.lastIndexerError = errMsg(e);
      log("indexer", `loop error (continuing): ${errMsg(e)}`);
      await sleep(Math.min(env.pollMs * 2, 30_000));
    }
    await sleep(env.pollMs);
  }
}

