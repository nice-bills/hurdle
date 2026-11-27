"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { BOND_IS_WETH } from "./chain";
import { fmtEth, fmtToken, fmtUsd } from "./format";
import { bondToUsd } from "./math";
import type { PoolState } from "./types";
import { Segmented } from "@/components/ui";

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

/**
 * Format a bond-unit (token1) amount in the chosen unit at `price` (USD per ETH). token1 is mUSDC (6 dec) in v5 and
 * mWETH (18 dec) in v4: pass `bondIsWeth` for a pool with the other order (default: the current deployment).
 * "eth" shows the amount in its own token (the contract's unit).
 */
export function money(wei: bigint | string | null | undefined, price: number, unit: Unit, sig = 4, bondIsWeth = BOND_IS_WETH): string {
  if (wei == null) return "–";
  if (unit === "usd") return fmtUsd(bondToUsd(wei, price, bondIsWeth));
  return bondIsWeth ? `${fmtEth(wei, sig)} mWETH` : `${fmtToken(wei, 6, sig)} mUSDC`;
}
/** The same amount in the other unit, for secondary lines. */
export const moneyAlt = (wei: bigint | string | null | undefined, price: number, unit: Unit, bondIsWeth = BOND_IS_WETH) =>
  money(wei, price, unit === "usd" ? "eth" : "usd", 4, bondIsWeth);

/** A bond-unit (token1) amount in its own token, no symbol. Vault shares are minted 1:1 in these units too. */
export const fmtBond = (raw: bigint | string | null | undefined, bondIsWeth = BOND_IS_WETH, sig = 4) => fmtToken(raw, bondIsWeth ? 18 : 6, sig);

export const unitName = (u: Unit, bondIsWeth = BOND_IS_WETH) => (u === "usd" ? "USD" : bondIsWeth ? "mWETH" : "mUSDC");

export function UnitToggle({ className = "" }: { className?: string }) {
  const { unit, setUnit } = useUnit();
  return (
    <span className={`inline-flex items-center gap-2 text-[12.5px] text-ink-2 ${className}`}>
      <span aria-hidden>Show in</span>
      <Segmented label="Display unit" value={unit} onChange={setUnit} className="[&>button]:h-[30px] [&>button]:px-3 [&>button]:text-[12.5px]" options={(["usd", "eth"] as const).map((u) => ({ v: u, label: unitName(u) }))} />
    </span>
  );
}
