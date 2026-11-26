// Headless smoke + screenshots: node scripts/shots.mjs <baseUrl> <outDir> [pages...]
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
const base = process.argv[2] ?? "http://localhost:3000";
const out = process.argv[3] ?? "./shots";
const only = process.argv.slice(4);
mkdirSync(out, { recursive: true });
const PAGES = [
  ["home", "/"], ["vaults", "/vaults"],
  ["patient", "/vaults/0x22e97BDB1E4B29033b729B0B7B6D59B56C9d095B"],
  ["chaser", "/vaults/0xaCd6a6228D29a099BA269B2b3d39745b24C3fD24"],
  ["reckless", "/vaults/0x45ADcEcE45Cade3f8850019fAcf34ed99D0DF82D"],
  ["reckless-v4", "/vaults/0x711fAb3A68aEAFbFE6Df493e676070D550ac5EEC"],
  ["create", "/create"], ["swap", "/swap"], ["replay", "/replay"], ["integrate", "/integrate"],
].filter(([n]) => !only.length || only.includes(n));
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
let failures = 0;
for (const [name, path] of PAGES) for (const w of [1280, 390]) for (const theme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: w === 390 ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: w === 390 ? 2 : 1 });
  await ctx.addInitScript((t) => { try { localStorage.setItem("hurdle-theme", t); } catch {} }, theme);
  const page = await ctx.newPage();
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 300)); });
  page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 300)));
  page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("walletconnect")) errs.push(`http ${r.status()} ${r.url()}`); });
  try {
    await page.goto(base + path, { waitUntil: "load", timeout: 45000 });
  } catch (e) { errs.push("goto: " + e.message.slice(0, 200)); }
  await page.waitForTimeout(6000);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) errs.push(`horizontal overflow ${overflow}px`);
  const file = `${out}/${name}-${w}-${theme}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(`${errs.length ? "FAIL" : "ok  "} ${name} ${w} ${theme}${errs.length ? "\n   " + errs.join("\n   ") : ""}`);
  if (errs.length) failures++;
  await ctx.close();
}
await browser.close();
console.log(failures ? `${failures} failing views` : "all views clean");
