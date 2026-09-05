// Pixel-compare the land layer and the minimap before and after the run-coalescing change, by
// lifting the ACTUAL draw statements out of each version of game/race.js rather than restating
// them, so this measures the shipped code and not a paraphrase of it.
//
// Measured 2026-09-05 against buzz/main c8b0b50. It is NOT pixel-identical and was never going
// to be: the cell gutter moved from the rect path into the pattern tile, so it antialiases
// differently. At zoom 1.0, 11% of pixels differ by a mean of 1.8/255 — invisible. At zoom 0.9
// (the default for a 1440x900 window) 17% differ by a mean of 18/255, which is a slightly softer
// gutter edge, confirmed by eye at 3x. The minimap is a visible improvement: abutting rects at
// fractional coordinates used to leave antialiased seams across the territory, and one rect per
// run does not.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASE = process.env.BASE_REF || 'buzz/main';
// Requires a browser: `npm i -D playwright && npx playwright install chromium`.
const loadChromium = async () => {
  try { return (await import('playwright')).chromium; }
  catch { console.error('this script needs playwright: npm i -D playwright && npx playwright install chromium'); process.exit(1); }
};

const NEW = readFileSync(ROOT + 'game/race.js', 'utf8');
const OLD = execFileSync('git', ['show', `${BASE}:game/race.js`], { cwd: ROOT, encoding: 'utf8' });

// slice draw() between two markers that exist verbatim in both versions
const between = (src, startsWith, endsWith) => {
  const lines = src.split('\n');
  const a = lines.findIndex(l => l.startsWith(startsWith));
  const b = lines.findIndex((l, i) => i > a && l.startsWith(endsWith));
  if (a < 0 || b < 0) throw new Error(`markers not found: ${startsWith} .. ${endsWith}`);
  return lines.slice(a, b).join('\n');
};
const fn = (src, name) => {
  const m = src.match(new RegExp(`function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`${name} not found`);
  return m[0];
};

const versions = {
  old: {
    land: between(OLD, '  // land:', '  const hue = chain.seed'),
    mini: between(OLD, '  const sx = mw / COLS', "  for (const p of players.values()){ if (!p.alive) continue; cx.fillStyle = '#fff'"),
    helpers: fn(OLD, 'landFill'),
  },
  neu: {
    land: between(NEW, '  // land:', '  const hue = chain.seed'),
    mini: between(NEW, '  const sx = mw / COLS', "  for (const p of players.values()){ if (!p.alive) continue; cx.fillStyle = '#fff'"),
    helpers: fn(NEW, 'landFill') + '\n' + fn(NEW, 'ownerRuns'),
  },
};
for (const [k, v] of Object.entries(versions)) console.log(`${k}: land ${v.land.split('\n').length} lines, mini ${v.mini.split('\n').length} lines`);

const browser = await (await loadChromium()).launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();

for (const [VW, VH] of [[1600, 1100], [1440, 900]]) {
await page.setContent(`<canvas id="a" width="${VW}" height="${VH}"></canvas><canvas id="b" width="${VW}" height="${VH}"></canvas>`);

const result = await page.evaluate(({ versions, VW, VH }) => {
  const COLS = 140, ROWS = 90, CELL = 22, W = COLS * CELL, H = ROWS * CELL, N = COLS * ROWS;
  const idx = (x, y) => y * COLS + x;
  const PATTERNS = ['solid', 'stripes', 'dots', 'checker', 'grid'];
  const colorOf = (p, a) => `hsla(${p.hue},95%,60%,${a})`;
  const vw = VW, vh = VH, dpr = 1, small = false;
  const zoom = Math.max(.55, Math.min(vw / 1500, vh / 1000, 1));

  // a busy board: 4 riders, ragged edges, holes, a slot that touches every boundary
  const owner = new Uint8Array(N);
  let s = 99; const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++){
    const band = Math.floor(x / 35) + 1;
    if (rnd() < .82) owner[idx(x, y)] = band;
  }
  for (let y = 20; y < 40; y++) for (let x = 50; x < 90; x++) owner[idx(x, y)] = 0;   // a hole
  for (let y = 0; y < ROWS; y++){ owner[idx(0, y)] = 2; owner[idx(COLS - 1, y)] = 3; } // both edges owned
  const players = [1,2,3,4].map((slot, i) => ({ slot, hue: i * 83, pat: i % PATTERNS.length, alive: i !== 3, x: 20 + i * 30, y: 40 }));
  const bySlot = new Map(players.map(p => [p.slot, p]));

  const run = (canvasId, v) => {
    const cv = document.getElementById(canvasId), cx = cv.getContext('2d');
    const cam = { x: W / 2, y: H / 2 };
    cx.setTransform(dpr, 0, 0, dpr, 0, 0); cx.clearRect(0, 0, vw, vh);
    cx.fillStyle = '#0b0220'; cx.fillRect(0, 0, vw, vh);
    cx.translate(vw/2 - cam.x * zoom, vh/2 - cam.y * zoom); cx.scale(zoom, zoom);
    const x0 = Math.max(0, Math.floor((cam.x - vw/2/zoom) / CELL) - 1), x1 = Math.min(COLS, Math.ceil((cam.x + vw/2/zoom) / CELL) + 1);
    const y0 = Math.max(0, Math.floor((cam.y - vh/2/zoom) / CELL) - 1), y1 = Math.min(ROWS, Math.ceil((cam.y + vh/2/zoom) / CELL) + 1);
    const mw = small ? 110 : 170, mh = Math.round(mw * ROWS / COLS), mx = vw - mw - 10, my = vh - mh - (small ? 28 : 34);
    const body = `const patCache = new Map();\n${v.helpers}\n${v.land}\ncx.setTransform(dpr,0,0,dpr,0,0);\n${v.mini}`;
    new Function('cx','owner','idx','CELL','COLS','ROWS','PATTERNS','colorOf','bySlot','players','x0','y0','x1','y1','mw','mh','mx','my','dpr','document', body)
      (cx, owner, idx, CELL, COLS, ROWS, PATTERNS, colorOf, bySlot, players, x0, y0, x1, y1, mw, mh, mx, my, dpr, document);
    return cx.getImageData(0, 0, vw, vh).data;
  };

  const A = run('a', versions.old), B = run('b', versions.neu);
  let diff = 0, maxd = 0, sum = 0, lit = 0;
  const worst = [];
  for (let i = 0; i < A.length; i += 4){
    if (A[i] || A[i+1] || A[i+2]) lit++;
    let d = 0; for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(A[i+c] - B[i+c]));
    if (d){ diff++; sum += d; if (d > maxd){ maxd = d; } if (d > 8 && worst.length < 6) worst.push({ px: (i/4) % vw, py: Math.floor((i/4) / vw), d, a: [A[i],A[i+1],A[i+2]], b: [B[i],B[i+1],B[i+2]] }); }
  }
  return { total: A.length / 4, lit, diff, maxd, meanDiff: diff ? sum / diff : 0, worst };
}, { versions, VW, VH });

console.log(`\n=== viewport ${VW}x${VH}  (zoom ${Math.max(.55, Math.min(VW/1500, VH/1000, 1)).toFixed(3)})`);
console.log(`pixels: ${result.total}  differing: ${result.diff} (${(result.diff / result.total * 100).toFixed(3)}%)`);
console.log(`max channel delta: ${result.maxd}   mean delta over differing pixels: ${result.meanDiff.toFixed(2)}`);
await page.locator('#a').screenshot({ path: `${ROOT}.perf-old-${VW}.png` });
await page.locator('#b').screenshot({ path: `${ROOT}.perf-new-${VW}.png` });
}
await browser.close();
