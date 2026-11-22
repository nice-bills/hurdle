import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";

/** Human explanations for every custom error in the Hurdle ABIs. */
export const ERROR_TEXT: Record<string, string> = {
  PriceDeviation:
    "Spot, the block-open price and the TWAP disagree by more than the vault's max tick deviation. Wait for the TWAP to catch up (a few minutes of calm trading) and retry.",
  EpochNotOver: "The epoch has not ended yet. Settlement opens once epochStart + epochSeconds has passed.",
  CapacityExceeded:
    "This would push the bond below its floor (bond / minBondBps caps the vault's size). The curator has to post more bond first.",
  TooManyRebalances: "The curator already used all 4 rebalances this epoch. The count resets at the next settlement.",
  AlreadyParked: "The fired vault is already parked full range. Nothing left to do.",
  DepositWindowClosed:
    "Deposits are only accepted in the first 5 minutes of an epoch. Wait for the next settlement; a deposit at or after the epoch end opens the window itself.",
  NotFired: "Only a fired curator can reclaim its bond.",
  NotParked: "The fired vault is not parked full range yet. Anyone can finish the park first (Finish parking).",
  DeficitOutstanding:
    "The bond paid a shortfall that has not been refilled yet. New deposits wait until the curator beats par enough to refill it, so newcomers never repay compensation that went to others.",
  BondBelowFloor: "The bond is below its floor (minBondBps of NAV). Post more bond before rebalancing.",
  RebalanceIncomplete:
    "More of the vault's value than your idle limit stayed outside the new range (the swap hit its price bound). Nothing changed and the rebalance slot was kept.",
  NotFirstDeposit: "The vault already has a first deposit. Use the regular deposit.",
  Slippage: "The deposit would cost more than your max amounts. Refresh the quote and retry.",
  OnlySelf: "Internal function: only the vault can call it.",
  NotCurator: "Only the vault's curator can do this.",
  CuratorFired: "The curator was fired: the vault is parked passive and no longer takes a bond.",
  ZeroShares: "Enter a share amount above zero (or the vault has no supply yet).",
  WrongHook: "The factory only creates vaults on pools whose hook is the canonical HurdleHook.",
  InsufficientHistory: "The pool's TWAP needs at least 10 minutes of history before vaults can price anything.",
  DonationsDisabled: "Donations are blocked on Hurdle pools (they would inflate par).",
  NoSwapOccurred: "The swap moved nothing (amount too small or price limit hit).",
  InvalidTwapWindow: "Invalid TWAP window.",
  InvalidPool: "This hook only serves the canonical Hurdle pool (a dynamic-fee-free mUSDC/mWETH pool with this hook).",
  HookNotImplemented: "This pool hook does not implement that callback.",
  NotPoolManager: "Only the Uniswap v4 PoolManager can call this hook function.",
  NotSelf: "Internal function: only the hook itself can call it.",
  LockFailure: "The PoolManager lock failed: the call must run inside an unlock callback.",
};

export type DecodedError = { title: string; detail: string; name?: string; rejected?: boolean };

export function decodeError(e: unknown): DecodedError {
  if (e instanceof BaseError) {
    const rejected = e.walk((x) => x instanceof UserRejectedRequestError);
    if (rejected) return { title: "Rejected in wallet", detail: "You declined the request. Nothing was sent.", rejected: true };
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (rev instanceof ContractFunctionRevertedError) {
      const name = rev.data?.errorName ?? rev.reason ?? undefined;
      if (name && ERROR_TEXT[name]) return { title: name, detail: ERROR_TEXT[name], name };
      if (rev.reason) return { title: "Reverted", detail: humanRequire(rev.reason), name: rev.reason };
      if (name) return { title: name, detail: "The contract reverted with " + name + ".", name };
      const sig = (rev as unknown as { signature?: string }).signature;
      return { title: "Reverted", detail: sig ? `Unknown error ${sig}.` : rev.shortMessage, name: sig };
    }
    const msg = e.shortMessage || e.message;
    if (/insufficient funds/i.test(msg)) return { title: "Not enough ETH for gas", detail: "Get Unichain Sepolia ETH from a faucet, then retry." };
    if (/chain/i.test(msg) && /mismatch|switch/i.test(msg)) return { title: "Wrong network", detail: "Switch your wallet to Unichain Sepolia (1301)." };
    return { title: "Transaction failed", detail: msg };
  }
  if (e instanceof Error) return { title: "Error", detail: e.message };
  return { title: "Error", detail: String(e) };
}

function humanRequire(r: string) {
  const map: Record<string, string> = {
    T0: "mUSDC transfer failed: check balance and approval.",
    T1: "mWETH transfer failed: check balance and approval.",
    DEV: "maxTickDeviation must be > 0 and 4 × maxTickDeviation ≤ minBondBps.",
    CARRY: "Carry can be at most 50%.",
    BOND: "minBondBps must be between 100 (1%) and 5000 (50%).",
    EPOCH: "Epochs must be at least 600 seconds.",
    NATIVE: "Native ETH pools are not supported.",
  };
  return map[r] ?? r;
}
