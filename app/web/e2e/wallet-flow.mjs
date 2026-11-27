// Live wallet flow against the deployed dApp with a throwaway key (spends testnet gas; needs the deposit window).
// usage: UITEST_KEY_FILE=~/.config/hurdle/uitest.key node app/web/e2e/wallet-flow.mjs
// env: HURDLE_URL (default https://hurdle-app.onrender.com), CHROME (default /usr/bin/chromium), SHOTS (screenshot dir)
import { readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../package.json'));
const { chromium } = require('playwright-core');
const { createPublicClient, createWalletClient, http, defineChain } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');

const BASE = (process.env.HURDLE_URL || 'https://hurdle-app.onrender.com').replace(/\/$/, '');
const keyFile = (process.env.UITEST_KEY_FILE || '~/.config/hurdle/uitest.key').replace(/^~/, homedir());
const SHOTS = process.env.SHOTS || join(here, '../../../design/mockups/v2/build');
const dep = JSON.parse(readFileSync(join(here, '../../shared/deployment-1301.json'), 'utf8'));
const PATIENT = dep.patientVault;
const RPC = dep.rpc || 'https://sepolia.unichain.org';
mkdirSync(SHOTS, { recursive: true });

const chain = defineChain({ id: 1301, name: 'Unichain Sepolia', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const account = privateKeyToAccount(readFileSync(keyFile, 'utf8').trim());
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

async function handle(method, params = []) {
  switch (method) {
    case 'eth_requestAccounts': case 'eth_accounts': return [account.address];
    case 'eth_chainId': return '0x515';
    case 'net_version': return '1301';
    case 'wallet_switchEthereumChain': case 'wallet_addEthereumChain': return null;
    case 'personal_sign': return account.signMessage({ message: { raw: params[0] } });
    case 'eth_sign': return account.signMessage({ message: { raw: params[1] } });
    case 'eth_sendTransaction': {
      const t = params[0];
      return wallet.sendTransaction({
        to: t.to, data: t.data, value: t.value ? BigInt(t.value) : undefined,
        gas: t.gas ? BigInt(t.gas) : undefined,
      });
    }
    default: return pub.request({ method, params });
  }
}

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.setDefaultTimeout(60000);
await page.exposeFunction('__wallet', async (method, params) => {
  try { return { ok: true, result: await handle(method, params) }; }
  catch (e) { return { ok: false, code: e.code ?? -32000, message: e.shortMessage || e.message }; }
});
await page.addInitScript((addr) => {
  const listeners = {};
  const provider = {
    isMetaMask: true,
    request: async ({ method, params }) => {
      const r = await window.__wallet(method, params ?? []);
      if (!r.ok) throw Object.assign(new Error(r.message), { code: r.code });
      return r.result;
    },
    on(ev, fn) { (listeners[ev] ||= []).push(fn); return provider; },
    removeListener(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); return provider; },
  };
  window.ethereum = provider;
  const info = { uuid: '6f1c8c1e-0000-4000-8000-000000000001', name: 'Test Wallet', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiLz4=', rdns: 'test.uitest' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
}, account.address);

const log = [];
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/walletconnect|reown|web3modal|pulse|coinbase|cca-lite/i.test(m.text())) errs.push('console: ' + m.text().slice(0, 200)); });
let n = 0;
const shot = async (name) => { n++; const f = join(SHOTS, `walletflow-${n}.png`); await page.screenshot({ path: f, fullPage: true }); console.log(`  shot ${n}: ${name} -> ${f}`); };

