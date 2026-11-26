// Pure mirror of HurdleVault.deposit's gates (no imports, so e2e_deposit_gate.mjs can run it under node).
export type GateInput = {
  epochStart: number;
  epochSeconds: number;
  totalSupply: string;
  bondShares: string;
  curatorShares?: string;
  deficit: string;
  nav: string | null;
  fired: boolean;
  parked: boolean;
  status: string;
};

/**
 * Contract rule (HurdleVault.deposit, non-fired only): revert DeficitOutstanding while
 * deficit * 10_000 * supply > nav * (supply - bondShares - balanceOf[curator]) * DEFICIT_TOLERANCE_BPS (1).
 * The deficit is owed by depositor shares only, so it is compared with their NAV. `nav` is the dApp's reading
 * of navAt(TWAP), the same price the contract uses, so the two can differ by a rounding sliver.
 */
export const deficitOutstanding = (v: GateInput) => {
  const nav = v.nav ? BigInt(v.nav) : 0n;
  const supply = BigInt(v.totalSupply || "0");
  const excluded = BigInt(v.bondShares || "0") + BigInt(v.curatorShares || "0");
  const depositors = supply > excluded ? supply - excluded : 0n;
  return nav > 0n && BigInt(v.deficit || "0") * 10_000n * supply > nav * depositors;
};

export type Blocker = "empty" | "notParked" | "window" | "frozen" | "deficit";

/** Everything that would make deposit() revert now. Fired + parked vaults skip the deficit and bond-floor gates. */
export function depositBlockers(v: GateInput, now: number, windowSeconds: number): Blocker[] {
  if (BigInt(v.totalSupply || "0") === 0n) return ["empty"];
  const end = v.epochStart + v.epochSeconds;
  const due = v.epochStart > 0 && now >= end;
  const out: Blocker[] = [];
  if (!(v.epochStart > 0 && (now <= v.epochStart + windowSeconds || due))) out.push("window");
  if (v.fired) {
    if (!v.parked) out.push("notParked");
    return out;
  }
  if (v.status === "FROZEN") out.push("frozen");
  if (deficitOutstanding(v)) out.push("deficit");
  return out;
}
