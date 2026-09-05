// The world layer and the minimap used to issue one canvas call per owned cell, so frame time
// grew with how much territory was on the board. Both now draw horizontal runs. These run the
// real ownerRuns() lifted from race.js and pin the only property that matters: the runs must
// cover exactly the cells the per-cell loops covered, no more and no less. A run extractor that
// is merely *fast* and slightly wrong paints territory onto land nobody owns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { race } from './source.mjs';

const COLS = 140, ROWS = 90;
assert.match(race, /const COLS = 140, ROWS = 90/, 'grid size changed — update this test');
const idx = (x, y) => y * COLS + x;

const lift = src => new Function('owner', 'idx', `${src}; return ownerRuns;`);
const ownerRunsSrc = race.match(/function ownerRuns\([^)]*\)\{[\s\S]*?\n\}/)?.[0];
assert.ok(ownerRunsSrc, 'ownerRuns is missing from game/race.js');
const makeRuns = lift(ownerRunsSrc);

// What the old code drew: one cell at a time, skipping slot 0. Every run extractor is judged
// against this, not against a restatement of itself.
const perCell = (owner, x0, y0, x1, y1, step) => {
  const seen = new Map();
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step){
    const s = owner[idx(x, y)]; if (!s) continue;
    if (!seen.has(s)) seen.set(s, new Set());
    // a sample at (x, y) covers [x, x+step) x [y, y+step)
    for (let dy = 0; dy < step; dy++) for (let dx = 0; dx < step; dx++) seen.get(s).add(`${x + dx},${y + dy}`);
  }
  return seen;
};
const fromRuns = (runs, step) => {
  const seen = new Map();
  for (const [s, arr] of runs){
    if (!seen.has(s)) seen.set(s, new Set());
    for (let i = 0; i < arr.length; i += 3)
      for (let dy = 0; dy < step; dy++) for (let dx = 0; dx < arr[i + 2]; dx++) seen.get(s).add(`${arr[i] + dx},${arr[i + 1] + dy}`);
  }
  return seen;
};
const sameCoverage = (a, b, what) => {
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), `${what}: different slots painted`);
  for (const [s, cells] of a)
    assert.deepEqual([...cells].sort(), [...b.get(s)].sort(), `${what}: slot ${s} covers different cells`);
};

const grids = {
  empty: () => new Uint8Array(COLS * ROWS),
  full: () => new Uint8Array(COLS * ROWS).fill(3),
  // a run that ends exactly on the right edge — the case a missing trailing flush drops
  rightEdge: () => { const o = new Uint8Array(COLS * ROWS); for (let y = 0; y < ROWS; y++) for (let x = COLS - 6; x < COLS; x++) o[idx(x, y)] = 2; return o; },
  bottomEdge: () => { const o = new Uint8Array(COLS * ROWS); for (let y = ROWS - 4; y < ROWS; y++) for (let x = 0; x < COLS; x++) o[idx(x, y)] = 1; return o; },
  bands: () => { const o = new Uint8Array(COLS * ROWS); for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) o[idx(x, y)] = (Math.floor(x / 17) % 4) + 1; return o; },
  speckle: () => { const o = new Uint8Array(COLS * ROWS); let s = 7; for (let i = 0; i < o.length; i++){ s = (s * 1103515245 + 12345) & 0x7fffffff; o[i] = s % 5; } return o; },
  singleCell: () => { const o = new Uint8Array(COLS * ROWS); o[idx(0, 0)] = 4; o[idx(COLS - 1, ROWS - 1)] = 4; return o; },
};

test('ownerRuns covers exactly the cells the per-cell loops covered', () => {
  for (const [name, mk] of Object.entries(grids)){
    const owner = mk();
    const runs = makeRuns(owner, idx);
    // world layer: cull window, stride 1
    for (const [x0, y0, x1, y1] of [[0, 0, COLS, ROWS], [3, 5, 71, 44], [COLS - 1, ROWS - 1, COLS, ROWS]])
      sameCoverage(perCell(owner, x0, y0, x1, y1, 1), fromRuns(runs(x0, y0, x1, y1, 1), 1), `${name} stride 1 [${x0},${y0},${x1},${y1}]`);
    // minimap: whole grid, stride 2
    sameCoverage(perCell(owner, 0, 0, COLS, ROWS, 2), fromRuns(runs(0, 0, COLS, ROWS, 2), 2), `${name} stride 2`);
  }
});