/** click a button and wait for the TxStatus line to say Confirmed (or fail); returns the tx hash from the explorer link. */
async function act(label, locator) {
  await locator.click();
  const status = page.locator('[role=status]').filter({ hasText: /Confirmed|Reverted|Failed|rejected|could|not|error/i }).first();
  const t0 = Date.now();
  let txt = '';
  while (Date.now() - t0 < 120000) {
    const all = await page.locator('[role=status]').allInnerTexts();
    txt = all.join(' | ');
    if (/Confirmed|Reverted|Failed/i.test(txt) || (all.length && !/Checking|Confirm in|Pending/.test(txt))) { if (all.length) break; }
    await page.waitForTimeout(700);
  }
  const hrefs = await page.locator('[role=status] a[href*="/tx/"]').evaluateAll((as) => as.map((a) => a.href));
  const hash = (hrefs.at(-1) || '').split('/tx/')[1] || '-';
  const ok = /Confirmed/.test(txt);
  await shot(label);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} tx=${hash}${ok ? '' : '  status: ' + txt.replace(/\s+/g, ' ').slice(0, 300)}`);
  log.push({ label, ok, hash, txt: ok ? '' : txt });
  return ok;
}
const bodyText = () => page.locator('body').innerText();

// 1. connect
console.log('wallet', account.address, 'ETH', (Number(await pub.getBalance({ address: account.address })) / 1e18).toFixed(5));
await page.goto(`${BASE}/vaults/${PATIENT}`, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: /^Connect/ }).first().click();
await page.waitForTimeout(800);
const opt = page.getByRole('button', { name: /Test Wallet|Browser Wallet|Injected/i }).first();
await shot('connect-modal');
await opt.click();
await page.waitForFunction((a) => document.body.innerText.includes(a.slice(0, 6)), account.address, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1500);
const connected = (await bodyText()).includes(account.address.slice(0, 6)) || (await bodyText()).includes(account.address.slice(2, 6));
console.log(`${connected ? 'PASS' : 'FAIL'} connect`);
await shot('connected');

// 2. faucet
await page.getByRole('button', { name: 'Mint 10,000 mUSDC' }).first().scrollIntoViewIfNeeded().catch(() => {});
await act('mint mUSDC', page.getByRole('button', { name: 'Mint 10,000 mUSDC' }).first());
await act('mint mWETH', page.getByRole('button', { name: 'Mint 5 mWETH' }).first());

// 3. swap 100 mUSDC
await page.goto(`${BASE}/swap`, { waitUntil: 'domcontentloaded' });
await page.locator('#sw-amt').fill('100');
await page.waitForTimeout(1500);
const approve = page.getByRole('button', { name: /Approve mUSDC for the swap router/ });
if (await approve.isVisible().catch(() => false)) await act('swap approve mUSDC', approve);
await act('swap 100 mUSDC', page.getByRole('button', { name: /^Sell mUSDC for/ }));

// 4. deposit when window opens
await page.goto(`${BASE}/vaults/${PATIENT}`, { waitUntil: 'domcontentloaded' });
console.log('waiting for deposit window...', new Date().toISOString());
for (let i = 0; i < 400; i++) { // up to ~70 min
  if (/Deposit window open/.test(await bodyText())) break;
  if (i % 20 === 19) await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(10000);
}
console.log('window text:', /Deposit window open/.test(await bodyText()) ? 'open' : 'NOT open', new Date().toISOString());
await page.locator('button', { hasText: /^use / }).first().click();
await page.waitForTimeout(1500);
await shot('deposit-form');
for (const name of [/Approve mUSDC/, /Approve mWETH/]) {
  const b = page.getByRole('button', { name }).first();
  if (await b.isVisible().catch(() => false)) await act(`deposit ${name.source}`, b);
}
const dep0 = await act('deposit 100 shares', page.getByRole('button', { name: /^Deposit$/ }).last());

// 5. withdraw
await page.getByRole('tab', { name: 'Withdraw' }).or(page.getByRole('button', { name: 'Withdraw', exact: true })).first().click();
await page.waitForTimeout(1000);
await page.locator('button', { hasText: /^max$/ }).first().click();
await page.waitForTimeout(1500);
await shot('withdraw-form');
await act('withdraw all shares', page.getByRole('button', { name: /^Withdraw$/ }).last());

console.log('\nsummary:'); for (const l of log) console.log(` ${l.ok ? 'PASS' : 'FAIL'} ${l.label} ${l.hash}`);
if (errs.length) console.log('page errors:\n ' + [...new Set(errs)].slice(0, 10).join('\n '));
await browser.close();
process.exit(log.every((l) => l.ok) ? 0 : 1);
