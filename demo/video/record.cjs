const {chromium}=require('/home/bills/.dev-browser/node_modules/playwright-core');
const fs=require('fs');const OUT='/home/bills/code/hurdle/demo/video/';
const B='https://hurdle-app.onrender.com';
const sleep=ms=>new Promise(r=>setTimeout(r,Math.round(ms*0.62)));
(async()=>{
const b=await chromium.launch({executablePath:'/home/bills/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome'});
const ctx=await b.newContext({viewport:{width:1280,height:720}});
const p=await ctx.newPage();const errs=[];
fs.rmSync('frames',{recursive:true,force:true});fs.mkdirSync('frames');const fl=[];
const cdp=await ctx.newCDPSession(p);
cdp.on('Page.screencastFrame',async f=>{const t=f.metadata.timestamp;const n='frames/'+String(fl.length).padStart(6,'0')+'.jpg';fs.writeFileSync(n,Buffer.from(f.data,'base64'));fl.push([n,t]);cdp.send('Page.screencastFrameAck',{sessionId:f.sessionId}).catch(()=>{})});
await cdp.send('Page.startScreencast',{format:'jpeg',quality:85,maxWidth:1280,maxHeight:720,everyNthFrame:1});
p.on('pageerror',e=>errs.push(e.message));
const cap=async t=>p.evaluate(t=>{let e=document.getElementById('__cap');if(!e){e=document.createElement('div');e.id='__cap';e.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:18px 40px;background:rgba(20,16,12,.92);color:#fff;font:600 24px/1.3 system-ui,sans-serif;text-align:center;border-top:4px solid #ff9f0a';document.body.appendChild(e)}e.textContent=t},t);
const go=async(u,wait)=>{await p.goto(B+u,{waitUntil:'networkidle',timeout:90000});await p.waitForTimeout(1200);
 const spin=await p.evaluate(()=>/loading|error|failed/i.test(document.body.innerText));if(spin)console.log('WARN text on',u);};
const scroll=async y=>p.evaluate(y=>window.scrollTo({top:y,behavior:'smooth'}),y);
const shot=n=>p.screenshot({path:OUT+n});
// 1
await go('/',4000);await cap('Curators run your liquidity. But can you tell if they beat a passive LP?');await sleep(5000);
// 2
await cap('Hurdle sets par: what a passive full-range LP earned. The pool computes it. No oracle.');await scroll(120);await sleep(4000);
const pl=p.getByText('Play',{exact:true}).first();if(await pl.count())await pl.click().catch(()=>{});await sleep(5000);
await shot('frame-1-landing-par.png');
// 3
await go('/replay',3500);await cap('Beat par: the curator earns carry. Miss par: the bond pays you the shortfall.');await scroll(200);await sleep(8000);
// 4
await go('/vaults',4000);await cap('Live on Unichain Sepolia. Patient and Chaser are healthy, bonds refilled, deposits open each epoch.');await sleep(5000);
await shot('frame-2-vaults-live.png');await sleep(4000);
// 5
await go('/vaults/0x711fAb3A68aEAFbFE6Df493e676070D550ac5EEC',4500);await cap('Reckless was built to fail. Fired on-chain 2026-11-22 16:39 UTC. The vault now parks full range.');await sleep(5000);
await shot('frame-3-reckless-fired.png');await scroll(350);await sleep(4500);
// 6
await go('/vaults',3500);await cap('Earlier v3 Patient was also fired on-chain, 2026-11-22 11:02 UTC.');await scroll(500);await sleep(8500);
// 7
await go('/replay',3500);await cap('Real swaps, real weeks. Depositors were never below par at any of 166 settlements.');
const wk=p.getByText('ETH −14% week').first();if(await wk.count())await wk.click().catch(()=>{});await sleep(3000);await scroll(250);await sleep(6000);
// 8
await go('/vaults/0x5126c9Ebf2cF62e9f121F55886c57075a190b22d',4500);await cap('Deposit in kind in the first 5 minutes of each epoch. Your shares are covered by the bond.');await scroll(380);await sleep(7000);
// 9
await go('/integrate',3500);await cap('Builders: one factory, one hook, a few calls. Read the docs.');await sleep(3000);await scroll(600);await sleep(5000);
console.log('errs',errs);
await cdp.send('Page.stopScreencast');await ctx.close();await b.close();
let L='';for(let i=0;i<fl.length;i++){const d=i<fl.length-1?fl[i+1][1]-fl[i][1]:0.5;L+="file '"+fl[i][0]+"'\nduration "+d.toFixed(4)+"\n"}
L+="file '"+fl[fl.length-1][0]+"'\n";fs.writeFileSync('list.txt',L);console.log('frames',fl.length);
})();
