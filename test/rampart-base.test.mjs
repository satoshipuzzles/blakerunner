// Territory is only yours while it is still joined to your base. Bombardment cuts land off as
// much as it destroys it: one line of craters across a neck used to leave a fat pocket of your
// colour that nothing was holding, still counting for full score until the block reset — so the
// safest land to own was the land furthest from your base.
//
// These tests drive the REAL severedCells / reanchorBase / wipeSevered lifted out of race.js,
// plus the real build-edge body, because a test that restates its own idea of connectivity passes
// against the broken source too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { race } from './source.mjs';

const COLS = 140, ROWS = 90, N = COLS * ROWS;
assert.match(race, /const COLS = 140, ROWS = 90/, 'grid size changed — update this test');
const idx = (x, y) => y * COLS + x;

const fn = name => {
  const m = race.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} is missing from game/race.js`);
  return m[0];
};
const arrow = name => {
  const m = race.match(new RegExp(`const ${name} = [^\\n]*`));
  assert.ok(m, `${name} is missing from game/race.js`);
  return m[0];
};

function world() {
  const owner = new Uint8Array(N);
  const body = [arrow('baseAlive'), fn('severedCells'), fn('reanchorBase'), fn('wipeSevered')].join('\n');
  const api = new Function('COLS', 'ROWS', 'idx', 'owner', 'Uint8Array', 'Infinity', 'Math',
    `${body}; return { baseAlive, severedCells, reanchorBase, wipeSevered };`)(
    COLS, ROWS, idx, owner, Uint8Array, Infinity, Math);
  const rect = (slot, x0, y0, w, h) => { const out = []; for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++){ owner[idx(x, y)] = slot; out.push(idx(x, y)); } return out; };
  const held = slot => { let n = 0; for (let i = 0; i < N; i++) if (owner[i] === slot) n++; return n; };
  return { owner, rect, held, ...api };
}

// A 3x3 base the way spawn() lays one down.
const base3 = (w, slot, cx, cy) => { const out = []; for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++){ const j = idx(cx + x, cy + y); w.owner[j] = slot; out.push(j); } return out; };

// ---------- what counts as connected ----------

test('a solid holding around the base loses nothing', () => {
  const w = world();
  const p = { slot: 1, base: base3(w, 1, 30, 30) };
  w.rect(1, 25, 25, 20, 20);
  assert.deepEqual(w.severedCells(p), [], 'a single connected holding must survive intact');
  assert.equal(w.wipeSevered(p), 0);
  assert.equal(w.held(1), 400, 'the holding was damaged by a sweep that should have been a no-op');
});

test('a pocket cut off by craters is severed, and only that pocket', () => {
  const w = world();
  // Two 10x10 blocks joined by a one-cell neck. The base is in the left one.
  w.rect(1, 20, 20, 10, 10);
  w.rect(1, 32, 20, 10, 10);
  for (let x = 30; x < 32; x++) w.owner[idx(x, 24)] = 1; // the neck
  const p = { slot: 1, base: base3(w, 1, 24, 24) };
  assert.deepEqual(w.severedCells(p), [], 'sanity: while the neck is intact nothing is severed');

  // A crater takes the neck out. In the game owner is zeroed by scorchDisk; here, directly.
  w.owner[idx(30, 24)] = 0; w.owner[idx(31, 24)] = 0;
  const cut = w.severedCells(p);
  assert.equal(cut.length, 100, `the right-hand block is 100 cells, got ${cut.length}`);
  for (const c of cut) assert.ok(c % COLS >= 32, 'a cell on the base side was reported as severed');
  assert.equal(w.wipeSevered(p), 100);
  assert.equal(w.held(1), 100, 'the base side should be all that is left');
});

test('a diagonal touch is not a connection', () => {
  const w = world();
  const p = { slot: 1, base: base3(w, 1, 50, 50) };
  // One cell touching the base block only at its corner.
  w.owner[idx(52, 52)] = 1;
  assert.deepEqual(w.severedCells(p), [idx(52, 52)],
    'corner-only contact must not count — capture() floods 4-connected and so must this');
});

test('another player’s land is never touched', () => {
  const w = world();
  const p = { slot: 1, base: base3(w, 1, 30, 30) };
  w.rect(2, 60, 60, 12, 12);      // a rival, nowhere near
  w.rect(1, 80, 80, 5, 5);        // our own detached pocket
  const before = w.held(2);
  assert.equal(w.wipeSevered(p), 25, 'our detached pocket should fall');
  assert.equal(w.held(2), before, 'the sweep clipped a rival’s territory');
});

// ---------- when the base itself dies ----------

test('a destroyed base re-anchors to the largest surviving piece, not to nothing', () => {
  const w = world();
  const p = { slot: 1, base: base3(w, 1, 30, 30) };
  const big = w.rect(1, 60, 60, 12, 12);   // 144 cells
  w.rect(1, 90, 60, 5, 5);                 // 25 cells
  for (const c of p.base) w.owner[c] = 0;  // the base is shelled flat

  assert.equal(w.baseAlive(p), false, 'sanity: the base should read as dead');
  const lost = w.wipeSevered(p);
  assert.equal(w.held(1), 144, 'the largest piece must survive a destroyed base');
  assert.equal(lost, 25, 'the smaller piece should have fallen');
  assert.ok(p.base.length > 0, 'the base did not move to the surviving piece');
  for (const c of p.base) assert.ok(big.includes(c), 'the new base is not inside the surviving piece');
  assert.equal(w.baseAlive(p), true, 'the re-anchored base must be live');
});

test('the re-anchored base sits on cells the player actually owns', () => {
  const w = world();
  // A square annulus. Its centroid is the hole in the middle, so a base placed at the centroid
  // would be dead on arrival and the whole holding would fall on the very next sweep. Built as a
  // rect minus a rect rather than a rasterised circle: a circle stepped by angle is full of
  // diagonal-only steps, so it is NOT one 4-connected piece and would be testing something else.
  const p = { slot: 1, base: [idx(10, 10)] };
  w.owner[idx(10, 10)] = 0;
  w.rect(1, 60, 35, 21, 21);
  w.rect(0, 63, 38, 15, 15);
  const ringCells = w.held(1);
  assert.equal(ringCells, 21 * 21 - 15 * 15, 'sanity: the annulus is not the shape this test thinks');
  w.reanchorBase(p);
  assert.ok(p.base.length > 0, 'no base was chosen for a ring-shaped holding');
  for (const c of p.base) assert.equal(w.owner[c], 1, 'a base cell was placed on ground the player does not own');
  assert.equal(w.baseAlive(p), true);
  assert.equal(w.severedCells(p).length, 0, 'the ring is one connected piece — none of it should be severed');
});

test('a player holding nothing at all survives the sweep without throwing', () => {
  const w = world();
  const p = { slot: 1, base: [] };
  assert.equal(w.wipeSevered(p), 0);
  assert.deepEqual(p.base, [], 'nothing owned means nothing to anchor to');
});

test('a player with no base recorded (an older object) falls back to its largest piece', () => {
  const w = world();
  const p = { slot: 4 };                   // no base field at all
  w.rect(4, 20, 20, 10, 10);
  w.rect(4, 50, 20, 3, 3);
  assert.equal(w.wipeSevered(p), 9, 'the small piece should fall');
  assert.equal(w.held(4), 100);
});

// ---------- when it runs ----------

test('spawn records the base it just claimed', () => {
  const src = fn('spawn');
  assert.match(src, /p\.base = \[\]/, 'spawn does not reset the base — a respawn would keep the old one');
  assert.match(src, /p\.base\.push\(j\)/, 'spawn claims its block without recording it as the base');
});

test('the sweep is armed at the build edge, not run there', () => {
  const onPhase = race.match(/function onRampartPhase[\s\S]*?\n\}/)?.[0];
  assert.ok(onPhase, 'onRampartPhase is missing');
  const build = onPhase.slice(onPhase.indexOf("key === 'build'){"));
  assert.match(build, /severPending = true/, 'the build edge does not arm the severance sweep');
  assert.doesNotMatch(build, /sweepSevered\(\)/,
    'sweeping at the edge itself scores the board before the last shells land — they outlive the edge by design');
});

test('the sweep waits for every shell to land', () => {
  const tick = race.match(/function rampartTick\(\)\{[\s\S]*?\n\}/)?.[0];
  assert.ok(tick, 'rampartTick is missing');
  assert.match(tick, /severPending && !shells\.length/,
    'the sweep does not wait on shells — a crater that lands in build would be scored a frame too late');

  // Drive the real condition: armed, with a shell in the air, must not fire.
  const gate = tick.match(/if \(severPending && !shells\.length\)\{([\s\S]*?)\}/)?.[1];
  assert.ok(gate, 'could not lift the sweep gate');
  let swept = 0;
  const run = new Function('severPending', 'shells', 'sweepSevered', 'setPending',
    `if (severPending && !shells.length){${gate}} setPending(severPending);`);
  run(true, [{ t: .5 }], () => swept++, () => {});
  assert.equal(swept, 0, 'the sweep fired while a shell was still in the air');
  run(true, [], () => swept++, () => {});
  assert.equal(swept, 1, 'the sweep never fired on a clear sky');
});

test('only the client that owns a rider’s land computes its wipe', () => {
  const src = fn('sweepSevered');
  assert.match(src, /p === local \|\| \(p\.drone && iDrive\(\)\)/,
    'a watching client recomputing this would race the keyframe that is about to overwrite it');
  assert.match(src, /sendLand\(true\)/, 'the wipe is not published — peers would keep showing the dead land');
  assert.match(src, /mode\.rampart/, 'the sweep is not gated to rampart mode');
});

// ---------- the guard is not vacuous ----------

test('the pre-fix source has no notion of a base at all', () => {
  // If any of these ever appear in a build without the change, these tests have stopped
  // describing it.
  assert.match(race, /function severedCells/, 'severedCells is gone — the rule is not implemented');
  assert.match(race, /base: \[\]/, 'mkPlayer does not carry a base');
  // And the rule has to bite: a disconnected pocket must not survive a sweep.
  const w = world();
  const p = { slot: 1, base: base3(w, 1, 30, 30) };
  w.rect(1, 100, 70, 4, 4);
  assert.ok(w.wipeSevered(p) > 0, 'a detached pocket survived — the sweep does nothing');
});
