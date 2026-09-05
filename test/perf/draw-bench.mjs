// Measure the two territory-proportional draw layers against run-coalesced versions in real
// Chromium. Unlike draw-pixels.mjs this one restates the layers rather than lifting them, so that
// both the before and after shapes can be timed side by side under identical state; keep it in
// step with draw() if that changes.
//
// Relative numbers only: a headless box usually rasterises in software, so absolute ms are not a
// phone. What transfers is the shape (cost grows with owned cells, from ~0 on an empty grid) and
// the mini_nostyle column, which isolates the per-cell fillStyle CSS-colour parse — main-thread
// work that a real GPU does not make go away.
// Requires a browser: `npm i -D playwright && npx playwright install chromium`.
const loadChromium = async () => {
  try { return (await import('playwright')).chromium; }
  catch { console.error('this script needs playwright: npm i -D playwright && npx playwright install chromium'); process.exit(1); }
};

const page = await (await (await loadChromium()).launch({ args: ['--no-sandbox'] })).newPage();
await page.setContent('<canvas id="c" width="1440" height="900"></canvas>');

const out = await page.evaluate(() => {
  const COLS = 140, ROWS = 90, CELL = 22, N = COLS * ROWS;
  const idx = (x, y) => y * COLS + x;
  const cv = document.getElementById('c'), cx = cv.getContext('2d');
  const vw = 1440, vh = 900;
  const zoom = Math.max(.55, Math.min(vw / 1500, vh / 1000, 1));

  const PATTERNS = ['solid', 'stripes', 'dots', 'checker', 'grid'];
  const patCache = new Map();
  // race.js:102
  function landFill(hue, pat, alpha = .45){
    const key = `${hue}|${pat}|${alpha}`; if (patCache.has(key)) return patCache.get(key);
    const c = document.createElement('canvas'); c.width = c.height = CELL; const x = c.getContext('2d');
    x.fillStyle = `hsla(${hue},95%,58%,${alpha})`; x.fillRect(0, 0, CELL, CELL);
    x.fillStyle = `hsla(${hue},100%,80%,${alpha * .9})`; x.strokeStyle = x.fillStyle; x.lineWidth = 2;
    const p = PATTERNS[pat] || 'solid';
    if (p === 'stripes'){ x.beginPath(); x.moveTo(0, CELL); x.lineTo(CELL, 0); x.stroke(); }
    else if (p === 'dots'){ x.beginPath(); x.arc(CELL/2, CELL/2, 3.5, 0, Math.PI*2); x.fill(); }
    const pat2 = cx.createPattern(c, 'repeat'); patCache.set(key, pat2); return pat2;
  }
  const colorOf = (p, a) => `hsla(${p.hue},95%,60%,${a})`;

  // 4 riders, territory dealt out in contiguous vertical bands so every ownership level is a
  // realistic filled region rather than noise.
  const players = [1,2,3,4].map((s, i) => ({ slot: s, hue: i * 80, pat: i % PATTERNS.length, alive: true }));
  const bySlot = new Map(players.map(p => [p.slot, p]));
  function fill(frac){
    const owner = new Uint8Array(N); const target = Math.round(N * frac);
    let placed = 0;
    outer: for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++){
      if (placed >= target) break outer;
      owner[idx(x, y)] = players[Math.floor(x / (COLS / 4))].slot; placed++;
    }
    return owner;
  }

  // camera parked mid-grid, same culling maths as race.js:488
  const cam = { x: COLS * CELL / 2, y: ROWS * CELL / 2 };
  const x0 = Math.max(0, Math.floor((cam.x - vw/2/zoom) / CELL) - 1), x1 = Math.min(COLS, Math.ceil((cam.x + vw/2/zoom) / CELL) + 1);
  const y0 = Math.max(0, Math.floor((cam.y - vh/2/zoom) / CELL) - 1), y1 = Math.min(ROWS, Math.ceil((cam.y + vh/2/zoom) / CELL) + 1);

  // ---- land layer, race.js:491-492 verbatim ----
  function landNow(owner){
    const runs = new Map();
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++){ const s = owner[idx(x, y)]; if (!s) continue; let arr = runs.get(s); if (!arr){ arr = []; runs.set(s, arr); } arr.push(x, y); }
    for (const [s, arr] of runs){ const p = bySlot.get(s); if (!p) continue; cx.fillStyle = landFill(p.hue, p.pat, p.alive ? .5 : .2); cx.beginPath(); for (let i = 0; i < arr.length; i += 2) cx.rect(arr[i] * CELL + .5, arr[i+1] * CELL + .5, CELL - 1, CELL - 1); cx.fill(); }
  }
  // ---- land layer, horizontal runs coalesced into one rect each ----
  function landFast(owner){
    const runs = new Map();
    for (let y = y0; y < y1; y++){
      let s = 0, x = x0;
      for (let cxi = x0; cxi <= x1; cxi++){
        const v = cxi < x1 ? owner[idx(cxi, y)] : 0;
        if (v !== s){ if (s){ let a = runs.get(s); if (!a){ a = []; runs.set(s, a); } a.push(x, y, cxi - x); } s = v; x = cxi; }
      }
    }
    for (const [s, arr] of runs){ const p = bySlot.get(s); if (!p) continue; cx.fillStyle = landFill(p.hue, p.pat, p.alive ? .5 : .2); cx.beginPath(); for (let i = 0; i < arr.length; i += 3) cx.rect(arr[i] * CELL + .5, arr[i+1] * CELL + .5, arr[i+2] * CELL - 1, CELL - 1); cx.fill(); }
  }
  // ---- minimap, race.js:507 verbatim ----
  const mw = 170, mh = Math.round(mw * ROWS / COLS), mx = vw - mw - 10, my = vh - mh - 34;
  const sx = mw / COLS, sy = mh / ROWS;
  function miniNow(owner){
    for (let y = 0; y < ROWS; y += 2) for (let x = 0; x < COLS; x += 2){ const s = owner[idx(x, y)]; if (!s) continue; const p = bySlot.get(s); if (!p) continue; cx.fillStyle = colorOf(p, .9); cx.fillRect(mx + x * sx, my + y * sy, sx * 2, sy * 2); }
  }
  // ---- minimap, one fillStyle per slot + runs coalesced ----
  function miniFast(owner){
    const runs = new Map();
    for (let y = 0; y < ROWS; y += 2){
      let s = 0, x = 0;
      for (let cxi = 0; cxi <= COLS; cxi += 2){
        const v = cxi < COLS ? owner[idx(cxi, y)] : 0;
        if (v !== s){ if (s){ let a = runs.get(s); if (!a){ a = []; runs.set(s, a); } a.push(x, y, cxi - x); } s = v; x = cxi; }
      }
    }
    for (const [s, arr] of runs){ const p = bySlot.get(s); if (!p) continue; cx.fillStyle = colorOf(p, .9); for (let i = 0; i < arr.length; i += 3) cx.fillRect(mx + arr[i] * sx, my + arr[i+1] * sy, arr[i+2] * sx, sy * 2); }
  }

  // Attribution probe: same per-cell fillRect count as miniNow, but fillStyle assigned once per
  // slot instead of once per cell. The gap between miniNow and this is pure CSS-colour parsing,
  // which is main-thread work and does not go away on a real GPU.
  function miniNoStyle(owner){
    const cells = new Map();
    for (let y = 0; y < ROWS; y += 2) for (let x = 0; x < COLS; x += 2){ const s = owner[idx(x, y)]; if (!s) continue; let a = cells.get(s); if (!a){ a = []; cells.set(s, a); } a.push(x, y); }
    for (const [s, arr] of cells){ const p = bySlot.get(s); if (!p) continue; cx.fillStyle = colorOf(p, .9); for (let i = 0; i < arr.length; i += 2) cx.fillRect(mx + arr[i] * sx, my + arr[i+1] * sy, sx * 2, sy * 2); }
  }

  // A single draw is below this box's timer floor and the GPU process drifts under load, so:
  // batch BATCH draws per timed sample (readback cost amortised), and round-robin the variants
  // across SAMPLES rounds so any drift hits every variant equally instead of whichever ran last.
  const flush = () => cx.getImageData(0, 0, 1, 1).data[0];
  const BATCH = 10, SAMPLES = 25;
  function benchAll(variants, owner){
    const names = Object.keys(variants);
    for (const n of names) for (let i = 0; i < 3; i++){ variants[n](owner); }   // warm
    flush();
    const t = Object.fromEntries(names.map(n => [n, []]));
    for (let s = 0; s < SAMPLES; s++) for (const n of names){
      const a = performance.now();
      for (let b = 0; b < BATCH; b++) variants[n](owner);
      flush();
      t[n].push((performance.now() - a) / BATCH);
    }
    const out = {};
    for (const n of names){ const v = t[n].sort((x, y) => x - y); out[n] = { med: v[v.length >> 1], p10: v[Math.floor(v.length * .1)], p90: v[Math.floor(v.length * .9)] }; }
    return out;
  }

  const rows = [];
  for (const frac of [0, .25, .5, .75, 1]){
    const owner = fill(frac);
    let visible = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (owner[idx(x, y)]) visible++;
    rows.push({ frac, visible, ...benchAll({ landNow, landFast, miniNow, miniNoStyle, miniFast }, owner) });
  }
  return { rows, viewportCells: (x1 - x0) * (y1 - y0) };
});

console.log('viewport cells in cull window:', out.viewportCells);
const f = v => `${v.med.toFixed(2)}`;
console.log('owned  visible   land_now  land_fast    mini_now  mini_nostyle  mini_fast   total_now  total_fast  speedup');
for (const r of out.rows){
  const tn = r.landNow.med + r.miniNow.med, tf = r.landFast.med + r.miniFast.med;
  console.log(
    (r.frac * 100).toFixed(0).padStart(4) + '%',
    String(r.visible).padStart(8),
    f(r.landNow).padStart(10), f(r.landFast).padStart(10),
    f(r.miniNow).padStart(12), f(r.miniNoStyle).padStart(13), f(r.miniFast).padStart(10),
    tn.toFixed(2).padStart(11), tf.toFixed(2).padStart(11),
    (tn / tf).toFixed(1).padStart(8) + 'x');
}
console.log('\nspread (p10..p90) at 100% owned:');
for (const k of ['landNow','landFast','miniNow','miniNoStyle','miniFast']){
  const v = out.rows[out.rows.length-1][k];
  console.log('  ' + k.padEnd(12), v.p10.toFixed(2) + ' .. ' + v.p90.toFixed(2));
}
process.exit(0);
