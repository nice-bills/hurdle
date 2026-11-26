"use client";

import { maxUsableTick, minUsableTick } from "@/lib/chain";
import { fmtNum } from "@/lib/format";
import { usdPerEthFromTick } from "@/lib/math";

/**
 * Position range against the current price, drawn on a USD/ETH axis (token order decides the direction: v5 higher tick = dearer ETH, v4 the opposite).
 * `preview` draws a proposed range (curator re-range) over the current one.
 */
export function RangeBar({ lo, hi, tick, twapTick, preview, liquidity, wethIs0 }: { wethIs0?: boolean; lo: number; hi: number; tick: number; twapTick: number | null; preview?: { lo: number; hi: number } | null; liquidity?: string }) {
  const full = lo <= minUsableTick() && hi >= maxUsableTick();
  const empty = (liquidity === "0" || (lo === 0 && hi === 0)) && !full;
  const px = (t: number) => usdPerEthFromTick(t, wethIs0);
  const spot = px(tick);
  const pLo = Math.min(px(lo), px(hi)), pHi = Math.max(px(lo), px(hi)); // price bounds
  const vLo = preview ? Math.min(px(preview.lo), px(preview.hi)) : null, vHi = preview ? Math.max(px(preview.lo), px(preview.hi)) : null;
  // axis: spot ± max(range width, 15%), capped for full range
  const finite = (x: number) => Number.isFinite(x) && x > 0 && x < spot * 50;
  const cands = [spot * 0.85, spot * 1.15, ...(full || empty ? [] : [pLo, pHi]), ...(vLo && finite(vLo) ? [vLo] : []), ...(vHi && finite(vHi) ? [vHi] : [])].filter(finite);
  let a = Math.min(...cands), b = Math.max(...cands);
  const pad = (b - a) * 0.08;
  a -= pad; b += pad;
  const X = (p: number) => `${Math.min(100, Math.max(0, ((p - a) / (b - a)) * 100))}%`;
  const W = (p1: number, p2: number) => `${Math.max(0.5, ((Math.min(b, p2) - Math.max(a, p1)) / (b - a)) * 100)}%`;
  const inRange = full || (tick >= lo && tick < hi);
  const twap = twapTick != null ? px(twapTick) : null;

  return (
    <div>
      <div className="relative h-16">
        {/* axis */}
        <div className="absolute inset-x-0 top-8 h-px bg-line-2" />
        {/* current position */}
        {!empty && (
          <div
            className={`absolute top-5 h-6 rounded-md border ${inRange ? "border-good/50 bg-good-soft" : "border-bad/50 bg-bad-soft"}`}
            style={full ? { left: 0, width: "100%" } : { left: X(pLo), width: W(pLo, pHi) }}
            aria-hidden
          />
        )}
        {preview && vLo && vHi && (
          <div className="absolute top-[18px] h-[28px] rounded-md border-2 border-dashed border-bar" style={{ left: X(vLo), width: W(vLo, vHi) }} aria-hidden />
        )}
        {/* twap */}
        {twap && (
          <div className="absolute top-3 flex -translate-x-1/2 flex-col items-center" style={{ left: X(twap) }}>
            <span className="h-10 w-px border-l border-dashed border-ink-3" />
          </div>
        )}
        {/* spot */}
        <div className="absolute top-0 flex -translate-x-1/2 flex-col items-center" style={{ left: X(spot) }}>
          <span className="num whitespace-nowrap rounded bg-ink px-1.5 py-0.5 text-[11px] font-semibold text-bg">${fmtNum(spot, 0)}</span>
          <span className="h-9 w-[2px] bg-ink" />
        </div>
      </div>
      <div className="num mt-1 flex justify-between text-[11.5px] text-ink-2">
        <span>${fmtNum(a, 0)}</span>
        <span>USDC per ETH</span>
        <span>${fmtNum(b, 0)}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
        {empty ? (
          <span className="text-ink-2">No position yet: funds are idle until the curator rebalances.</span>
        ) : full ? (
          <span><b className="font-semibold">Full range</b> <span className="text-ink-2">(passive, the same position par describes)</span></span>
        ) : (
          <>
            <span className="num"><span className="text-ink-2">Range </span><b className="font-semibold">${fmtNum(pLo, 0)} – ${fmtNum(pHi, 0)}</b></span>
            <span className="num text-ink-2">ticks {lo} → {hi}</span>
            <span className={inRange ? "text-good" : "text-bad"}>{inRange ? "In range, earning fees" : "Out of range, not earning"}</span>
          </>
        )}
        {twap && <span className="num text-ink-2">TWAP ${fmtNum(twap, 0)} (dashed)</span>}
      </div>
    </div>
  );
}