test('a stride that does not divide the span still covers its last sample', () => {
  // COLS is even, so stride 2 over the full grid lands exactly. A cull window can not.
  const owner = grids.full();
  const runs = makeRuns(owner, idx);
  for (const [x0, x1] of [[0, 7], [1, 8], [5, 6]])
    sameCoverage(perCell(owner, x0, 0, x1, 4, 2), fromRuns(runs(x0, 0, x1, 4, 2), 2), `stride 2 over [${x0},${x1})`);
});

test('runs are maximal — that is the whole point of the change', () => {
  // Adjacent same-slot runs in one row would mean we are still paying per cell.
  const owner = grids.bands();
  const runs = makeRuns(owner, idx)(0, 0, COLS, ROWS, 1);
  for (const [s, arr] of runs){
    const byRow = new Map();
    for (let i = 0; i < arr.length; i += 3){
      const row = byRow.get(arr[i + 1]) || []; row.push([arr[i], arr[i] + arr[i + 2]]); byRow.set(arr[i + 1], row);
    }
    for (const [y, spans] of byRow){
      spans.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < spans.length; i++)
        assert.ok(spans[i][0] > spans[i - 1][1], `slot ${s} row ${y}: runs ${spans[i - 1]} and ${spans[i]} should have been one run`);
    }
  }
  // 4 bands x 90 rows, and 140/17 leaves a 5th partial band
  assert.ok([...runs.values()].reduce((n, a) => n + a.length / 3, 0) < COLS * ROWS / 10, 'run count is not far below cell count');
});

test('the trailing flush is load-bearing — the obvious wrong version fails these tests', () => {
  // Guard against the guard: drop the post-loop flush from the real source and confirm the
  // coverage test above actually catches it. A test that passes on both versions is not evidence.
  const broken = ownerRunsSrc.replace(/\n\s*if \(s\) add\(s, from, y, x - from\);\n\s*\}\n\s*return runs;/, '\n  }\n  return runs;');
  assert.notEqual(broken, ownerRunsSrc, 'could not remove the trailing flush — this test has drifted from the source');
  const owner = grids.rightEdge();
  const runs = lift(broken)(owner, idx);
  assert.throws(
    () => sameCoverage(perCell(owner, 0, 0, COLS, ROWS, 1), fromRuns(runs(0, 0, COLS, ROWS, 1), 1), 'broken'),
    /different/,
    'removing the trailing flush should drop the right-edge run, but the test still passed');
});

test('neither draw layer issues a rect per cell any more', () => {
  const draw = race.slice(race.indexOf('function draw()'));
  assert.match(draw, /ownerRuns\(x0, y0, x1, y1, 1\)/, 'the world layer no longer uses ownerRuns');
  assert.match(draw, /ownerRuns\(0, 0, COLS, ROWS, 2\)/, 'the minimap no longer uses ownerRuns');
  // colorOf() built a fresh hsla() string per owned cell for Canvas to re-parse. It must now sit
  // outside the loop that emits the rects — compare positions rather than pattern-match a nested
  // structure, which is the sort of regex that silently matches nothing.
  const mini = draw.slice(draw.indexOf('const sx = mw / COLS')).split('\n').find(l => l.includes('ownerRuns(0, 0, COLS, ROWS, 2)'));
  assert.ok(mini, 'could not find the minimap draw');
  const style = mini.indexOf('cx.fillStyle = colorOf'), inner = mini.indexOf('for (let i = 0');
  assert.ok(style > -1 && inner > -1, 'minimap draw does not look like one fillStyle plus a rect loop');
  assert.ok(style < inner, 'minimap sets fillStyle inside the loop that emits its rects');
});

test('landFill carries the cell gutter now that the rects are flush', () => {
  // The 1px gutter used to come from insetting every per-cell rect. If the clip goes away while
  // draw() still emits flush run rects, territory renders as solid slabs.
  const fill = race.match(/function landFill\([^)]*\)\{[\s\S]*?\n\}/)?.[0];
  assert.ok(fill, 'landFill is missing from game/race.js');
  assert.match(fill, /rect\(\.5, \.5, CELL - 1, CELL - 1\);\s*x\.clip\(\)/, 'landFill no longer insets the pattern tile');
  assert.match(fill, /x\.restore\(\)/, 'landFill clips without restoring');
  const draw = race.slice(race.indexOf('function draw()'));
  assert.doesNotMatch(draw, /cx\.rect\(arr\[i\] \* CELL \+ \.5/, 'draw() insets run rects as well as the tile — the gutter would be doubled');
});
