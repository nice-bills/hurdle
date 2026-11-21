import { createServer } from "node:http";
import { formatEther } from "viem";
import { env } from "./config.js";
import { state } from "./state.js";

export function startHealth() {
  const server = createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/healthz/" || req.url === "/") {
      const lag = state.head && state.indexedBlock ? Math.max(0, state.head - state.indexedBlock) : null;
      const body = {
        ok: true,
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
          lastRunAt: state.lastKeeperRunAt ? new Date(state.lastKeeperRunAt).toISOString() : null,
          lastAction: state.lastKeeperAction,
          lastError: state.lastKeeperError || null,
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
