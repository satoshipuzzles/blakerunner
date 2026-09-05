// Does a bigger territory make you capture MORE OFTEN? Every capture is an O(grid) flood fill
// plus a forced signed `land` publish (race.js:219 -> sendLand(true), which skips the KEY_MS
// throttle), so capture RATE is the multiplier on all of it.
const COLS = 140, ROWS = 90, N = COLS * ROWS, SLOT = 1;
const idx = (x, y) => y * COLS + x;
const owner = new Uint8Array(N);
function capture(tail){
  for (const c of tail) owner[c] = SLOT;
  const seen = new Uint8Array(N); const q = [];
  const push = (cx, cy) => { const i = idx(cx, cy); if (!seen[i] && owner[i] !== SLOT){ seen[i] = 1; q.push(i); } };
  for (let x = 0; x < COLS; x++){ push(x, 0); push(x, ROWS - 1); } for (let y = 0; y < ROWS; y++){ push(0, y); push(COLS - 1, y); }
  while (q.length){ const i = q.pop(); const cx = i % COLS, cy = (i - cx) / COLS; if (cx > 0) push(cx - 1, cy); if (cx < COLS - 1) push(cx + 1, cy); if (cy > 0) push(cx, cy - 1); if (cy < ROWS - 1) push(cx, cy + 1); }
  for (let i = 0; i < N; i++) if (!seen[i] && owner[i] !== SLOT) owner[i] = SLOT;
}
let seed = 424242; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let y = 43; y < 48; y++) for (let x = 68; x < 73; x++) owner[idx(x, y)] = SLOT;
const DIRS = [[1,0],[0,1],[-1,0],[0,-1]];

// The rider never stops moving. Count CELLS TRAVELLED between captures — at SPEED 7.5 cells/s
// that converts straight to captures per second.
let x = 70, y = 45, d = 0, tail = [], tailSet = new Set();
let travelled = 0, sinceCapture = 0;
const buckets = [];
for (let step = 0; step < 400000; step++){
  if (rnd() < 0.14) d = (d + (rnd() < .5 ? 1 : 3)) & 3;
  let nx = x + DIRS[d][0], ny = y + DIRS[d][1];
  if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS){ d = (d + 2) & 3; continue; } // bounce instead of dying
  x = nx; y = ny; travelled++; sinceCapture++;
  const c = idx(x, y);
  if (tailSet.has(c)){ tail = []; tailSet = new Set(); sinceCapture = 0; continue; } // died, reset
  if (owner[c] === SLOT){
    if (tail.length){
      let cells = 0; for (let i = 0; i < N; i++) if (owner[i] === SLOT) cells++;
      const t0 = process.hrtime.bigint(); capture(tail); const t1 = process.hrtime.bigint();
      buckets.push({ pct: cells / N, gap: sinceCapture, us: Number(t1 - t0) / 1000 });
      tail = []; tailSet = new Set(); sinceCapture = 0;
    }
  } else { tail.push(c); tailSet.add(c); if (tail.length > 500){ tail = []; tailSet = new Set(); sinceCapture = 0; } }
}
// group by territory size
const bins = [[0,.05],[.05,.15],[.15,.30],[.30,.50],[.50,.75],[.75,1.01]];
console.log('territory      captures  cells_between  captures/sec@7.5   flood_fill_us');
for (const [lo, hi] of bins){
  const b = buckets.filter(v => v.pct >= lo && v.pct < hi);
  if (b.length < 5) continue;
  const gap = b.reduce((s, v) => s + v.gap, 0) / b.length;
  const us = b.reduce((s, v) => s + v.us, 0) / b.length;
  console.log(`${(lo*100).toFixed(0).padStart(3)}-${(hi*100).toFixed(0).padStart(3)}%   ${String(b.length).padStart(8)}  ${gap.toFixed(1).padStart(13)}  ${(7.5/gap).toFixed(2).padStart(17)}  ${us.toFixed(0).padStart(14)}`);
}
