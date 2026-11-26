import { createServer } from "node:http";
import { formatEther } from "viem";
import { env } from "./config.js";

const low = (wei: bigint | null) => (wei === null ? null : wei < env.lowBalanceWei);
const lowFlag = (wei: bigint | null) => low(wei) === true;
import { state } from "./state.js";

export function startHealth() {
  const server = createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/healthz/" || req.url === "/") {
      const lag = state.head && state.indexedBlock ? Math.max(0, state.head - state.indexedBlock) : null;
      const body = {
        ok: true,
        // warn < 0.002 ETH (LOW_BALANCE_WEI): a wallet that runs dry stops the keeper or the curator bot silently
        warnings: [
          ...(lowFlag(state.keeperBalanceWei) ? [`keeper wallet low: ${formatEther(state.keeperBalanceWei!)} ETH (< ${formatEther(env.lowBalanceWei)})`] : []),
          ...[...state.curatorWarnings.values()].map((w) => `curator: ${w}`),
          ...[...state.outOfRangeSince].filter(([, since]) => Date.now() - since > env.outOfRangeWarnMs).map(([v, since]) => `vault ${v} out of range for ${Math.round((Date.now() - since) / 60000)} min (> ${Math.round(env.outOfRangeWarnMs / 60000)} min)`),
          ...(lowFlag(state.curatorBalanceWei) ? [`curator wallet low: ${formatEther(state.curatorBalanceWei!)} ETH (< ${formatEther(env.lowBalanceWei)})`] : []),
        ],
        uptimeSeconds: Math.floor((Date.now() - state.startedAt) / 1000),
        indexer: {
          lastIndexedBlock: state.indexedBlock || null,
          chainHead: state.head || null,
          lagBlocks: lag,
          vaults: state.vaults,
          lastOkAt: state.lastIndexerOkAt ? new Date(state.lastIndexerOkAt).toISOString() : null,
          lastSnapshotAt: state.lastSnapshotAt ? new Date(state.lastSnapshotAt).toISOString() : null,
          lastError: state.lastIndexerError || null,
        },
        keeper: {
          enabled: !!state.keeperAddress,
          address: state.keeperAddress,
          balanceEth: state.keeperBalanceWei === null ? null : formatEther(state.keeperBalanceWei),
          lowBalance: low(state.keeperBalanceWei),
          targetTick: state.targetTick,
          lastArbAt: state.lastArbAt ? new Date(state.lastArbAt).toISOString() : null,
          lastRunAt: state.lastKeeperRunAt ? new Date(state.lastKeeperRunAt).toISOString() : null,
          lastAction: state.lastKeeperAction,
          lastError: state.lastKeeperError || null,
        },
        curator: {
          enabled: !!state.curatorAddress,
          address: state.curatorAddress,
          balanceEth: state.curatorBalanceWei === null ? null : formatEther(state.curatorBalanceWei),
          lowBalance: low(state.curatorBalanceWei),
          lastRunAt: state.lastCuratorRunAt ? new Date(state.lastCuratorRunAt).toISOString() : null,
        },
      };
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404).end("not found");
  });
  server.listen(env.port, "0.0.0.0");
  return server;
}
