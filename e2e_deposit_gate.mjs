// Unit-level check of the dApp's deposit gate (app/web/src/lib/deposit-rules.ts), run under node (>= 22.6, strips types).
// Pins the v5 contract rules: fired+parked vaults are open inside the window whatever the deficit; fired+unparked
// are blocked (NotParked); non-fired vaults gate on deficit vs DEPOSITOR shares only.
import { depositBlockers, deficitOutstanding } from './app/web/src/lib/deposit-rules.ts';

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) fails++;
};
const W = 300, T = 1_000_000;
const base = { epochStart: T, epochSeconds: 3600, totalSupply: '1000000', bondShares: '0', curatorShares: '0',
  deficit: '0', nav: '1000000', fired: false, parked: false, status: 'ACTIVE' };
const inWin = T + 60, afterWin = T + 1000;

// Reckless v5 live state: fired, parked, deficit 15% of NAV, inside the window -> open
eq('fired+parked+deficit, in window -> open', depositBlockers({ ...base, fired: true, parked: true, deficit: '150000', status: 'FIRED' }, inWin, W), []);
eq('fired+parked, after window -> window only', depositBlockers({ ...base, fired: true, parked: true, deficit: '150000', status: 'FIRED' }, afterWin, W), ['window']);
eq('fired+parked, overdue epoch -> open (deposit settles first)', depositBlockers({ ...base, fired: true, parked: true }, T + 4000, W), []);
eq('fired+unparked -> NotParked', depositBlockers({ ...base, fired: true, parked: false, status: 'FIRED' }, inWin, W), ['notParked']);
eq('empty vault -> empty', depositBlockers({ ...base, totalSupply: '0' }, inWin, W), ['empty']);
eq('non-fired, no deficit -> open', depositBlockers(base, inWin, W), []);
eq('non-fired, deficit > 1bp -> deficit', depositBlockers({ ...base, deficit: '101' }, inWin, W), ['deficit']);
eq('non-fired, deficit == 1bp -> open (strict >)', deficitOutstanding({ ...base, deficit: '100' }), false);
// depositor shares only: 50% of supply is bond shares, so the same deficit weighs 2x
eq('bond shares excluded: 60 owed on half the shares -> blocked', deficitOutstanding({ ...base, bondShares: '500000', deficit: '60' }), true);
eq('bond shares excluded: 40 -> open', deficitOutstanding({ ...base, bondShares: '500000', deficit: '40' }), false);
eq('curator free shares excluded too', deficitOutstanding({ ...base, curatorShares: '500000', deficit: '60' }), true);
eq('non-fired, frozen + window closed', depositBlockers({ ...base, status: 'FROZEN' }, afterWin, W), ['window', 'frozen']);
if (fails) { console.error(`${fails} deposit-gate check(s) failed`); process.exit(1); }
console.log('deposit gate: all checks pass');
