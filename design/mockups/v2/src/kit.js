/* Shared mockup kit: formatting, charts, segmented controls. Data is window.HURDLE (inlined from the live API). */
(() => {
  const D = window.HURDLE;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const byLabel = Object.fromEntries(D.vaults.map(v => [v.label, v]));
  const pct = x => (x - 1) * 100;
  const pad2 = n => String(n).padStart(2, '0');
  const t = ts => { const d = new Date(ts * 1000); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; };
  const day = ts => new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const sign = n => (n > 0 ? '+' : n < 0 ? '−' : '');
  const money = (n, dp = 2) => Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

  // "5,842.67" -> <span>5,842</span><span class="dim">.67</span>
  function splitNum(n, dp = 2, prefix = '', suffix = '') {
    const s = money(n, dp); const i = s.indexOf('.');
    const whole = i < 0 ? s : s.slice(0, i), frac = i < 0 ? '' : s.slice(i);
    return `${prefix}${whole}<span class="dim">${frac}${suffix}</span>`;
  }

  // vault facts, all derived from the API numbers
  function facts(v) {
    const last = v.series[v.series.length - 1];
    const youVsPar = (v.cum.depositor - v.cum.par) * 100;
    const stratVsPar = (v.cum.strategy - v.cum.par) * 100;
    const hours = (v.series[v.series.length - 1].ts - v.series[0].ts) / 3600;
    return {
      you: pct(v.cum.depositor), par: pct(v.cum.par), strat: pct(v.cum.strategy),
      youVsPar, stratVsPar, hours: Math.round(hours), last,
      bondPct: v.bondBps / 100, floorPct: v.minBondBps / 100, fireAt: v.minBondBps / 200,
      paidTotal: v.settles.reduce((a, s) => a + s.paid, 0),
      carryTotal: v.settles.reduce((a, s) => a + s.carry, 0),
    };
  }

  /* ---------- line chart: you (depositor) vs par vs strategy ---------- */
  const NS = 'http://www.w3.org/2000/svg';
  const el = (n, a = {}) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };

  function lineChart(host, v, o = {}) {
    const W = host.clientWidth || 600, H = o.height || 220, R = o.axisRight ?? 44, T = 14, B = 26;
    const S = v.series, n = S.length;
    // relative: everything measured against par, so par is the flat target line at 0
    const val = (p, k) => o.relative ? (k === 'p' ? 0 : (p[k] - p.p) * 100) : pct(p[k]);
    const unit = o.relative ? '' : '%';
    const ys = S.flatMap(p => [val(p, 's'), val(p, 'p'), val(p, 'd')]);
    let lo = Math.min(...ys), hi = Math.max(...ys); const padY = (hi - lo) * 0.12 || 0.5; lo -= padY; hi += padY;
    const x = i => (i / (n - 1)) * (W - R);
    const y = val => T + (1 - (val - lo) / (hi - lo)) * (H - T - B);
    host.innerHTML = '';
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart', role: 'img',
      'aria-label': `${v.label}: you ${sign(pct(v.cum.depositor))}${Math.abs(pct(v.cum.depositor)).toFixed(2)}%, par ${pct(v.cum.par).toFixed(2)}%` });
    // grid: 3 lines, labels at right like the reference
    const step = niceStep((hi - lo) / 3);
    for (let g = Math.ceil(lo / step) * step; g <= hi; g += step) {
      svg.append(el('line', { x1: 0, x2: W - R + 6, y1: y(g), y2: y(g), class: 'grid' }));
      const tx = el('text', { x: W, y: y(g) + 4, class: 'axis', 'text-anchor': 'end' }); if (o.relative && Math.abs(g) < step / 2) continue; tx.textContent = `${g > 0 ? '+' : g < 0 ? '−' : ''}${Math.abs(g).toFixed(step < 1 ? (step < .1 ? 2 : 1) : 0)}${unit}`; svg.append(tx);
    }
    [0, Math.floor((n - 1) / 2), n - 1].forEach((i, k) => {
      const tx = el('text', { x: x(i), y: H - 6, class: 'axis', 'text-anchor': k === 0 ? 'start' : k === 2 ? 'end' : 'middle' }); tx.textContent = t(S[i].ts); svg.append(tx);
    });
    const path = key => S.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(val(p, key)).toFixed(1)}`).join('');
    if (o.strategy !== false) svg.append(el('path', { d: path('s'), class: 'ln-strat' }));
    svg.append(el('path', { d: path('p'), class: 'ln-par' }));
    const you = el('path', { d: path('d'), class: 'ln-you' }); svg.append(you);
    // misses as small marks on the par line
    S.forEach((p, i) => { if (p.miss) svg.append(el('circle', { cx: x(i), cy: y(val(p, 'p')), r: 3, class: 'miss-dot' })); });
    const end = S[n - 1];
    svg.append(el('circle', { cx: x(n - 1), cy: y(val(end, 'd')), r: 4.5, class: 'end-dot' }));
    // par end label like "$8k" target label in the reference
    const pl = el('text', { x: W, y: y(val(end, 'p')) + (val(end, 'p') >= val(end, 'd') ? 14 : -6), class: 'axis par-lbl', 'text-anchor': 'end' }); pl.textContent = 'par';
    if (o.parLabel !== false) svg.append(pl);
    // scrub
    const cur = el('line', { y1: T - 6, y2: H - B, class: 'scrub', opacity: 0 }); svg.append(cur);
    host.append(svg);
    if (!reduce) { const L = you.getTotalLength(); you.style.strokeDasharray = L; you.style.strokeDashoffset = L; requestAnimationFrame(() => { you.style.transition = 'stroke-dashoffset 900ms cubic-bezier(.22,1,.36,1)'; you.style.strokeDashoffset = 0; }); }
    const tip = tipFor(host);
    host.onpointermove = e => {
      const r = svg.getBoundingClientRect(); const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width * W) / (W - R) * (n - 1))));
      const p = S[i]; cur.setAttribute('x1', x(i)); cur.setAttribute('x2', x(i)); cur.setAttribute('opacity', 1);
      if (o.relative) tip.show(x(i) / W * r.width, `${day(p.ts)}, ${t(p.ts)} UTC`, `You ${fmtPts(val(p, 'd'))} vs par`, `Curator ${fmtPts(val(p, 's'))}${p.miss ? ' · bond paid' : ''}`);
      else tip.show(x(i) / W * r.width, `${day(p.ts)}, ${t(p.ts)} UTC`, `You ${fmtPct(pct(p.d))}`, `Par ${fmtPct(pct(p.p))} · curator ${fmtPct(pct(p.s))}${p.miss ? ' · bond paid' : ''}`);
    };
    host.onpointerleave = () => { cur.setAttribute('opacity', 0); tip.hide(); };
  }

  /* ---------- bar chart: each hourly settle, curator NAV minus par ---------- */
  function barChart(host, v, o = {}) {
    const W = host.clientWidth || 600, H = o.height || 200, R = o.axisRight ?? 44, T = 14, B = 26;
    const S = v.settles.slice().reverse(), n = S.length;
    const gaps = S.map(s => s.nav - s.par);
    const m = Math.max(...gaps.map(Math.abs), 1);
    const lo = Math.min(0, ...gaps) - m * 0.1, hi = Math.max(0, ...gaps) + m * 0.1;
    const y = val => T + (1 - (val - lo) / (hi - lo)) * (H - T - B);
    const bw = (W - R) / n, gap = Math.max(4, bw * 0.38);
    host.innerHTML = '';
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart', role: 'img', 'aria-label': `${v.label}: hourly gap to par` });
    svg.append(el('line', { x1: 0, x2: W - R + 6, y1: y(0), y2: y(0), class: 'grid zero' }));
    [hi * 0.9, lo * 0.9].forEach(g => { if (Math.abs(g) < m * 0.2) return; const tx = el('text', { x: W, y: y(g) + 4, class: 'axis', 'text-anchor': 'end' }); tx.textContent = `${g > 0 ? '+' : '−'}$${Math.abs(g).toFixed(0)}`; svg.append(tx); });
    const zl = el('text', { x: W, y: y(0) + 4, class: 'axis par-lbl', 'text-anchor': 'end' }); zl.textContent = 'par'; svg.append(zl);
    const bars = S.map((s, i) => {
      const g = gaps[i], h = Math.max(2, Math.abs(y(g) - y(0)));
      const r = el('rect', { x: i * bw + gap / 2, width: bw - gap, y: g >= 0 ? y(0) - h : y(0), height: h, rx: Math.min(4, (bw - gap) / 2), class: g < -0.005 ? 'bar miss' : 'bar' });
      if (!reduce) { r.style.transformOrigin = `0 ${y(0)}px`; r.style.transform = 'scaleY(0)'; r.style.transition = `transform 600ms cubic-bezier(.22,1,.36,1) ${i * 35}ms`; requestAnimationFrame(() => requestAnimationFrame(() => r.style.transform = 'scaleY(1)')); }
      svg.append(r); return r;
    });
    [0, n - 1].forEach((i, k) => { const tx = el('text', { x: k ? W - R : 0, y: H - 6, class: 'axis', 'text-anchor': k ? 'end' : 'start' }); tx.textContent = t(S[i].ts); svg.append(tx); });
    host.append(svg);
    const tip = tipFor(host);
    host.onpointermove = e => {
      const r = svg.getBoundingClientRect(); const i = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width * W) / bw)));
      bars.forEach((b, j) => b.classList.toggle('on', j === i));
      const s = S[i], g = gaps[i];
      tip.show(((i + 0.5) * bw) / W * r.width, `Settle ${day(s.ts)}, ${t(s.ts)}`, g >= -0.005 ? `${sign(g)}$${money(g)} vs par` : `Bond paid $${money(s.paid)}`, g >= -0.005 ? `Curator carry $${money(s.carry)}` : `Curator ${sign(g)}$${money(g)} under par`);
    };
    host.onpointerleave = () => { bars.forEach(b => b.classList.remove('on')); tip.hide(); };
  }

  /* ---------- dot columns (Saif's "payment rhythm") ---------- */
  function dotChart(host, v, o = {}) {
    // two-sided: beats rise above the par row, misses hang below it; each side scaled to its own largest hour
    const S = v.settles.slice().reverse(); const half = o.half || 4;
    const gaps = S.map(s => s.nav - s.par);
    const maxUp = Math.max(...gaps.filter(g => g > 0), 1e-9), maxDn = Math.max(...S.map(s => s.paid), 1e-9);
    host.innerHTML = ''; host.classList.add('dots');
    S.forEach((s, i) => {
      const g = gaps[i], miss = g < -0.005;
      const k = Math.max(1, Math.round(Math.sqrt(miss ? s.paid / maxDn : Math.max(g, 0) / maxUp) * half));
      const col = document.createElement('div'); col.className = 'dcol' + (miss ? ' neg' : '');
      col.style.gridTemplateRows = `repeat(${half * 2 + 1},1fr)`;
      col.title = `${t(s.ts)} UTC · ${miss ? `bond paid $${money(s.paid)}` : `${sign(g)}$${money(g)} vs par`}`;
      for (let j = 0; j < half * 2 + 1; j++) {
        const d = document.createElement('i');
        if (j === half) d.className = 'mid';
        else if (!miss && j < half && j >= half - k) d.className = 'on';
        else if (miss && j > half && j <= half + k) d.className = 'on';
        if (!reduce) d.style.transitionDelay = `${i * 40 + Math.abs(j - half) * 30}ms`;
        col.append(d);
      }
      host.append(col);
    });
    requestAnimationFrame(() => requestAnimationFrame(() => host.classList.add('in')));
  }

  function tipFor(host) {
    host.style.position = 'relative';
    let tip = host.querySelector('.tip'); if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; host.append(tip); }
    return {
      show(px, a, b, c) { tip.innerHTML = `<span>${a}</span><b>${b}</b><span>${c}</span>`; tip.style.left = Math.max(70, Math.min(host.clientWidth - 70, px)) + 'px'; tip.classList.add('on'); },
      hide() { tip.classList.remove('on'); },
    };
  }
  const niceStep = r => { const p = Math.pow(10, Math.floor(Math.log10(r))); const f = r / p; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p; };
  const fmtPct = n => `${sign(+n.toFixed(2))}${Math.abs(n).toFixed(2)}%`;
  const fmtPts = n => `${sign(+n.toFixed(2))}${Math.abs(n).toFixed(2)} pts`;

  /* ---------- segmented control with a sliding thumb ---------- */
  function segmented(root, onPick) {
    const btns = [...root.querySelectorAll('button')];
    let thumb = root.querySelector('.thumb'); if (!thumb) { thumb = document.createElement('span'); thumb.className = 'thumb'; root.prepend(thumb); }
    const place = b => { thumb.style.width = b.offsetWidth + 'px'; thumb.style.transform = `translateX(${b.offsetLeft}px)`; };
    const pick = (b, fire = true) => { btns.forEach(x => x.setAttribute('aria-pressed', x === b)); place(b); if (fire && onPick) onPick(b.dataset.v, b); };
    btns.forEach(b => b.addEventListener('click', () => pick(b)));
    const init = btns.find(b => b.getAttribute('aria-pressed') === 'true') || btns[0];
    requestAnimationFrame(() => { thumb.style.transition = 'none'; pick(init, false); requestAnimationFrame(() => thumb.style.transition = ''); });
    addEventListener('resize', () => place(btns.find(b => b.getAttribute('aria-pressed') === 'true')));
  }

  /* ---------- count-up for hero numbers ---------- */
  function rollIn(root = document) {
    root.querySelectorAll('[data-roll]').forEach(node => {
      const to = parseFloat(node.dataset.roll), dp = +(node.dataset.dp ?? 2), pre = node.dataset.pre || '', suf = node.dataset.suf || '';
      const render = val => node.innerHTML = splitNum(val, dp, pre, suf);
      if (reduce) return render(to);
      const t0 = performance.now(), dur = 900;
      const tick = now => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 4); render(to * e); if (k < 1) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
  }

  // deposit window: first 5 minutes of each hourly epoch, clock starts at fetch time
  function epochClock(v, cb) {
    const startWall = Date.now();
    const tick = () => {
      const now = D.fetchedAt + Math.floor((Date.now() - startWall) / 1000);
      const into = (now - v.epochStart) % v.epochSeconds; const open = into < 300;
      const left = open ? 300 - into : v.epochSeconds - into;
      cb({ open, left, label: `${pad2(Math.floor(left / 60))}:${pad2(left % 60)}`, nextSettle: v.epochSeconds - into });
    };
    tick(); return setInterval(tick, 1000);
  }

  function redrawOnResize(fn) { let w = innerWidth; addEventListener('resize', () => { if (innerWidth !== w) { w = innerWidth; fn(); } }); }

  window.HK = { D, byLabel, facts, splitNum, money, sign, fmtPct, fmtPts, t, day, lineChart, barChart, dotChart, segmented, rollIn, epochClock, redrawOnResize, reduce,
    short: a => a.slice(0, 6) + '…' + a.slice(-4) };
})();
