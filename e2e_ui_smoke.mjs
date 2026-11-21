// UI smoke via Chrome DevTools Protocol (no npm deps; needs node >= 22 and a chromium binary).
// usage: node e2e_ui_smoke.mjs <chromium-bin> <base-url>
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [bin, base] = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), 'e2e-chrome-'));
const proc = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0',
  `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { proc.kill('SIGKILL'); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

const sleep = ms => new Promise(r => setTimeout(r, ms));
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
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  else listeners.forEach(l => l(m));
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId }));
});

let failures = 0;
async function check(scenario, width) {
  const url = `${base}/?s=${scenario}#play`;
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const errs = [];
  const l = m => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') errs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push('console.error: ' + m.params.args.map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errs.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
  };
  listeners.push(l);
  await send('Runtime.enable', {}, sessionId); await send('Log.enable', {}, sessionId); await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 844 : 800, deviceScaleFactor: 1, mobile: width < 600 }, sessionId);
  await send('Page.navigate', { url }, sessionId);
  await sleep(4000); // load + a few seconds of playback
  const { result } = await send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
    const de = document.documentElement;
    return { sw: Math.max(de.scrollWidth, document.body.scrollWidth), iw: window.innerWidth,
      msg: (document.querySelector('#msg')||{}).textContent || '',
      cards: document.querySelectorAll('#cards > *').length,
      mainKids: document.querySelector('#svgMain') ? document.querySelector('#svgMain').childElementCount : 0 };
  })()` }, sessionId);
  const v = result.value;
  const problems = [...errs];
  if (v.msg) problems.push('UI error banner: ' + v.msg);
  if (!v.cards || !v.mainKids) problems.push(`nothing rendered (cards=${v.cards}, chart children=${v.mainKids})`);
  if (width <= 400 && v.sw > v.iw) problems.push(`horizontal overflow at ${width}px: scrollWidth ${v.sw} > ${v.iw}`);
  const ok = problems.length === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${scenario} @${width}px (scrollWidth ${v.sw}, cards ${v.cards})`);
  problems.forEach(p => console.log('   - ' + p));
  if (!ok) failures++;
  listeners.splice(listeners.indexOf(l), 1);
  await send('Target.closeTarget', { targetId });
}
for (const s of ['range-week', 'down-week']) for (const w of [1280, 390]) await check(s, w);
ws.close(); cleanup();
process.exit(failures ? 1 : 0);
