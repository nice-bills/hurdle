import { BaseError, ContractFunctionRevertedError, createPublicClient, decodeEventLog, http, parseAbi, type Address, type Hex } from "viem";
import { factoryAbi, hookAbi, vaultAbi } from "@/shared/abis";
import { ADDR, D, LEGACY, LEGACY_VAULTS, V4_POOL, maxUsableTick, minUsableTick, poolStateSlot, unichainSepolia, type PoolRef } from "@/lib/chain";
import type { VaultEvent } from "@/lib/types";

const RPC = process.env.RPC_URL || D.rpc;

export const client = createPublicClient({
  chain: unichainSepolia,
  transport: http(RPC, { retryCount: 3, retryDelay: 600, timeout: 15_000, batch: { batchSize: 20, wait: 8 } }),
  batch: { multicall: { wait: 8 } },
});

const managerAbi = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);

export async function readPoolRpc(ref: PoolRef = V4_POOL) {
  const slot = poolStateSlot(ref.poolId);
  const res = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: ADDR.poolManager, abi: managerAbi, functionName: "extsload", args: [slot] },
      { address: ADDR.poolManager, abi: managerAbi, functionName: "extsload", args: [incSlot(slot, 3n)] },
      { address: ref.hook, abi: hookAbi, functionName: "twapTick", args: [ref.poolId] },
      { address: ref.hook, abi: hookAbi, functionName: "consult", args: [ref.poolId, 600] },
      { address: ref.hook, abi: hookAbi, functionName: "referenceTick", args: [ref.poolId] },
    ],
  });
  const raw = res[0].status === "success" ? BigInt(res[0].result as Hex) : 0n;
  const sqrtPriceX96 = raw & ((1n << 160n) - 1n);
  let tick = Number((raw >> 160n) & 0xffffffn);
  if (tick >= 0x800000) tick -= 0x1000000;
  const liq = res[1].status === "success" ? BigInt(res[1].result as Hex) & ((1n << 128n) - 1n) : 0n;
  const num = (r: (typeof res)[number]) => (r.status === "success" ? Number(r.result as number) : null);
  return { sqrtPriceX96, tick, liquidity: liq, twapTick: num(res[2]), twap10Tick: num(res[3]), referenceTick: num(res[4]) };
}

const sqrtAtBlock = new Map<string, Promise<bigint | null>>();
/** Pool sqrtPriceX96 at a past block (history is kept by the RPC); null when unavailable. Memoised: history never changes. */
export function poolSqrtAtBlock(block: number, ref: PoolRef = V4_POOL): Promise<bigint | null> {
  const key = ref.poolId + ":" + block;
  let p = sqrtAtBlock.get(key);
  if (!p) {
    p = client
      .readContract({ address: ADDR.poolManager, abi: managerAbi, functionName: "extsload", args: [poolStateSlot(ref.poolId)], blockNumber: BigInt(block) })
      .then((raw) => {
        const v = BigInt(raw) & ((1n << 160n) - 1n);
        return v > 0n ? v : null;
      })
      .catch(() => {
        sqrtAtBlock.delete(key); // retry next time
        return null;
      });
    sqrtAtBlock.set(key, p);
  }
  return p;
}

function incSlot(slot: Hex, n: bigint): Hex {
  return ("0x" + (BigInt(slot) + n).toString(16).padStart(64, "0")) as Hex;
}

const VIEW_FIELDS = [
  "nav", "bond", "bondValue", "bondShares", "deficit", "fired", "firedAt", "curator", "epochStart", "epochSeconds",
  "carryBps", "minBondBps", "maxTickDeviation", "rebalancesThisEpoch", "totalSupply", "position", "start", "poolId",
] as const;
type Field = (typeof VIEW_FIELDS)[number];

