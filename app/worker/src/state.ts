/** Shared in-memory status surfaced by /healthz. */
export const state = {
  startedAt: Date.now(),
  head: 0,
  indexedBlock: 0,
  lastIndexerOkAt: 0,
  lastIndexerError: "" as string,
  lastSnapshotAt: 0,
  vaults: 0,
  keeperAddress: null as string | null,
  keeperBalanceWei: null as bigint | null,
  lastKeeperRunAt: 0,
  lastKeeperAction: null as { ts: string; action: string; vault: string | null; tx: string | null; ok: boolean; note: string | null } | null,
  curatorAddress: null as string | null,
  lastCuratorRunAt: 0,
  curatorBalanceWei: null as bigint | null,
  targetTick: null as number | null,
  lastArbAt: 0,
  lastKeeperError: "" as string,
  /** Visible curator warnings, keyed by "<vault>:<kind>"; set on a problem, cleared when it resolves. Surfaced in /healthz. */
  curatorWarnings: new Map<string, string>(),
  /** Vault (lowercase) -> ms timestamp since which the curator has seen its position out of range. */
  outOfRangeSince: new Map<string, number>(),
};
