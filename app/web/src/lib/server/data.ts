import type { Address } from "viem";
import { ADDR, D, KNOWN_LABELS, LEGACY, LEGACY_POOL, LEGACY_VAULTS, V4_POOL, maxUsableTick, minUsableTick, poolRefFor, type PoolRef } from "@/lib/chain";
import { bondToUsd, tickFromUsd, usdPerEthFromSqrt, usdPerEthFromTick } from "@/lib/math";
import { buildSeries } from "@/lib/series";
import type { DataSource, KeeperRun, Overview, PoolState, VaultDetail, VaultEvent, VaultSummary } from "@/lib/types";
import { dbCursorBlock, dbEvents, dbKeeper, dbPoolTicks, dbSnapshots, dbVaults } from "./db";
import { head, logsRange, logsRpc, poolSqrtAtBlock, readPoolRpc, readVaultsRpc } from "./rpc";

type Registry = {
  source: DataSource;
  vaults: { address: string; curator: string; poolId: string; createdBlock: number; label: string | null }[];
  events: VaultEvent[];
};

const memo = new Map<string, { at: number; p: Promise<unknown> }>();
function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.p as Promise<T>;
  const p = fn();
  memo.set(key, { at: Date.now(), p });
  p.catch(() => memo.delete(key));
  return p;
}

/** Vault list + all vault events: Postgres when the worker has indexed, topped up from RPC if it lags; else RPC scan. */
async function registry(headBlock: number): Promise<Registry> {
  const rows = await dbVaults();
  if (rows && rows.length) {
    const events = (await dbEvents()) ?? [];
    const cursor = (await dbCursorBlock()) ?? Math.max(0, ...events.map((e) => e.block));
    if (cursor < headBlock - 2) {
      const from = Math.max(cursor + 1, headBlock - 20_000);
      try {
        const extra = await logsRange([ADDR.factory, ...rows.map((r) => r.address)], from, headBlock);
        const seen = new Set(events.map((e) => e.tx + ":" + e.logIndex));
        for (const e of extra) if (!seen.has(e.tx + ":" + e.logIndex)) events.push(e);
        for (const e of extra)
          if (e.name === "VaultCreated" && !rows.some((r) => r.address.toLowerCase() === String(e.args.vault)))
            rows.push({ address: String(e.args.vault), curator: String(e.args.curator), pool_id: String(e.args.poolId), created_block: String(e.block), created_tx: e.tx, carry_bps: null, min_bond_bps: null, max_tick_dev: null, epoch_seconds: null, label: null });
      } catch {
        /* DB data alone is still fine */
      }
    }
    return {
      source: "db",
      vaults: rows.map((r) => ({ address: r.address.toLowerCase(), curator: r.curator.toLowerCase(), poolId: r.pool_id, createdBlock: Number(r.created_block), label: r.label })),
      events,
    };
  }
  const { vaults, events } = await logsRpc();
  return {
    source: "rpc",
    vaults: [...vaults.entries()].map(([address, v]) => ({ address, curator: v.curator, poolId: v.poolId, createdBlock: v.block, label: null })),
    events: [...events],
  };
}

async function poolState(sinceSec: number, events: VaultEvent[], ref: PoolRef = V4_POOL): Promise<PoolState> {
  const p = await readPoolRpc(ref);
  // pool_ticks is keyed by pool id: only this pool's own ticks (the legacy pool has none once its rows age out)
  let history = (await dbPoolTicks(sinceSec, ref.poolId)) ?? [];
  if (!history.length) {
    // no DB: settlement prices are the only free history
    const seen = new Set<number>();
    history = events
      .filter((e) => e.name === "Settled" && e.ts >= sinceSec)
      .sort((a, b) => a.ts - b.ts)
      .filter((e) => (seen.has(e.ts) ? false : (seen.add(e.ts), true)))
      .map((e) => ({ ts: e.ts, tick: Math.round(tickFromUsd(usdPerEthFromSqrt(String(e.args.sqrtPriceX96), ref.wethIs0), ref.wethIs0)) }));
  }
  return {
    tick: p.tick,
    sqrtPriceX96: p.sqrtPriceX96.toString(),
    price: usdPerEthFromSqrt(p.sqrtPriceX96, ref.wethIs0),
    wethIs0: ref.wethIs0,
    twapTick: p.twapTick,
    twap10Tick: p.twap10Tick,
    referenceTick: p.referenceTick,
    twapPrice: p.twapTick != null ? usdPerEthFromTick(p.twapTick, ref.wethIs0) : null,
    liquidity: p.liquidity.toString(),
    history,
  };
}

