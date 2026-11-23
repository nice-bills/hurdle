import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Abi, Address, Hex } from "viem";

const here = dirname(fileURLToPath(import.meta.url));

/** app/shared is found next to the worker (monorepo), or copied into ./shared by `npm run build`. */
function findShared(): string {
  const candidates = [
    process.env.SHARED_DIR,
    join(here, "..", "shared"),
    join(here, "..", "..", "shared"),
    join(here, "..", "..", "..", "shared"),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(join(c, "deployment-1301.json"))) return c;
  throw new Error(`app/shared not found (tried ${candidates.join(", ")})`);
}

export const SHARED = findShared();
export const WORKER_DIR = existsSync(join(here, "..", "schema.sql")) ? join(here, "..") : join(here, "..", "..");

export interface Deployment {
  chainId: number;
  hook: Address;
  factory: Address;
  patientVault: Address;
  chaserVault: Address;
  recklessVault: Address;
  /** Earlier deployment (v3), read-only: the worker never keeps it. */
  legacy?: { factory: Address; patientVault: Address; chaserVault: Address; factoryStartBlock: number };
  mUSDC: Address;
  mWETH: Address;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  swapRouter: Address;
  liquidityRouter: Address;
  poolManager: Address;
  factoryStartBlock: number;
  rpc: string;
  explorer: string;
}

export const deployment: Deployment = JSON.parse(readFileSync(join(SHARED, "deployment-1301.json"), "utf8"));

const abi = (n: string) => JSON.parse(readFileSync(join(SHARED, "abi", `${n}.json`), "utf8")) as Abi;
export const vaultAbi = abi("HurdleVault");
export const factoryAbi = abi("HurdleVaultFactory");
export const hookAbi = abi("HurdleHook");
export const swapTestAbi = abi("PoolSwapTest");
export const erc20Abi = abi("MockERC20");

const num = (v: string | undefined, d: number) => {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

export const env = {
  databaseUrl: process.env.DATABASE_URL,
  rpcUrl: process.env.RPC_URL || deployment.rpc,
  port: num(process.env.PORT, 8080),
  confirmations: num(process.env.CONFIRMATIONS, 3),
  chunk: Math.min(1000, num(process.env.LOG_CHUNK, 1000)),
  pollMs: num(process.env.POLL_SECONDS, 6) * 1000,
  snapshotMs: num(process.env.SNAPSHOT_SECONDS, 120) * 1000,
  keeperMs: num(process.env.KEEPER_INTERVAL_SECONDS, 600) * 1000,
  /** Never logged. Accepts with or without 0x. */
  keeperKey: normalizeKey(process.env.KEEPER_PRIVATE_KEY, "KEEPER_PRIVATE_KEY"),
  curatorKey: normalizeKey(process.env.CURATOR_PRIVATE_KEY, "CURATOR_PRIVATE_KEY"),
  curatorMs: num(process.env.CURATOR_INTERVAL_SECONDS, 600) * 1000,
};

function normalizeKey(k: string | undefined, name: string): Hex | undefined {
  if (!k) return undefined;
  const t = k.trim();
  const h = (t.startsWith("0x") ? t : `0x${t}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) {
    console.error(`${name} is set but is not a 32-byte hex key; disabled`);
    return undefined;
  }
  return h;
}
