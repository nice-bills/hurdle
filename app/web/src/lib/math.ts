// Price conventions: currency0 = mUSDC (6 dec), currency1 = mWETH (18 dec).
// Raw pool price P = token1/token0 in base units = 1.0001^tick. USDC per ETH = 1e12 / P.
// NAV, bond and par are in token1 (mWETH wei).

const Q96 = 2 ** 96;
const DEC_SHIFT = 1e12; // 10^(18-6)

export const usdPerEthFromTick = (tick: number) => DEC_SHIFT / Math.pow(1.0001, tick);
export const usdPerEthFromSqrt = (sqrtPriceX96: bigint | string | number) => {
  const s = Number(sqrtPriceX96) / Q96;
  return DEC_SHIFT / (s * s);
};
export const tickFromUsd = (usd: number) => Math.log(DEC_SHIFT / usd) / Math.log(1.0001);
export const alignTick = (t: number, spacing: number, mode: "floor" | "ceil" | "round" = "round") =>
  Math[mode](t / spacing) * spacing;

/** token1 wei -> float ETH. */
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