/** Pool price when the vault's first deposit landed: the start of its first settlement segment, for the USD basis. */
async function firstDepositSqrt(events: VaultEvent[], ref: PoolRef): Promise<bigint | null> {
  const ev = [...events].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const dep = ev.find((e) => e.name === "Deposited");
  const settled = ev.find((e) => e.name === "Settled");
  if (!dep || (settled && settled.block < dep.block)) return null;
  return poolSqrtAtBlock(dep.block, ref);
}

function summarize(
  reg: Registry["vaults"][number],
  data: Record<string, unknown>,
  events: VaultEvent[],
  startSqrt: bigint | null,
): VaultSummary {
  const s = (k: string) => (data[k] == null ? null : String(data[k]));
  const n = (k: string, d = 0) => (data[k] == null ? d : Number(data[k]));
  const pos = (data.position as readonly [number, number, bigint] | null) ?? [0, 0, 0n];
  const start = (data.start as readonly [bigint, bigint, bigint, bigint, bigint] | null) ?? [0n, 0n, 0n, 0n, 0n];
  const fired = Boolean(data.fired);
  const nav = s("nav");
  const bondValue = s("bondValue") ?? s("bond");
  const minBondBps = n("minBondBps", 200);
  const bondBps = nav && bondValue && BigInt(nav) > 0n ? Number((BigInt(bondValue) * 1_000_000n) / BigInt(nav)) / 100 : null;
  const frozen = !fired && bondBps != null && bondBps < minBondBps;
  const { series, totals } = buildSeries(events, startSqrt, poolRefFor(reg.address).wethIs0);
  const lastSettled = [...events].reverse().find((e) => e.name === "Settled") ?? null;
  const last = series.length > 1 ? series[series.length - 1] : null;
  const known = KNOWN_LABELS[reg.address.toLowerCase()];
  return {
    address: reg.address,
    label: known?.name ?? reg.label ?? null,
    note: known?.note ?? null,
    curator: (s("curator") ?? reg.curator).toLowerCase(),
    poolId: s("poolId") ?? reg.poolId,
    createdBlock: reg.createdBlock,
    carryBps: n("carryBps"),
    minBondBps,
    maxTickDeviation: n("maxTickDeviation"),
    epochSeconds: n("epochSeconds"),
    epochStart: n("epochStart"),
    firedAt: n("firedAt"),
    fired,
    nav,
    bond: s("bond") ?? "0",
    bondValue,
    bondShares: s("bondShares") ?? "0",
    curatorShares: s("curatorShares") ?? "0",
    deficit: s("deficit") ?? "0",
    totalSupply: s("totalSupply") ?? "0",
    lo: Number(pos[0]),
    hi: Number(pos[1]),
    liquidity: String(pos[2]),
    rebalancesThisEpoch: n("rebalancesThisEpoch"),
    startTs: Number(start[0]),
    startNav: String(start[4]),
    status: fired ? "FIRED" : frozen ? "FROZEN" : "ACTIVE",
    bondBps,
    lastSettle: lastSettled
      ? { ...lastSettled, vsPar: Number(lastSettled.args.nav) / Math.max(1, Number(lastSettled.args.bench)) - 1 }
      : null,
    cumulative: last ? { strategy: last.strategy, par: last.par, depositor: last.depositor, strategyUsd: last.strategyUsd, parUsd: last.parUsd, depositorUsd: last.depositorUsd } : null,
    totals,
    parked: fired && Number(pos[0]) === minUsableTick() && Number(pos[1]) === maxUsableTick() && data.parkedOnChain !== false,
    isVault: Boolean(data.isVault),
  };
}

function ordered(vaults: VaultSummary[]) {
  const order = [ADDR.patient, ADDR.chaser, ADDR.reckless, ...LEGACY_VAULTS].map((a) => a.toLowerCase());
  const rank = (v: VaultSummary) => { const i = order.indexOf(v.address); return i < 0 ? order.length : i; };
  return vaults.sort((a, b) => rank(a) - rank(b) || (b.createdBlock ?? 0) - (a.createdBlock ?? 0));
}

