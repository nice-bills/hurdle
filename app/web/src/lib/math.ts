// Token order is read from the deployment (WETH_IS_0), never assumed. Every price helper takes `wethIs0` (default: the
// current deployment; legacy pools pass their own).
// Raw pool price P = token1/token0 in base units = 1.0001^tick.
//   WETH is token0 (v5): USD per ETH = P * 1e12.   USDC is token0 (v4): USD per ETH = 1e12 / P.
// NAV, bond and par are in token1 (v5: mUSDC, 6 dec; v4: mWETH, 18 dec).
import { WETH_IS_0 } from "./chain";

const Q96 = 2 ** 96;
const DEC_SHIFT = 1e12; // 10^(18-6)

const usdFromRaw = (p: number, wethIs0: boolean) => (wethIs0 ? p * DEC_SHIFT : DEC_SHIFT / p);
export const usdPerEthFromTick = (tick: number, wethIs0 = WETH_IS_0) => usdFromRaw(Math.pow(1.0001, tick), wethIs0);
export const usdPerEthFromSqrt = (sqrtPriceX96: bigint | string | number, wethIs0 = WETH_IS_0) => {
  const s = Number(sqrtPriceX96) / Q96;
  return usdFromRaw(s * s, wethIs0);
};
/** Inverse of usdPerEthFromTick (fractional tick). */
export const tickFromUsd = (usd: number, wethIs0 = WETH_IS_0) =>
  Math.log(wethIs0 ? usd / DEC_SHIFT : DEC_SHIFT / usd) / Math.log(1.0001);

/** USD value of a token1 (bond-unit) amount: mWETH priced at `usdPerEth`, mUSDC is $1. */
export const bondToUsd = (raw: bigint | string | number | null | undefined, usdPerEth: number, bondIsWeth = !WETH_IS_0) =>
  raw == null ? 0 : bondIsWeth ? (Number(raw) / 1e18) * usdPerEth : Number(raw) / 1e6;
export const alignTick = (t: number, spacing: number, mode: "floor" | "ceil" | "round" = "round") =>
  Math[mode](t / spacing) * spacing;

/** 18-decimal amount -> float. */
export const ethFloat = (wei: bigint | string | null | undefined) => (wei == null ? 0 : Number(BigInt(wei)) / 1e18);
export const usdcFloat = (raw: bigint | string | null | undefined) => (raw == null ? 0 : Number(BigInt(raw)) / 1e6);

/** value of token0 raw amount in token1 wei at sqrt price. */
export function valueInToken1(a0: bigint, a1: bigint, sqrtPriceX96: bigint): bigint {
  const Q = 1n << 96n;
  return (((a0 * sqrtPriceX96) / Q) * sqrtPriceX96) / Q + a1;
}

/** bps ratio a/b as number (e.g. 512 = 5.12%). */
export function bpsOf(a: bigint | string | null | undefined, b: bigint | string | null | undefined): number | null {
  if (a == null || b == null) return null;
  const A = BigInt(a), B = BigInt(b);
  if (B === 0n) return null;
  return Number((A * 1_000_000n) / B) / 100;
}

export const mulDivUp = (a: bigint, b: bigint, c: bigint) => (a * b + c - 1n) / c;

/** Uniswap v3/v4 amounts in a position for a given liquidity (float, for display only). */
export function positionAmounts(liq: number, tick: number, lo: number, hi: number) {
  const sp = Math.sqrt(Math.pow(1.0001, tick));
  const sa = Math.sqrt(Math.pow(1.0001, lo));
  const sb = Math.sqrt(Math.pow(1.0001, hi));
  let a0 = 0, a1 = 0;
  if (sp <= sa) a0 = liq * (sb - sa) / (sa * sb);
  else if (sp >= sb) a1 = liq * (sb - sa);
  else { a0 = liq * (sb - sp) / (sp * sb); a1 = liq * (sp - sa); }
  return { a0, a1 };
}
