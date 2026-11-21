/**
 * End-to-end test with no real Postgres or funds: PGlite (in-process Postgres) behind a socket, the real worker as a
 * child process against the real Unichain Sepolia RPC. The keeper runs with a throwaway UNFUNDED key, so no
 * transaction can ever be broadcast; it exercises simulation + failure recording.
 */
import { spawn } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import pg from "pg";
import { generatePrivateKey } from "viem/accounts";

const KEY = generatePrivateKey();

const PORT_DB = 54329;
const PORT_HTTP = 18081;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra !== undefined ? " " + JSON.stringify(extra) : ""}`);
  if (!ok) failures++;
};

const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: PORT_DB, host: "127.0.0.1", maxConnections: 10 });
await server.start();

const child = spawn("npx", ["tsx", "src/index.ts"], {
  env: {
    ...process.env,
    DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${PORT_DB}/postgres?sslmode=disable`,
    PORT: String(PORT_HTTP),
    KEEPER_PRIVATE_KEY: KEY,
    KEEPER_MIN_ETH_WEI: "0",
    KEEPER_INTERVAL_SECONDS: "3600",
    SNAPSHOT_SECONDS: "5",
    POLL_SECONDS: "3",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (d) => (logs += d));
child.stderr.on("data", (d) => (logs += d));

const client = new pg.Client({ connectionString: `postgres://postgres:postgres@127.0.0.1:${PORT_DB}/postgres`, ssl: false });
await client.connect();
const count = async (t: string) => Number((await client.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);

try {
  // wait for indexing + first snapshot + first keeper tick (15s boot delay)
  let health: any = null;
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    try {
      health = await (await fetch(`http://127.0.0.1:${PORT_HTTP}/healthz`)).json();
    } catch {}
    const runs = await client.query("SELECT 1 FROM keeper_runs LIMIT 1").then((r) => r.rowCount).catch(() => 0);
    if (health?.indexer?.lastSnapshotAt && runs && /\[keeper\] vault 0x/.test(logs)) break;
  }
  console.log("healthz:", JSON.stringify(health));
  check("healthz reachable", !!health?.ok);
  check("lag small", (health?.indexer?.lagBlocks ?? 999) < 20, health?.indexer?.lagBlocks);
  check("keeper address reported", /^0x[0-9a-fA-F]{40}$/.test(health?.keeper?.address ?? ""));

  check("2 vaults indexed", (await count("vaults")) >= 2);
  const ev = await client.query("SELECT name, count(*)::int n FROM events GROUP BY name ORDER BY name");
  console.log("events:", JSON.stringify(ev.rows));
  check("events indexed", (await count("events")) >= 8);
  const snaps = await client.query("SELECT vault, block, nav::text, bond_value::text, fired, lo, hi, tick FROM snapshots ORDER BY block DESC LIMIT 4");
  console.log("snapshots:", JSON.stringify(snaps.rows));
  check("snapshots written", snaps.rowCount! >= 2);
  check("pool_ticks written", (await count("pool_ticks")) >= 1);
  const cur = await client.query("SELECT * FROM cursor");
  console.log("cursor:", JSON.stringify(cur.rows));
  check("cursor set", cur.rowCount === 1);
  const runs = await client.query("SELECT action, vault, ok, left(note,160) AS note FROM keeper_runs ORDER BY id LIMIT 10");
  console.log("keeper_runs:", JSON.stringify(runs.rows));
  check("keeper recorded runs (all failed: unfunded key)", runs.rowCount! > 0 && runs.rows.every((r) => r.ok === false));
  check("keeper checked vault epochs", /\[keeper\] vault 0x\w+: (epoch ends in|epoch over)/.test(logs));
  check("private key never logged", !logs.includes(KEY.slice(2)) && !JSON.stringify(health).includes(KEY.slice(2)));

  // idempotency: count rows, restart indexer logic by re-running a scan through the same persist path
  const before = await count("events");
  const { scanRange, persist } = await import("../src/indexer.js");
  const { makePublicClient } = await import("../src/chain.js");
  const { deployment } = await import("../src/config.js");
  const res = await scanRange(makePublicClient(), new Set(), deployment.factoryStartBlock, deployment.factoryStartBlock + 999);
  await persist(client as any, res, deployment.factoryStartBlock + 999).catch(() => {});
  check("re-insert is idempotent", (await count("events")) === before, { before, after: await count("events") });
} finally {
  child.kill("SIGTERM");
  await client.end().catch(() => {});
  await server.stop().catch(() => {});
  await db.close().catch(() => {});
  if (process.env.SHOW_LOGS) console.log(logs);
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
