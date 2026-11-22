// JSON shapes served by /api/*. Big numbers are decimal strings.

export type VaultStatus = "ACTIVE" | "FROZEN" | "FIRED";
export type DataSource = "db" | "rpc";

export interface VaultEvent {
  name: string;
  block: number;
  tx: string;
  logIndex: number;
  ts: number; // unix seconds
  args: Record<string, string | number | boolean>;
}

export interface SeriesPoint {
  ts: number;
  block: number;
  /** cumulative growth indices, 1 = start */
  strategy: number;
  par: number;
  depositor: number;
  /** same indices on the USD basis (mUSDC = $1, mWETH at the settlement price) */
  strategyUsd: number;
  parUsd: number;
  depositorUsd: number;
  /** this segment: nav / bench - 1 */
  vsPar: number;
  price: number;
  kind: "epoch" | "rebase";
  miss: boolean;
  fired?: boolean;
}

export interface VaultTotals {
  settlements: number;
  shortfallPaid: string; // token1 wei
  take: string;
  carry: string;
  beats: number;
  misses: number;
  /** USD, each amount valued at its own settlement price */
  shortfallPaidUsd: number;
  takeUsd: number;
  carryUsd: number;
}

export interface VaultSummary {
  address: string;
  label: string | null;
  note: string | null;
  curator: string;
  poolId: string;
  createdBlock: number | null;
  carryBps: number;
  minBondBps: number;
  maxTickDeviation: number;
  epochSeconds: number;
  epochStart: number;
  firedAt: number;
  fired: boolean;
  nav: string | null;
  bond: string;
  bondValue: string | null;
  bondShares: string;
  deficit: string;
  totalSupply: string;
  lo: number;
  hi: number;
  liquidity: string;
  rebalancesThisEpoch: number;
  startTs: number;
  startNav: string;
  status: VaultStatus;
  bondBps: number | null;
  lastSettle: (VaultEvent & { vsPar: number }) | null;
  cumulative: { strategy: number; par: number; depositor: number; strategyUsd: number; parUsd: number; depositorUsd: number } | null;
  totals: VaultTotals;
  parked: boolean;
  isVault: boolean;
}

export interface PoolState {
  tick: number;
  sqrtPriceX96: string;
  price: number; // USDC per ETH at spot
  twapTick: number | null; // 30-min (shortened to history)
  twap10Tick: number | null;
  referenceTick: number | null;
  twapPrice: number | null;
  liquidity: string;
  history: { ts: number; tick: number }[];
}

export interface Overview {
  source: DataSource;
  head: number;
  headTs: number;
  pool: PoolState;
  vaults: VaultSummary[];
  /** Earlier deployment (v3), read-only: kept so the on-chain fire stays visible. */
  legacyVaults: VaultSummary[];
  stats: {
    vaults: number;
    tvlUsd: number;
    tvlEth: number;
    shortfallPaidUsd: number;
    carryUsd: number;
    settlements: number;
    depositorsBelowPar: number;
  };
  keeper: KeeperRun[];
  updatedAt: number;
}

export interface VaultDetail {
  source: DataSource;
  head: number;
  headTs: number;
  pool: PoolState;
  vault: VaultSummary;
  events: VaultEvent[];
  series: SeriesPoint[];
  snapshots: { ts: number; nav: number; bondBps: number | null }[];
  keeper: KeeperRun[];
  updatedAt: number;
}

export interface KeeperRun {
  ts: number;
  action: string;
  vault: string | null;
  tx: string | null;
  ok: boolean;
  /** simulated, would revert for an expected reason (note = decoded error name): not a failure */
  skipped?: boolean;
  note: string | null;
}
