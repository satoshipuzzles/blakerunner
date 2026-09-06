// Rampart mode adds three things worth pinning against the real source: a phase clock that must
// partition its period with no gap or overlap (a gap would strand every client with no phase), a
// blast that scorches a disk and clears its owner, and the rule the whole mode rests on — scorched
// earth can never be re-owned, including by a land keyframe replaying over a fresh crater. These
// lift the actual functions out of game/race.js so they cannot drift from what ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { race } from './source.mjs';

const COLS = 140, ROWS = 90;
assert.match(race, /const COLS = 140, ROWS = 90/, 'grid size changed — update this test');
const idx = (x, y) => y * COLS + x;
const lift = (names, src, ret) => new Function(...names, `${src}; return ${ret};`);

// --- extract the phase table straight from source, keys and durations in order ---
const phasesBlock = race.match(/const RAMPART_PHASES = \[([\s\S]*?)\];/)?.[1];
assert.ok(phasesBlock, 'RAMPART_PHASES is missing from game/race.js');
const keys = [...phasesBlock.matchAll(/key:\s*'(\w+)'/g)].map(m => m[1]);
const secs = [...phasesBlock.matchAll(/secs:\s*(\d+)/g)].map(m => Number(m[1]));
assert.equal(keys.length, secs.length, 'every phase needs a key and a secs');
assert.deepEqual(keys, ['build', 'fortify', 'bombard'], 'phase order changed — update this test');
const PHASES = keys.map((key, i) => ({ key, secs: secs[i] }));
const PERIOD = secs.reduce((a, b) => a + b, 0);

const BLAST_R = Number(race.match(/BLAST_R = ([\d.]+)/)?.[1]);
assert.ok(BLAST_R > 0, 'BLAST_R missing from game/race.js');

test('the phase clock partitions its period with no gap or overlap', () => {
  const src = race.match(/function rampartPhase\(\)\{[\s\S]*?\n\}/)?.[0];
  assert.ok(src, 'rampartPhase is missing from game/race.js');
  // Sweep every second of the period, driving the REAL function with a stubbed clock. Every second
  // must map to exactly one phase, the phases must appear in table order for exactly their secs,
  // and `left` must count down to 1 at the last second of each phase.
  const seen = [];
  for (let s = 0; s < PERIOD; s++){
    // rampartPhase now reads syncedNow() — the browser clock corrected against the server's — so
    // the stub is injected there rather than on Date. See test/rampart-clock.test.mjs for the
    // correction itself.
    const rampartPhase = lift(['RAMPART_PHASES', 'RAMPART_PERIOD', 'syncedNow'], src, 'rampartPhase')(PHASES, PERIOD, () => s * 1000);
    const ph = rampartPhase();
    assert.ok(ph && typeof ph.key === 'string', `second ${s} produced no phase`);
    assert.ok(ph.left >= 1 && ph.left <= PHASES.find(p => p.key === ph.key).secs, `second ${s}: left ${ph.left} out of range`);
    seen.push(ph.key);
  }
  // Reconstruct the expected run-length sequence from the table and compare.
  const expected = [];
  for (const p of PHASES) for (let i = 0; i < p.secs; i++) expected.push(p.key);
  assert.deepEqual(seen, expected, 'phases do not tile the period in order');
  // And it wraps: one period later is the same phase.
  const src2 = src;
  const at = t => lift(['RAMPART_PHASES', 'RAMPART_PERIOD', 'syncedNow'], src2, 'rampartPhase')(PHASES, PERIOD, () => t * 1000)().key;
  assert.equal(at(3), at(3 + PERIOD), 'the cycle does not repeat across the period boundary');
});

// --- cannon allotment scales with territory over the WHOLE range ---
// This block previously asserted `cannonsFor(0) === 1` and a linear one-per-CANNON_PER_CELLS
// rule. Both were the behaviour being fixed: the floor handed a cannon to a rider with no land to
// stand it on, and the linear rule hit MAX_CANNONS at 22.8% of the grid, so a quarter of the board
// and the whole board granted identical firepower. The contract is now a sub-linear curve.
const N_CELLS = COLS * ROWS;
const allot = () => {
  const src = race.match(/function cannonsFor\([\s\S]*?\n\}/)?.[0];
  assert.ok(src, 'cannonsFor is missing from game/race.js');
  const MAX = Number(race.match(/MAX_CANNONS = (\d+)/)?.[1]);
  const CURVE = Number(race.match(/CANNON_CURVE = ([\d.]+)/)?.[1]);
  assert.ok(MAX > 0 && CURVE > 0, 'MAX_CANNONS / CANNON_CURVE missing');
  return { MAX, CURVE, fn: new Function('MAX_CANNONS', 'CANNON_CURVE', 'COLS', 'ROWS', `${src}; return cannonsFor;`)(MAX, CURVE, COLS, ROWS) };
};