export async function readVaultsRpc(addrs: Address[]) {
  const contracts = addrs.flatMap((address) => [
    ...VIEW_FIELDS.map((functionName) => ({ address, abi: vaultAbi, functionName }) as const),
    { address: LEGACY_VAULTS.includes(address.toLowerCase()) ? (LEGACY.factory as Address) : ADDR.factory, abi: factoryAbi, functionName: "isVault", args: [address] } as const,
  ]);
  const res = await client.multicall({ allowFailure: true, contracts: contracts as never });
  const per = VIEW_FIELDS.length + 1;
  const rows = addrs.map((address, i) => {
    const out: Partial<Record<Field | "isVault", unknown>> = {};
    VIEW_FIELDS.forEach((f, j) => {
      const r = res[i * per + j] as { status: string; result?: unknown };
      out[f] = r.status === "success" ? r.result : null;
    });
    const iv = res[i * per + VIEW_FIELDS.length] as { status: string; result?: unknown };
    out.isVault = iv.status === "success" ? iv.result : false;
    return { address, data: out };
  });
  // The contract's deficit gate excludes bond shares and the curator's free shares, so read the latter.
  const cb = await client.multicall({
    allowFailure: true,
    contracts: rows.map((r) => ({ address: r.address, abi: vaultAbi, functionName: "balanceOf", args: [String((r.data as Record<string, unknown>).curator ?? "0x0000000000000000000000000000000000000000") as Address] }) as const) as never,
  });
  rows.forEach((r, i) => {
    const x = cb[i] as { status: string; result?: unknown };
    (r.data as Record<string, unknown>).curatorShares = x.status === "success" ? x.result : null;
  });
  // Mirror the contract's park test (full-range ticks AND idle <= 2% of NAV): simulate the permissionless
  // rebalance and treat an AlreadyParked revert as parked. Only fired vaults at full range need the probe.
  await Promise.all(
    rows.map(async (r) => {
      const d = r.data as Record<string, unknown>;
      const pos = d.position as readonly [number, number, bigint] | null;
      if (!d.fired || !pos || Number(pos[0]) !== minUsableTick() || Number(pos[1]) !== maxUsableTick()) return;
      d.parkedOnChain = await probeParked(r.address);
    }),
  );
  return rows;
}

async function probeParked(address: Address): Promise<boolean | null> {
  try {
    await client.simulateContract({ address, abi: vaultAbi, functionName: "rebalance", args: [0, 0], account: ADDR.factory });
    return false; // the call would succeed: parking is not finished (idle too high)
  } catch (e) {
    if (e instanceof BaseError) {
      const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
      if (rev?.data?.errorName === "AlreadyParked") return true;
      if (rev) return false;
    }
    return null; // RPC trouble: fall back to the tick check
  }
}

// ---------------------------------------------------------------- logs (fallback indexer, in memory)

const CHUNK = 1000;
const ALL_ABI = [...vaultAbi, ...factoryAbi];
type Cache = { scannedTo: number; vaults: Map<string, { curator: string; poolId: string; block: number; tx: string }>; events: VaultEvent[]; busy: Promise<void> | null; ts: Map<number, number> };
const g = globalThis as unknown as { __hurdleLogs?: Cache };
const cache: Cache = (g.__hurdleLogs ??= { scannedTo: D.factoryStartBlock - 1, vaults: new Map(), events: [], busy: null, ts: new Map() });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type RawLog = { address: string; topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex; logIndex: Hex; blockTimestamp?: Hex };

async function getLogsRaw(address: string[], from: number, to: number): Promise<RawLog[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await client.request({
        method: "eth_getLogs",
        params: [{ address: address as Address[], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
      })) as unknown as RawLog[];
    } catch (e) {
      if (attempt >= 5) throw e;
      await sleep(500 * 2 ** attempt); // -32016 / 429 back off
    }
  }
}

function toEvent(l: RawLog, name: string, args: Record<string, string | number | boolean>, ts: number): VaultEvent {
  return { name, block: parseInt(l.blockNumber, 16), tx: l.transactionHash, logIndex: parseInt(l.logIndex, 16), ts, args };
}

