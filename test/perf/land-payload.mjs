// Grow a territory the way the game actually grows one — random excursions off the owned
// region, closed by the real capture() flood fill from race.js:210 — and watch how the
// `land` keyframe payload scales as it gets bigger.
const COLS = 140, ROWS = 90, N = COLS * ROWS, SLOT = 1;
const idx = (x, y) => y * COLS + x;
const owner = new Uint8Array(N);

// verbatim from race.js:284
function rleMine(s){ const runs = []; let cur = 0, n = 0; for (let i = 0; i < owner.length; i++){ const v = owner[i] === s ? 1 : 0; if (v === cur) n++; else { runs.push(n); cur = v; n = 1; } } runs.push(n); return runs.join(','); }
// verbatim from race.js:210, minus the UI/network tail
function capture(tail){
  for (const c of tail) owner[c] = SLOT;
  const seen = new Uint8Array(N); const q = [];
  const push = (cx, cy) => { const i = idx(cx, cy); if (!seen[i] && owner[i] !== SLOT){ seen[i] = 1; q.push(i); } };
  for (let x = 0; x < COLS; x++){ push(x, 0); push(x, ROWS - 1); } for (let y = 0; y < ROWS; y++){ push(0, y); push(COLS - 1, y); }
  while (q.length){ const i = q.pop(); const cx = i % COLS, cy = (i - cx) / COLS; if (cx > 0) push(cx - 1, cy); if (cx < COLS - 1) push(cx + 1, cy); if (cy > 0) push(cx, cy - 1); if (cy < ROWS - 1) push(cx, cy + 1); }
  let gained = tail.length; for (let i = 0; i < N; i++) if (!seen[i] && owner[i] !== SLOT){ owner[i] = SLOT; gained++; }
  return gained;
}

let seed = 987654321; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
// spawn block, same shape as race.js spawn(): a small owned square
for (let y = 43; y < 48; y++) for (let x = 68; x < 73; x++) owner[idx(x, y)] = SLOT;

const DIRS = [[1,0],[0,1],[-1,0],[0,-1]];
// One excursion: leave an owned cell, walk with occasional turns (MAX_TAIL caps it at 500),
// stop as soon as we are back on our own land — exactly the loop the rider closes.
function excursion(){
  const own = []; for (let i = 0; i < N; i++) if (owner[i] === SLOT) own.push(i);
  if (!own.length) return null;
  const start = own[Math.floor(rnd() * own.length)];
  let x = start % COLS, y = (start - start % COLS) / COLS;
  let d = Math.floor(rnd() * 4); const tail = [];
  for (let step = 0; step < 500; step++){
    if (rnd() < 0.14) d = (d + (rnd() < .5 ? 1 : 3)) & 3;
    x += DIRS[d][0]; y += DIRS[d][1];
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return null;  // hit the edge: rider dies, no capture
    const c = idx(x, y);
    if (owner[c] === SLOT) return tail.length ? tail : null;     // closed the loop
    if (tail.includes(c)) return null;                           // crossed own tail: dies
    tail.push(c);
  }
  return null; // stretched too thin
}

console.log('capture#  cells   pct    runs   rle_bytes  evt_bytes');
let n = 0, captures = 0;
const marks = new Set([1, 5, 10, 25, 50, 100, 200, 400, 800]);
for (let attempt = 0; attempt < 40000 && captures < 800; attempt++){
  const t = excursion(); if (!t) continue;
  capture(t); captures++;
  if (marks.has(captures)){
    let cells = 0; for (let i = 0; i < N; i++) if (owner[i] === SLOT) cells++;
    const rle = rleMine(SLOT); const evt = JSON.stringify({ t: 'land', rle });
    console.log(String(captures).padStart(8), String(cells).padStart(6),
      (cells / N * 100).toFixed(1).padStart(5) + '%',
      String(rle.split(',').length).padStart(6),
      String(rle.length).padStart(10), String(evt.length).padStart(10));
  }
}
