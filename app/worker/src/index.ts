import { makePublicClient } from "./chain.js";
import { env } from "./config.js";
import { applySchema, makePool } from "./db.js";
import { startHealth } from "./health.js";
import { runIndexer } from "./indexer.js";
import { makeKeeper } from "./keeper.js";
import { errMsg, log, sleep } from "./util.js";

process.on("unhandledRejection", (e) => log("main", `unhandledRejection: ${errMsg(e)}`));
process.on("uncaughtException", (e) => log("main", `uncaughtException: ${errMsg(e)}`));

const signal = { stopped: false };
const server = startHealth();
log("main", `healthz on :${env.port}`);

const db = makePool();
// Retry schema application so a slow-booting database does not crash the service.
for (let i = 1; ; i++) {
  try {
    await applySchema(db);
    break;
  } catch (e) {
    log("main", `schema apply failed (attempt ${i}): ${errMsg(e)}`);
    await sleep(Math.min(2000 * i, 20_000));
  }
}

const client = makePublicClient();
const keeper = makeKeeper(db, client);
if (!keeper) log("main", "KEEPER_PRIVATE_KEY absent or invalid: running indexer only");

const shutdown = () => {
  signal.stopped = true;
  server.close();
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await Promise.all([runIndexer(db, client, signal), keeper ? keeper.run(signal) : Promise.resolve()]);