test('no land means no cannon', () => {
  const { fn } = allot();
  for (const land of [0, -1, -100, NaN, undefined, null]) assert.equal(fn(land), 0, `${land} land should grant no cannon`);
  assert.equal(fn(1), 1, 'any land at all grants at least one');
});

test('the allotment never decreases as territory grows', () => {
  const { fn } = allot();
  let prev = -1;
  for (let land = 0; land <= N_CELLS; land += 13){ const c = fn(land); assert.ok(c >= prev, `${land} cells granted ${c}, fewer than the ${prev} before it`); prev = c; }
});

test('the cap is reached at the whole board, not at a quarter of it', () => {
  const { fn, MAX } = allot();
  assert.equal(fn(N_CELLS), MAX, 'owning everything should grant MAX_CANNONS');
  // The regression this exists to catch: the old curve was already maxed at 2875 cells.
  assert.ok(fn(2875) < MAX, `22.8% of the grid still grants the maximum (${fn(2875)}/${MAX}) — the cap binds too early`);
  assert.ok(fn(N_CELLS / 2) < fn(N_CELLS), 'half the board and the whole board grant the same — expansion stops paying');
  assert.ok(fn(N_CELLS / 4) < fn(N_CELLS / 2), 'a quarter and a half grant the same');
});

test('the allotment stays inside the phase budget', () => {
  // FORTIFY is a fixed number of seconds and every cannon costs a tap. An allotment nobody can
  // physically place is a balance change disguised as a number.
  const { fn, MAX } = allot();
  const fortify = PHASES.find(p => p.key === 'fortify');
  assert.ok(fortify, 'no fortify phase');
  assert.ok(MAX <= fortify.secs, `MAX_CANNONS ${MAX} exceeds the ${fortify.secs}s fortify phase at one tap a second`);
  for (let land = 0; land <= N_CELLS; land += 97) assert.ok(fn(land) <= MAX, `${land} cells granted more than MAX_CANNONS`);
});

test('drones run the same curve, handicapped by an explicit multiplier', () => {
  const { fn, MAX } = allot();
  const scale = Number(race.match(/DRONE_CANNON_SCALE = ([\d.]+)/)?.[1]);
  assert.ok(scale > 0 && scale < 1, 'DRONE_CANNON_SCALE missing or not a handicap');
  for (let land = 200; land <= N_CELLS; land += 311)
    assert.ok(fn(land, scale) <= fn(land), `at ${land} cells a drone out-guns a rider`);
  assert.equal(fn(N_CELLS, scale), Math.round(MAX * scale), 'a drone owning everything should get its scaled ceiling');
  // and the drone path must actually use it, rather than keeping a second private curve
  const drone = race.match(/function placeDroneCannons[\s\S]*?\n\}/)?.[0];
  assert.ok(drone, 'placeDroneCannons is missing');
  assert.match(drone, /cannonsFor\([^)]*DRONE_CANNON_SCALE\)/, 'drones still compute their own allotment');
});

// --- scorchDisk: the blast footprint ---
const scorchSrc = race.match(/function scorchDisk\([^)]*\)\{[\s\S]*?\n\}/)?.[0];
assert.ok(scorchSrc, 'scorchDisk is missing from game/race.js');
const makeScorch = (owner, scorched) => lift(['owner', 'scorched', 'idx', 'COLS', 'ROWS', 'BLAST_R'], scorchSrc, 'scorchDisk')(owner, scorched, idx, COLS, ROWS, BLAST_R);

// What the blast is defined to hit: every in-bounds cell within Euclidean BLAST_R of the centre.
const diskCells = (cx, cy) => {
  const out = []; const R = Math.ceil(BLAST_R);
  for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++){
    if (Math.hypot(x, y) > BLAST_R) continue;
    const ax = cx + x, ay = cy + y; if (ax < 0 || ay < 0 || ax >= COLS || ay >= ROWS) continue;
    out.push(idx(ax, ay));
  }
  return out;
};

test('scorchDisk scorches exactly the blast disk and clears its owner', () => {
  const owner = new Uint8Array(COLS * ROWS).fill(3); // whole board owned by slot 3
  const scorched = new Uint8Array(COLS * ROWS);
  const cx = 70, cy = 45;
  const n = makeScorch(owner, scorched)(cx, cy);
  const disk = new Set(diskCells(cx, cy));
  assert.equal(n, disk.size, 'reported count is not the disk size');
  for (let i = 0; i < owner.length; i++){
    if (disk.has(i)){ assert.equal(scorched[i], 1, `cell ${i} in the disk was not scorched`); assert.equal(owner[i], 0, `cell ${i} in the disk kept its owner`); }
    else { assert.equal(scorched[i], 0, `cell ${i} outside the disk was scorched`); assert.equal(owner[i], 3, `cell ${i} outside the disk lost its owner`); }
  }
});

