"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fmtEth, fmtUsd } from "./format";
import type { PoolState } from "./types";

export type Unit = "usd" | "eth";
const KEY = "hurdle-unit";

const Ctx = createContext<{ unit: Unit; setUnit: (u: Unit) => void }>({ unit: "usd", setUnit: () => {} });

/** USD is the default; the choice is remembered per browser (localStorage may be blocked: then it just resets). */
export function UnitProvider({ children }: { children: ReactNode }) {
  const [unit, set] = useState<Unit>("usd");
  useEffect(() => {
    try {
      const v = localStorage.getItem(KEY);
      if (v === "usd" || v === "eth") set(v);
    } catch {
      /* private mode / blocked storage */
    }
  }, []);
  const setUnit = useCallback((u: Unit) => {
    set(u);
    try {
      localStorage.setItem(KEY, u);
    } catch {
      /* ignore */
    }
  }, []);
  const value = useMemo(() => ({ unit, setUnit }), [unit, setUnit]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useUnit = () => useContext(Ctx);

/** ETH price the contract marks NAV at: the hook TWAP (spot only if the TWAP is not available). */
export const markPrice = (pool: Pick<PoolState, "price" | "twapPrice">) => pool.twapPrice ?? pool.price;

/** Format an mWETH-wei amount in the chosen unit at `price` (USD per ETH). */
export function money(wei: bigint | string | null | undefined, price: number, unit: Unit, sig = 4): string {
  if (wei == null) return "–";
  return unit === "usd" ? fmtUsd((Number(BigInt(wei)) / 1e18) * price) : `${fmtEth(wei, sig)} mWETH`;
}
/** The same amount in the other unit, for secondary lines. */
export const moneyAlt = (wei: bigint | string | null | undefined, price: number, unit: Unit) => money(wei, price, unit === "usd" ? "eth" : "usd");

export const unitName = (u: Unit) => (u === "usd" ? "USD" : "mWETH");

export function UnitToggle({ className = "" }: { className?: string }) {
  const { unit, setUnit } = useUnit();
  return (
    <div role="group" aria-label="Display unit" className={`inline-flex items-center gap-2 text-[12.5px] text-ink-2 ${className}`}>
      <span aria-hidden>Show in</span>
      <div className="flex gap-0.5 rounded-lg border border-line bg-bg-2 p-0.5">
        {(["usd", "eth"] as const).map((u) => (
          <button
            key={u}
            type="button"
            aria-pressed={unit === u}
            onClick={() => setUnit(u)}
            className={`rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors ${unit === u ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink"}`}
          >
            {unitName(u)}
          </button>
        ))}
      </div>
    </div>
  );
}