async function ingest(logs: RawLog[], newVaults: string[]) {
  for (const l of logs) {
    let dec;
    try {
      dec = decodeEventLog({ abi: ALL_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    const block = parseInt(l.blockNumber, 16);
    const ts = l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : await blockTs(block);
    const args = jsonArgs(dec.args);
    if (dec.eventName === "VaultCreated") {
      if (l.address.toLowerCase() !== ADDR.factory.toLowerCase()) continue;
      const v = String(args.vault).toLowerCase();
      if (cache.vaults.has(v)) continue;
      cache.vaults.set(v, { curator: String(args.curator).toLowerCase(), poolId: String(args.poolId), block, tx: l.transactionHash });
      newVaults.push(v);
      cache.events.push(toEvent(l, dec.eventName, { ...args, vault: v }, ts));
    } else {
      cache.events.push(toEvent(l, dec.eventName, { ...args, vault: l.address.toLowerCase() }, ts));
    }
  }
}

async function scan(head: number) {
  while (cache.scannedTo < head) {
    const watch = [ADDR.factory.toLowerCase(), ...cache.vaults.keys()];
    const ranges: [number, number][] = [];
    for (let a = cache.scannedTo + 1; a <= head && ranges.length < 6; a += CHUNK) ranges.push([a, Math.min(a + CHUNK - 1, head)]);
    const results = await Promise.all(ranges.map(([a, b]) => getLogsRaw(watch, a, b)));
    const fresh: string[] = [];
    for (const logs of results) await ingest(logs, fresh);
    if (fresh.length) {
      // vaults created in this batch were not in the watch list: fetch their logs for the batch
      const from = Math.min(...fresh.map((v) => cache.vaults.get(v)!.block));
      for (const [a, b] of ranges) {
        if (b < from) continue;
        const logs = await getLogsRaw(fresh, Math.max(a, from), b);
        await ingest(logs, []);
      }
    }
    cache.scannedTo = ranges[ranges.length - 1][1];
  }
}

async function blockTs(n: number) {
  const hit = cache.ts.get(n);
  if (hit) return hit;
  const b = await client.getBlock({ blockNumber: BigInt(n) });
  const t = Number(b.timestamp);
  cache.ts.set(n, t);
  return t;
}

function jsonArgs(args: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!args || typeof args !== "object") return out;
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (typeof v === "bigint") out[k] = v.toString();
    else if (typeof v === "string") out[k] = /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else out[k] = String(v);
  }
  return out;
}

let lastHead = { n: 0, ts: 0, at: 0 };
export async function head() {
  if (Date.now() - lastHead.at < 2500 && lastHead.n) return lastHead;
  const b = await client.getBlock({ blockTag: "latest" });
  lastHead = { n: Number(b.number), ts: Number(b.timestamp), at: Date.now() };
  return lastHead;
}

/** Scans factory + vault logs up to head (incremental, deduped across concurrent requests). */
export async function logsRpc() {
  const h = await head();
  if (cache.scannedTo < h.n) {
    if (!cache.busy) cache.busy = scan(h.n).finally(() => { cache.busy = null; });
    await cache.busy;
  }
  return { vaults: cache.vaults, events: cache.events };
}

/** Decoded logs of `addrs` over [from, to] (used to top up a lagging DB). */
export async function logsRange(addrs: string[], from: number, to: number): Promise<VaultEvent[]> {
  const out: VaultEvent[] = [];
  const ranges: [number, number][] = [];
  for (let a = from; a <= to; a += CHUNK) ranges.push([a, Math.min(a + CHUNK - 1, to)]);
  for (let i = 0; i < ranges.length; i += 6) {
    const part = await Promise.all(ranges.slice(i, i + 6).map(([a, b]) => getLogsRaw(addrs, a, b)));
    for (const logs of part)
      for (const l of logs) {
        try {
          const dec = decodeEventLog({ abi: ALL_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
          const block = parseInt(l.blockNumber, 16);
          const ts = l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : await blockTs(block);
          const args = jsonArgs(dec.args);
          const vault = dec.eventName === "VaultCreated" ? String(args.vault).toLowerCase() : l.address.toLowerCase();
          out.push(toEvent(l, dec.eventName, { ...args, vault }, ts));
        } catch {
          /* skip */
        }
      }
  }
  return out;
}
