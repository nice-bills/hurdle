import { createPublicClient, defineChain, http, keccak256, concat, pad, toHex, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { deployment, env } from "./config.js";

export const chain = defineChain({
  id: deployment.chainId,
  name: "Unichain Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.rpcUrl] } },
  blockExplorers: { default: { name: "Uniscan", url: deployment.explorer } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export function makePublicClient() {
  return createPublicClient({
    chain,
    transport: http(env.rpcUrl, { retryCount: 2, retryDelay: 800, timeout: 20_000 }),
  });
}
export type Client = ReturnType<typeof makePublicClient>;

const managerAbi = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
/** PoolManager `pools` mapping slot (v4-core StateLibrary.POOLS_SLOT). */
const POOLS_SLOT = 6n;

export function poolStateSlot(poolId: Hex): Hex {
  return keccak256(concat([poolId, pad(toHex(POOLS_SLOT), { size: 32 })]));
}

/** StateLibrary.getSlot0 equivalent through PoolManager.extsload: sqrtPriceX96 (160) | tick (24, signed) | ... */
export async function readSlot0(client: PublicClient, poolId: Hex, blockNumber?: bigint) {
  const raw = await client.readContract({
    address: deployment.poolManager,
    abi: managerAbi,
    functionName: "extsload",
    args: [poolStateSlot(poolId)],
    blockNumber,
  });
  const v = BigInt(raw);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);
  let tick = Number((v >> 160n) & 0xffffffn);
  if (tick >= 0x800000) tick -= 0x1000000;
  return { sqrtPriceX96, tick };
}

/** keccak256(abi.encode(PoolKey)) = PoolId. */
export function computePoolId(): Hex {
  const word = (a: string) => pad(a as Hex, { size: 32 });
  const int = (n: number) => pad(toHex(BigInt.asUintN(256, BigInt(n))), { size: 32 });
  return keccak256(
    concat([word(deployment.currency0), word(deployment.currency1), int(deployment.fee), int(deployment.tickSpacing), word(deployment.hook)]),
  );
}

export const lc = (a: string) => a.toLowerCase();
export type { Address };
