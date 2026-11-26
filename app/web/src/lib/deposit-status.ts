import { BOND, DEPOSIT_WINDOW } from "./chain";
import { bondToUsd } from "./math";
import { fmtBond } from "./unit";
import { fmtDuration, fmtUsd } from "./format";
import type { VaultSummary } from "./types";

export type DepositStatus = {
  /** true when a deposit would revert right now */
  blocked: boolean;
  tone: "info" | "warn";
  /** one line, shown at the top of the Deposit tab (also before a wallet is connected) */
  text: string;
};

/** Contract rule: deposits revert while deficit > 1 bp of NAV (DeficitOutstanding). */
const deficitOutstanding = (v: VaultSummary) => {
  const nav = v.nav ? BigInt(v.nav) : 0n;
  return nav > 0n && BigInt(v.deficit || "0") * 10_000n > nav;
};

/**
 * Why a deposit is impossible right now, in one line; null when deposits are open and nothing is in the way.
 * Mirrors HurdleVault.deposit: window (the first DEPOSIT_WINDOW seconds of an epoch, or an overdue epoch that the
 * deposit settles first), no first deposit yet, DeficitOutstanding, and the bond floor (a fired vault skips both but must be parked: NotParked).
 */
export function depositStatus(v: VaultSummary, now: number, price: number): DepositStatus | null {
  const end = v.epochStart + v.epochSeconds;
  const due = v.epochStart > 0 && now >= end;
  const windowOpen = v.epochStart > 0 && (now <= v.epochStart + DEPOSIT_WINDOW || due);
  const toNext = Math.max(0, end - now);
  const nextWindow = due ? "now (the epoch is over; a deposit settles it first)" : `in ${fmtDuration(toNext)}`;

  if (BigInt(v.totalSupply || "0") === 0n)
    return { blocked: true, tone: "warn", text: "Deposits are closed: the curator has not made the first deposit yet." };

  if (v.fired) {
    // Current src (audit3): a fired vault takes deposits only while parked (NotParked otherwise). The deployed
    // bytecode predates this; the line is still accurate advice there (an unparked fired vault holds the
    // fired curator's range with no bond behind it).
    if (!v.parked)
      return {
        blocked: true,
        tone: "warn",
        text: "Deposits are closed (NotParked): this fired vault has not finished parking full range, so it has no bond and is not yet at par. Anyone can finish the park (Finish parking); deposits reopen once it is parked.",
      };
    // Mirrors the deployed v4 bytecode (7f1792a), where fired vaults still apply the deficit gate. Current src
    // (45bde1f+) skips it for fired vaults: drop this branch when the next deployment ships that change.
    if (deficitOutstanding(v)) {
      const d = BigInt(v.deficit);
      return {
        blocked: true,
        tone: "warn",
        text: `Passive vault, but deposits are closed (DeficitOutstanding): ${fmtBond(d)} ${BOND.symbol} (${fmtUsd(bondToUsd(d, price))}) of bond payout is still booked against the fired curator. Deposits reopen once the curator calls reclaimBond.`,
      };
    }
    const noBond = BigInt(v.bondValue ?? v.bond ?? "0") === 0n;
    const lead = `Passive vault${noBond ? " (curator fired, bond 0)" : " (curator fired)"}: no bond behind it, deposits are allowed in the deposit window.`;
    return windowOpen
      ? { blocked: false, tone: "info", text: `${lead} The window is open now.` }
      : { blocked: true, tone: "info", text: `${lead} Next window ${nextWindow}.` };
  }

  const out: string[] = [];
  if (!windowOpen) out.push(`The deposit window is closed (first ${DEPOSIT_WINDOW / 60} minutes of each epoch); the next one opens ${nextWindow}.`);
  if (v.status === "FROZEN")
    out.push(`Frozen below the bond floor (${((v.bondBps ?? 0) / 100).toFixed(2)}% of NAV vs ${v.minBondBps / 100}%): the curator must post bond first.`);
  if (deficitOutstanding(v)) {
    const d = BigInt(v.deficit);
    out.push(`DeficitOutstanding: the curator must repay ${fmtBond(d)} ${BOND.symbol} (${fmtUsd(bondToUsd(d, price))}) of bond payout before new deposits.`);
  }
  return out.length ? { blocked: true, tone: "warn", text: out.join(" ") } : null;
}