export function getOverview(): Promise<Overview> {
  return cached("overview", 8000, async () => {
    const h = await head();
    const reg = await registry(h.n);
    for (const a of LEGACY_VAULTS)
      if (!reg.vaults.some((v) => v.address === a))
        reg.vaults.push({ address: a, curator: "", poolId: "", createdBlock: LEGACY.factoryStartBlock, label: null });
    const [live, pool, legacyPool, keeper] = await Promise.all([
      readVaultsRpc(reg.vaults.map((v) => v.address as Address)),
      poolState(h.ts - 6 * 3600, reg.events),
      poolState(h.ts - 6 * 3600, reg.events.filter((e) => LEGACY_VAULTS.includes(String(e.args.vault ?? "").toLowerCase())), LEGACY_POOL),
      dbKeeper(undefined, 10),
    ]);
    const byVault = groupEvents(reg.events);
    const starts = await Promise.all(reg.vaults.map((r) => firstDepositSqrt(byVault.get(r.address) ?? [], poolRefFor(r.address))));
    const all = ordered(live.map((l, i) => summarize(reg.vaults[i], l.data as Record<string, unknown>, byVault.get(reg.vaults[i].address) ?? [], starts[i])));
    // current deployment = created at/after the v4 factory start block; v3 vaults are listed separately
    const vaults = all.filter((v) => !LEGACY_VAULTS.includes(v.address) && (v.createdBlock ?? D.factoryStartBlock) >= D.factoryStartBlock);
    const legacyVaults = all.filter((v) => LEGACY_VAULTS.includes(v.address));
    const mark = pool.twapPrice ?? pool.price; // the contract marks NAV at the hook TWAP
    const tvlUsd = vaults.reduce((a, v) => a + (v.nav ? bondToUsd(v.nav, mark) : 0), 0);
    const tvlEth = tvlUsd / mark;
    return {
      source: reg.source,
      head: h.n,
      headTs: h.ts,
      pool,
      legacyPool,
      vaults,
      legacyVaults,
      stats: {
        vaults: vaults.length,
        tvlEth,
        tvlUsd,
        shortfallPaidUsd: vaults.reduce((a, v) => a + v.totals.shortfallPaidUsd, 0),
        carryUsd: vaults.reduce((a, v) => a + v.totals.carryUsd, 0),
        settlements: vaults.reduce((a, v) => a + v.totals.settlements, 0),
        depositorsBelowPar: vaults.filter((v) => v.cumulative && v.cumulative.depositorUsd < v.cumulative.parUsd - 1e-6).length,
      },
      keeper: keeper ?? [],
      updatedAt: Math.floor(Date.now() / 1000),
    };
  });
}

function groupEvents(events: VaultEvent[]) {
  const m = new Map<string, VaultEvent[]>();
  for (const e of events) {
    const v = String(e.args.vault ?? "").toLowerCase();
    if (!m.has(v)) m.set(v, []);
    m.get(v)!.push(e);
  }
  for (const list of m.values()) list.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return m;
}

export function getVaultDetail(address: string): Promise<VaultDetail | null> {
  const a = address.toLowerCase();
  return cached("vault:" + a, 6000, async () => {
    const h = await head();
    const reg = await registry(h.n);
    let entry = reg.vaults.find((v) => v.address === a);
    if (!entry) {
      // not indexed yet (just created): read it directly if the factory knows it
      const [probe] = await readVaultsRpc([a as Address]);
      if (!probe.data.isVault && !LEGACY_VAULTS.includes(a)) return null;
      entry = { address: a, curator: String(probe.data.curator ?? "").toLowerCase(), poolId: String(probe.data.poolId ?? ""), createdBlock: h.n, label: null };
    }
    const events = groupEvents(reg.events).get(a) ?? [];
    const ref = poolRefFor(a);
    const [[live], pool, snaps, keeper] = await Promise.all([
      readVaultsRpc([a as Address]),
      poolState(h.ts - 6 * 3600, reg.events, ref),
      dbSnapshots(a, ref.wethIs0 ? 6 : 18),
      dbKeeper(a, 8),
    ]);
    const startSqrt = await firstDepositSqrt(events, ref);
    const vault = summarize(entry, live.data as Record<string, unknown>, events, startSqrt);
    const { series } = buildSeries(events, startSqrt, ref.wethIs0);
    return {
      source: reg.source,
      head: h.n,
      headTs: h.ts,
      pool,
      vault,
      events: [...events].reverse().slice(0, 200),
      series,
      snapshots: snaps ?? [],
      keeper: (keeper ?? []) as KeeperRun[],
      updatedAt: Math.floor(Date.now() / 1000),
    };
  });
}

export function getPool(): Promise<PoolState & { head: number; headTs: number; source: DataSource }> {
  return cached("pool", 4000, async () => {
    const h = await head();
    const hasDb = Boolean(process.env.DATABASE_URL);
    const events = hasDb ? [] : (await logsRpc()).events;
    const p = await poolState(h.ts - 6 * 3600, events);
    return { ...p, head: h.n, headTs: h.ts, source: p.history.length && hasDb ? "db" : "rpc" };
  });
}

export const deploymentInfo = D;
