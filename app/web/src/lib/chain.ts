import { concat, defineChain, encodeAbiParameters, keccak256, pad, toHex, type Address, type Hex } from "viem";
import { deployment } from "@/shared/deployment";

export const D = deployment;
export const CHAIN_ID = deployment.chainId;
export const RPC_URL = deployment.rpc;
export const EXPLORER = deployment.explorer.replace(/\/$/, "");

export const unichainSepolia = defineChain({
  id: deployment.chainId,
  name: "Unichain Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [deployment.rpc] } },
  blockExplorers: { default: { name: "Uniscan", url: EXPLORER } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

export const ADDR = {
  hook: deployment.hook as Address,
  factory: deployment.factory as Address,
  patient: deployment.patientVault as Address,
  chaser: deployment.chaserVault as Address,
  reckless: deployment.recklessVault as Address,
  usdc: deployment.mUSDC as Address,
  weth: deployment.mWETH as Address,
  token0: deployment.currency0 as Address,
  token1: deployment.currency1 as Address,
  swapRouter: deployment.swapRouter as Address,
  liquidityRouter: deployment.liquidityRouter as Address,
  poolManager: deployment.poolManager as Address,
};

export const TOKENS = {
  token0: { address: ADDR.token0, symbol: "mUSDC", decimals: 6 },
  token1: { address: ADDR.token1, symbol: "mWETH", decimals: 18 },
} as const;

export const POOL_KEY = {
  currency0: ADDR.token0,
  currency1: ADDR.token1,
  fee: deployment.fee,
  tickSpacing: deployment.tickSpacing,
  hooks: ADDR.hook,
} as const;

const poolIdOf = (c0: Address, c1: Address, fee: number, spacing: number, hooks: Address): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [c0, c1, fee, spacing, hooks],
    ),
  );

export const POOL_ID: Hex = poolIdOf(POOL_KEY.currency0, POOL_KEY.currency1, POOL_KEY.fee, POOL_KEY.tickSpacing, POOL_KEY.hooks);

/** v4-core StateLibrary: pools mapping at slot 6. */
export function poolStateSlot(poolId: Hex = POOL_ID): Hex {
  return keccak256(concat([poolId, pad(toHex(6n), { size: 32 })]));
}

/** Earlier deployment (v3): read-only, kept as the fire showcase (Patient v3 was fired on-chain). */
export const LEGACY = deployment.legacy;
export const LEGACY_VAULTS = [LEGACY.patientVault, LEGACY.chaserVault].map((a) => a.toLowerCase());

/** A pool and the hook that holds its TWAP. v3 vaults live on their own pool (v3 hook, v3 mUSDC/mWETH), not the v4 one. */
export type PoolRef = { poolId: Hex; hook: Address };
export const V4_POOL: PoolRef = { poolId: POOL_ID, hook: ADDR.hook };
export const LEGACY_POOL: PoolRef = {
  poolId: poolIdOf(LEGACY.currency0 as Address, LEGACY.currency1 as Address, deployment.fee, deployment.tickSpacing, LEGACY.hook as Address),
  hook: LEGACY.hook as Address,
};
export const poolRefFor = (vault: string): PoolRef => (LEGACY_VAULTS.includes(vault.toLowerCase()) ? LEGACY_POOL : V4_POOL);

export const KNOWN_LABELS: Record<string, { name: string; note: string }> = {
  [deployment.patientVault.toLowerCase()]: { name: "Patient", note: "±10% wide range, re-centered by the demo bot near its edges" },
  [deployment.chaserVault.toLowerCase()]: { name: "Chaser", note: "±2% range, re-centered by the demo bot" },
  [deployment.recklessVault.toLowerCase()]: { name: "Reckless", note: "±1% range, 2.5% bond, built to get fired" },
  [LEGACY.patientVault.toLowerCase()]: { name: "Patient (v3)", note: "±10% range, fired on-chain 2026-11-22" },
  [LEGACY.chaserVault.toLowerCase()]: { name: "Chaser (v3)", note: "±2% range, read-only since v4" },
};

export const txUrl = (h: string) => `${EXPLORER}/tx/${h}`;
export const addrUrl = (a: string) => `${EXPLORER}/address/${a}`;
export const blockUrl = (b: number | string) => `${EXPLORER}/block/${b}`;

export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const minUsableTick = (s = deployment.tickSpacing) => Math.ceil(MIN_TICK / s) * s;
export const maxUsableTick = (s = deployment.tickSpacing) => Math.floor(MAX_TICK / s) * s;

export const DEPOSIT_WINDOW = 300;
export const MAX_REBALANCES = 4;
export const SETTLER_BOUNTY_BPS = 500;
export const REBALANCE_TWAP_WINDOW = 600;