test('scorchDisk is idempotent: a second blast on the same spot scorches nothing new', () => {
  const owner = new Uint8Array(COLS * ROWS).fill(3);
  const scorched = new Uint8Array(COLS * ROWS);
  const scorch = makeScorch(owner, scorched);
  const first = scorch(20, 20);
  const second = scorch(20, 20);
  assert.ok(first > 0, 'the first blast scorched nothing');
  assert.equal(second, 0, 'the second blast reported new scorched cells');
});

test('scorchDisk clips at the grid edge without wrapping or crashing', () => {
  const owner = new Uint8Array(COLS * ROWS).fill(3);
  const scorched = new Uint8Array(COLS * ROWS);
  const n = makeScorch(owner, scorched)(0, 0);
  assert.equal(n, diskCells(0, 0).length, 'corner blast hit the wrong number of cells');
  // nothing on the far edge should be touched by a blast at the origin
  assert.equal(scorched[idx(COLS - 1, ROWS - 1)], 0, 'a corner blast wrapped to the opposite corner');
});

// --- the load-bearing rule: scorched earth cannot be re-owned ---
test('applyRle refuses to paint a slot onto scorched cells', () => {
  const src = race.match(/function applyRle\([^)]*\)\{[\s\S]*?\n\}/)?.[0];
  assert.ok(src, 'applyRle is missing from game/race.js');
  assert.match(src, /scorched/, 'applyRle no longer guards against scorched — the scorched-earth rule is unenforced');
  const owner = new Uint8Array(COLS * ROWS);
  const scorched = new Uint8Array(COLS * ROWS);
  const clearLand = s => { for (let i = 0; i < owner.length; i++) if (owner[i] === s) owner[i] = 0; };
  const applyRle = lift(['owner', 'scorched', 'clearLand'], src, 'applyRle')(owner, scorched, clearLand);
  // Scorch the first ten cells, then have slot 5 claim the entire board via one all-ones run.
  for (let i = 0; i < 10; i++) scorched[i] = 1;
  applyRle(5, '0,' + owner.length); // RLE alternates from unowned: a 0-length unowned run, then the whole grid owned
  for (let i = 0; i < 10; i++) assert.equal(owner[i], 0, `scorched cell ${i} was re-owned by an RLE keyframe`);
  for (let i = 10; i < owner.length; i++) assert.equal(owner[i], 5, `unscorched cell ${i} should have been claimed`);
});

// The scorched keyframe: a fresh joiner reconstructs craters it never saw the booms for. It must
// round-trip, clear owner where it scorches, and NEVER un-scorch — booms are the only thing that
// adds craters, and a stale/empty keyframe must not erase them on a peer that is ahead.
test('the scorched keyframe round-trips and only ever sets craters', () => {
  const rleSrc = race.match(/function rleScorched\(\)\{[\s\S]*?\n\}/)?.[0];
  const applySrc = race.match(/function applyScorchedRle\([^)]*\)\{[\s\S]*?\n\}/)?.[0];
  assert.ok(rleSrc && applySrc, 'rleScorched / applyScorchedRle missing from game/race.js');
  const craters = [0, 5, 6, 7, 100, 101, COLS * ROWS - 1];
  const src = new Uint8Array(COLS * ROWS); for (const c of craters) src[c] = 1;
  const rle = new Function('scorched', `${rleSrc}; return rleScorched;`)(src)();
  // apply onto a board fully owned by slot 4 with no craters yet
  const dstScorched = new Uint8Array(COLS * ROWS), dstOwner = new Uint8Array(COLS * ROWS).fill(4);
  const applyScorchedRle = new Function('scorched', 'owner', `${applySrc}; return applyScorchedRle;`)(dstScorched, dstOwner);
  applyScorchedRle(rle);
  const set = new Set(craters);
  for (let i = 0; i < dstScorched.length; i++){
    if (set.has(i)){ assert.equal(dstScorched[i], 1, `crater ${i} not reconstructed`); assert.equal(dstOwner[i], 0, `crater ${i} kept its owner`); }
    else { assert.equal(dstScorched[i], 0, `cell ${i} wrongly scorched`); assert.equal(dstOwner[i], 4, `cell ${i} wrongly cleared`); }
  }
  // a later empty keyframe (a peer with no craters) must not erase what we already have
  const empty = new Function('scorched', `${rleSrc}; return rleScorched;`)(new Uint8Array(COLS * ROWS))();
  applyScorchedRle(empty);
  for (const c of craters) assert.equal(dstScorched[c], 1, 'an empty keyframe un-scorched an existing crater');
});

// A guard that a capture cannot claim scorched interior either — assert the source keeps the check.
test('capture() keeps its scorched guards so bombarded land stays lost', () => {
  const src = race.match(/function capture\(p\)\{[\s\S]*?\n\}/)?.[0];
  assert.ok(src, 'capture is missing from game/race.js');
  assert.match(src, /if \(!scorched\[c\]\) owner\[c\] = p\.slot/, 'capture no longer skips scorched tail cells');
  assert.match(src, /!scorched\[i\]/, 'capture flood-fill no longer skips scorched interior cells');
});
