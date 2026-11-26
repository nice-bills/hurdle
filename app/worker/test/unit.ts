// Pure-logic checks (no RPC, no DB): re-centre planning, warning surface. Run: npm run test:unit
import assert from "node:assert/strict";
process.env.CURATOR_PRIVATE_KEY = "";
const { planRecenter, CURATOR_EXPECTED } = await import("../src/curator.js");
const { state } = await import("../src/state.js");

const MIN = -887270;
const MAX = 887270;
// in range and centred: nothing to do
assert.equal(planRecenter(-196810, -197010, -196610, 10, MIN, MAX), null);
// far out of range (the live Chaser case, -4.5% of NAV idle after step 1): new range centred on spot, same width
assert.deepEqual(planRecenter(-196811, -196450, -196050, 10, MIN, MAX), [-197020, -196620]);
// near an edge also re-centres
const near = planRecenter(-196630, -197010, -196610, 10, MIN, MAX);
assert.ok(near && near[1] - near[0] === 400);
// full range (parked / passive): never re-centred
assert.equal(planRecenter(5, MIN, MAX, 10, MIN, MAX), null);
// a no-op range returns null
assert.equal(planRecenter(-196810, -197010, -196610, 10, MIN, MAX), null);
// RebalanceIncomplete is still an expected revert (skipped, not failed) but is now surfaced as a warning by the curator
assert.ok(CURATOR_EXPECTED.has("RebalanceIncomplete"));
assert.equal(state.curatorWarnings.size, 0);
console.log("unit: ok");
process.exit(0);
