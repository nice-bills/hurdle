// dApp smoke via Chrome DevTools Protocol (no npm deps; node >= 22 and a chromium binary).
// usage: node e2e_app_smoke.mjs <chromium-bin> <app-base-url> [deployment.json]
// Loads /, /vaults, /vaults/<each vault>, /integrate at 1280 and 390 px; fails on console errors, uncaught
// exceptions, failed first-party requests, an error banner / empty page, or horizontal overflow.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [bin, base0, depFile = 'app/shared/deployment-1301.json'] = process.argv.slice(2);
const base = base0.replace(/\/$/, '');
const dep = JSON.parse(readFileSync(depFile, 'utf8'));
const vaults = new Set([dep.patientVault, dep.chaserVault, dep.recklessVault].filter(Boolean));
try { // every factory vault the app knows about, not only the two deployed ones
  const ov = await (await fetch(`${base}/api/overview`, { signal: AbortSignal.timeout(30000) })).json();
  for (const v of [...(ov.vaults ?? []), ...(ov.legacyVaults ?? [])]) vaults.add(v.address);
} catch (e) { console.log('note: could not read /api/overview, using deployment vaults only:', e.message); }
const seen = new Set(); // addresses are case-insensitive: dedupe
const paths = ['/', '/vaults', ...[...vaults].filter((a) => !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase())).map((a) => `/vaults/${a}`), '/integrate'];

const dir = mkdtempSync(join(tmpdir(), 'e2e-app-chrome-'));
const proc = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0',
  `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { proc.kill('SIGKILL'); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port;
for (let i = 0; i < 100 && !port; i++) {
  const f = join(dir, 'DevToolsActivePort');
  if (existsSync(f)) port = readFileSync(f, 'utf8').split('\n')[0];
  else await sleep(100);
}
if (!port) { console.error('chromium did not start'); process.exit(2); }
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map(); const listeners = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  else listeners.forEach((l) => l(m));
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId }));
});
// third-party wallet infrastructure noise is not the app's fault
const ignorable = (t) => /walletconnect|reown|web3modal|pulse\.|cca-lite|coinbase/i.test(t);

let failures = 0;
async function check(path, width) {
  const url = base + path;
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const errs = [];
  const l = (m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') errs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const t = m.params.args.map((a) => a.value ?? a.description).join(' ');
      if (!ignorable(t)) errs.push('console.error: ' + t.slice(0, 300));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      const t = m.params.entry.text + ' ' + (m.params.entry.url || '');
      if (!ignorable(t)) errs.push('log: ' + t.slice(0, 300));
    }
  };
  listeners.push(l);
  await send('Runtime.enable', {}, sessionId); await send('Log.enable', {}, sessionId); await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 844 : 800, deviceScaleFactor: 1, mobile: width < 600 }, sessionId);
  await send('Page.navigate', { url }, sessionId);
  await sleep(8000); // load + client data fetch (/api/*) + chart render
  const { result } = await send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
    const de = document.documentElement;
    return { sw: Math.max(de.scrollWidth, document.body.scrollWidth), iw: window.innerWidth,
      h1: (document.querySelector('h1')||{}).textContent || '', text: document.body.innerText.length,
      bad: /Could not load|Application error|something went wrong|chain read failed/i.test(document.body.innerText),
      skeleton: document.querySelectorAll('.skeleton, [aria-busy="true"]').length };
  })()` }, sessionId);
  const v = result.value;
  const problems = [...errs];
  if (!v.h1) problems.push('no <h1> rendered');
  if (v.text < 200) problems.push(`page nearly empty (${v.text} chars)`);
  if (v.bad) problems.push('error text on page');
  if (v.skeleton) problems.push(`still loading after 8 s (${v.skeleton} skeleton elements)`);
  if (v.sw > v.iw + 1) problems.push(`horizontal overflow at ${width}px: scrollWidth ${v.sw} > ${v.iw}`);
  const ok = problems.length === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${path} @${width}px (h1 "${v.h1.slice(0, 40)}", scrollWidth ${v.sw})`);
  problems.forEach((p) => console.log('   - ' + p));
  if (!ok) failures++;
  listeners.splice(listeners.indexOf(l), 1);
  await send('Target.closeTarget', { targetId });
}
for (const p of paths) for (const w of [1280, 390]) await check(p, w);
ws.close(); cleanup();
console.log(failures ? `${failures} failing page views` : `all ${paths.length * 2} page views clean`);
process.exit(failures ? 1 : 0);
