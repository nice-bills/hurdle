/** Dry run: scans the real chain from factoryStartBlock and prints what the indexer would insert. No DB, no txs. */
import { makePublicClient, computePoolId, lc } from "./chain.js";
import { deployment, env } from "./config.js";
import { scanRange, takeSnapshots, type EventRec, type VaultRec } from "./indexer.js";
import { withRetry, replacer } from "./util.js";

const client = makePublicClient();
const head = Number(await withRetry(() => client.getBlockNumber(), "blockNumber"));
const safe = head - env.confirmations;
console.log(`chain ${deployment.chainId} head ${head}, safe ${safe}, scanning ${deployment.factoryStartBlock}..${safe} in ${env.chunk}-block chunks`);

const known = new Set<string>();
const vaults: VaultRec[] = [];
const events: EventRec[] = [];
for (let from = deployment.factoryStartBlock; from <= safe; from += env.chunk) {
  const to = Math.min(from + env.chunk - 1, safe);
  const r = await scanRange(client, known, from, to);
  for (const v of r.created) known.add(v.address);
  vaults.push(...r.created);
  events.push(...r.events);
}
console.log(`\nWOULD INSERT ${vaults.length} vaults:`);
for (const v of vaults) console.log(JSON.stringify(v, replacer));
const counts: Record<string, number> = {};
for (const e of events) counts[e.name] = (counts[e.name] ?? 0) + 1;
console.log(`\nWOULD INSERT ${events.length} events`, counts);
for (const e of events.slice(-12)) console.log(JSON.stringify({ ...e, ts: e.ts.toISOString() }, replacer));

const expected = [lc(deployment.patientVault), lc(deployment.chaserVault)];
console.log("\nexpected vaults found:", expected.map((a) => `${a}=${known.has(a)}`).join(" "));
console.log("pool id:", computePoolId());

const snap = await takeSnapshots(client, [...known].map((address) => ({ address, pool_id: vaults.find((v) => v.address === address)!.pool_id })), BigInt(safe));
console.log("\nWOULD INSERT snapshots:");
for (const s of snap.snaps) console.log(JSON.stringify({ ...s, ts: s.ts.toISOString() }, replacer));
console.log("WOULD INSERT pool_tick:", JSON.stringify(snap.poolTick && { ...snap.poolTick, ts: snap.poolTick.ts.toISOString() }));
