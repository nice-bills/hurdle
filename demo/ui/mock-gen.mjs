// Regenerates ../out/mock-*.json (schema: research/replay-schema.md). Run: node mock-gen.mjs
import { writeFileSync } from 'node:fs';
const T0 = Date.parse('2026-11-07T00:00:00Z') / 1000, H = 168, BOND0 = 0.05, MINBOND = 0.02, CARRY = 0.2;
const r6 = x => Math.round(x * 1e6) / 1e6;
const rng = s => () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;

function build(scenario, pool, seed, priceAt, feeRate, gaps) {
  const rnd = rng(seed), points = [], events = [];
  const st = Object.fromEntries(Object.keys(gaps).map(k => [k, { gap: 0, fired: false, center: priceAt(0), shortfall: 0 }]));
  let fees = 0, ex = 0;
  for (let h = 0; h <= H; h++) {
    const t = T0 + h * 3600, price = priceAt(h) + (rnd() - .5) * 6;
    fees += feeRate * (0.6 + 0.8 * rnd());
    const par = 1 + fees - (1 - 2 * Math.sqrt(price / priceAt(0)) / (1 + price / priceAt(0)));
    const vaults = {};
    for (const [k, g] of Object.entries(gaps)) {
      const s = st[k];
      if (g.kind === 'beat') {              // outperforms par, keeps (1-carry) of excess
        ex += h ? g.rate * (0.5 + rnd()) : 0;
        const carry = CARRY * ex;
        vaults[k] = { nav: par + ex, depositor: par + (1 - CARRY) * ex, bond: BOND0 + carry, carry, shortfall: 0, fired: false };
      } else {                              // trails par; bond pays gap; fired when bond < minBond * NAV
        if (!s.fired && h) s.gap += g.rate * (0.6 + 0.8 * rnd());
        s.shortfall = s.gap;
        const nav = par - s.gap, bond = BOND0 - s.gap;
        if (!s.fired && g.fire && bond < MINBOND * nav) {
          s.fired = true;
          events.push({ t, vault: k, type: 'fired', note: 'bond below 2% of NAV' });
        }
        if (!s.fired && Math.abs(price - s.center) / s.center > 0.006) {
          s.center = price; events.push({ t, vault: k, type: 'rebalance', note: 're-centered on price move' });
        }
        vaults[k] = { nav, depositor: par, bond, carry: 0, shortfall: s.gap, fired: s.fired };
      }
    }
    if (h && h % 24 === 0) for (const k of Object.keys(gaps)) events.push({ t, vault: k, type: 'settle', note: 'epoch settle' });
    points.push({ t, price: Math.round(price * 100) / 100, par: r6(par),
      vaults: Object.fromEntries(Object.entries(vaults).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([f, x]) => [f, typeof x === 'number' ? r6(x) : x]))])) });
  }
  events.sort((a, b) => a.t - b.t);
  return { meta: { scenario, pool, start: '2026-11-07T00:00:00Z', end: '2026-11-13T23:59:59Z', epochSeconds: 86400,
    carryBps: CARRY * 1e4, minBondBps: MINBOND * 1e4, unit: 'WETH (token1)', mock: true }, points, events };
}

const range = build('mock-range-week', 'ETH/USDC 0.05% (MOCK data)', 7,
  h => 3150 + 85 * Math.sin(h / 36 * 2 * Math.PI) + 40 * Math.sin(h / 7), 0.00007,
  { patient: { kind: 'beat', rate: 0.00006 }, chaser: { kind: 'trail', rate: 0.00042, fire: true } });
const down = build('mock-down-week', 'ETH/USDC 0.05% (MOCK data)', 11,
  h => 3150 - 370 * h / H + 35 * Math.sin(h / 9), 0.00006,
  { patient: { kind: 'trail', rate: 0.000083 }, chaser: { kind: 'trail', rate: 0.000155 } });

const fired = range.events.find(e => e.type === 'fired');
const day = fired && (fired.t - T0) / 86400;
if (!fired || day < 2.5 || day > 3.5) throw new Error('chaser must fire on day 3, got ' + day);
writeFileSync('../out/mock-range-week.json', JSON.stringify(range));
writeFileSync('../out/mock-down-week.json', JSON.stringify(down));
console.log('fired at day', day.toFixed(2));
