// A cannon is a 2x2 emplacement, not a single cell. The rules that matter and that a single-cell
// implementation got for free: the block must fit on the board (a flat index wraps silently), all
// four cells must be owned and unscorched, cannons may not overlap, a tap anywhere on the block
// picks it up, and a crater under any of the four destroys it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { race } from './source.mjs';

const COLS = 140, ROWS = 90, N = COLS * ROWS;
assert.match(race, /const COLS = 140, ROWS = 90/, 'grid size changed — update this test');
const idx = (x, y) => y * COLS + x;
const xy = c => [c % COLS, (c - c % COLS) / COLS];

const src = name => {
  const m = race.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} is missing from game/race.js`);
  return m[0];
};
const W = Number(race.match(/CANNON_W = (\d+)/)?.[1]);
const H = Number(race.match(/CANNON_H = (\d+)/)?.[1]);

// Build a little world: owner/scorched arrays plus the real functions lifted out of race.js.
function world() {
  const owner = new Uint8Array(N), scorched = new Uint8Array(N);
  const body = [src('cannonCells'), src('cannonAt'), src('cannonBlocked'), src('cannonAnchors'), src('pruneCannons')].join('\n');
  const api = new Function('COLS', 'ROWS', 'CANNON_W', 'CANNON_H', 'idx', 'owner', 'scorched', 'players',
    `${body}; return { cannonCells, cannonAt, cannonBlocked, cannonAnchors, pruneCannons };`);
  const players = new Map();
  return { owner, scorched, players, ...api(COLS, ROWS, W, H, idx, owner, scorched, players) };
}

test('the footprint is CANNON_W x CANNON_H anchored top-left', () => {
  const { cannonCells } = world();
  assert.equal(W, 2); assert.equal(H, 2);
  assert.deepEqual(cannonCells(idx(10, 5)), [idx(10, 5), idx(11, 5), idx(10, 6), idx(11, 6)]);
});

test('a block that would run off the board is refused, not wrapped', () => {
  const { cannonCells } = world();
  // The bug a flat index invites: anchoring in the last column would put the right half on the
  // NEXT ROW rather than off the edge, and nothing downstream would notice.
  assert.equal(cannonCells(idx(COLS - 1, 10)), null, 'last column must be refused');
  assert.equal(cannonCells(idx(10, ROWS - 1)), null, 'last row must be refused');
  assert.notEqual(cannonCells(idx(COLS - 2, ROWS - 2)), null, 'the last legal anchor must still work');
  for (let y = 0; y < ROWS; y++) {
    const cs = cannonCells(idx(COLS - 2, y));
    if (!cs) continue;
    const rows = new Set(cs.map(c => xy(c)[1]));
    assert.equal(rows.size, H, `anchor at row ${y} spans ${rows.size} rows — a wrap`);
    for (const c of cs) assert.ok(xy(c)[0] >= COLS - 2, 'a cell wrapped to column 0');
  }
});

test('out-of-range and non-integer anchors are refused', () => {
  const { cannonCells } = world();
  for (const bad of [-1, N, N + 5, 1.5, NaN, undefined, null, '10']) assert.equal(cannonCells(bad), null, `${bad} should be refused`);
});

test('every one of the four cells must be owned', () => {
  const w = world();
  const anchor = idx(20, 20);
  for (const cs of [w.cannonCells(anchor)]) for (const c of cs) w.owner[c] = 1;
  assert.equal(w.cannonBlocked({ slot: 1, cannons: [] }, anchor), null, 'a fully owned block should place');
  // knock out one cell at a time — each must block on its own
  for (const c of w.cannonCells(anchor)) {
    w.owner[c] = 2;
    assert.match(w.cannonBlocked({ slot: 1, cannons: [] }, anchor) || '', /your own land/,
      `cell ${c} not owned but the block was allowed`);
    w.owner[c] = 1;
  }
});

test('a single scorched cell anywhere in the block blocks placement', () => {
  const w = world();
  const anchor = idx(30, 30);
  for (const c of w.cannonCells(anchor)) w.owner[c] = 1;
  for (const c of w.cannonCells(anchor)) {
    w.scorched[c] = 1;
    assert.match(w.cannonBlocked({ slot: 1, cannons: [] }, anchor) || '', /scorched/, `scorch at ${c} was ignored`);
    w.scorched[c] = 0;
  }
});

test('cannons may not overlap, including diagonally by one cell', () => {
  const w = world();
  for (let y = 20; y < 30; y++) for (let x = 20; x < 30; x++) w.owner[idx(x, y)] = 1;
  const p = { slot: 1, cannons: [{ cell: idx(22, 22) }] };
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 0], [0, -1], [-1, -1]])
    assert.match(w.cannonBlocked(p, idx(22 + dx, 22 + dy)) || '', /overlaps/, `offset ${dx},${dy} overlaps but was allowed`);
  for (const [dx, dy] of [[2, 0], [0, 2], [2, 2], [-2, 0], [0, -2]])
    assert.equal(w.cannonBlocked(p, idx(22 + dx, 22 + dy)), null, `offset ${dx},${dy} does not overlap but was refused`);
});

test('a tap anywhere on the block picks the cannon up, not just the anchor', () => {
  const w = world();
  const anchor = idx(40, 40);
  const list = [{ cell: anchor }];
  for (const c of w.cannonCells(anchor)) assert.equal(w.cannonAt(list, c), 0, `tapping cell ${c} missed the cannon`);
  assert.equal(w.cannonAt(list, idx(42, 40)), -1, 'a cell outside the block matched');
  assert.equal(w.cannonAt(list, idx(40, 42)), -1, 'a cell outside the block matched');
  assert.equal(w.cannonAt([], anchor), -1);
  assert.equal(w.cannonAt(undefined, anchor), -1, 'a player with no cannons array must not throw');
});

test('a crater under any of the four cells destroys the cannon', () => {
  for (let k = 0; k < W * H; k++) {
    const w = world();
    const anchor = idx(50, 50);
    const cells = w.cannonCells(anchor);
    for (const c of cells) w.owner[c] = 1;
    const p = { slot: 1, cannons: [{ cell: anchor }] };
    w.players.set('p', p);
    w.scorched[cells[k]] = 1;
    w.pruneCannons();
    assert.equal(p.cannons.length, 0, `scorch on cell ${k} of the block left the cannon standing`);
  }
});

test('pruning leaves cannons on clean ground alone', () => {
  const w = world();
  const keep = idx(60, 60), die = idx(70, 70);
  for (const c of [...w.cannonCells(keep), ...w.cannonCells(die)]) w.owner[c] = 1;
  const p = { slot: 1, cannons: [{ cell: keep }, { cell: die }] };
  w.players.set('p', p);
  w.scorched[w.cannonCells(die)[3]] = 1;
  w.pruneCannons();
  assert.deepEqual(p.cannons.map(c => c.cell), [keep]);
});

test('a holding with cells but no 2x2 reports no legal anchor', () => {
  const w = world();
  // a one-cell-wide snake: plenty of territory, nowhere for a 2x2
  for (let y = 10; y < 60; y++) w.owner[idx(15, y)] = 1;
  const held = [...w.owner].filter(v => v === 1).length;
  assert.ok(held >= 50, 'sanity: the snake should hold plenty of cells');
  assert.equal(w.cannonAnchors({ slot: 1, cannons: [] }).length, 0,
    `${held} cells held but a 2x2 was found in a 1-wide snake`);
  // widen it by one column and anchors appear
  for (let y = 10; y < 60; y++) w.owner[idx(16, y)] = 1;
  assert.ok(w.cannonAnchors({ slot: 1, cannons: [] }).length > 0, 'a 2-wide strip should have anchors');
});

test('every anchor cannonAnchors returns is actually placeable', () => {
  const w = world();
  for (let y = 20; y < 26; y++) for (let x = 20; x < 26; x++) w.owner[idx(x, y)] = 1;
  w.scorched[idx(22, 22)] = 1; w.owner[idx(24, 24)] = 2;
  const p = { slot: 1, cannons: [] };
  const anchors = w.cannonAnchors(p);
  assert.ok(anchors.length > 0);
  for (const a of anchors) {
    assert.equal(w.cannonBlocked(p, a), null, `anchor ${a} was returned but is blocked`);
    for (const c of w.cannonCells(a)) {
      assert.equal(w.owner[c], 1, `anchor ${a} covers a cell owned by ${w.owner[c]}`);
      assert.equal(w.scorched[c], 0, `anchor ${a} covers scorched cell ${c}`);
    }
  }
});

// ---------- wiring ----------

test('the tap path uses the footprint, not an exact-cell match', () => {
  const tap = race.match(/function rampartTap[\s\S]*?\n\}/)?.[0];
  assert.ok(tap, 'rampartTap is missing');
  assert.doesNotMatch(tap, /findIndex\(c => c\.cell === cell\)/, 'still matching the anchor cell exactly');
  assert.match(tap, /cannonAt\(local\.cannons, cell\)/, 'pick-up does not use cannonAt');
  assert.match(tap, /cannonBlocked/, 'placement does not validate the whole block');
});

test('a boom prunes cannons off the ground it destroyed', () => {
  const boom = race.match(/function boom\([\s\S]*?\n\}/)?.[0];
  assert.ok(boom, 'boom is missing');
  assert.match(boom, /pruneCannons\(\)/, 'a crater must take the cannons standing in it');
});

test('drones place legal blocks rather than random cells', () => {
  const fn = race.match(/function placeDroneCannons[\s\S]*?\n\}/)?.[0];
  assert.ok(fn, 'placeDroneCannons is missing');
  assert.match(fn, /cannonAnchors\(d\)/, 'drones still pick raw owned cells');
});

test('firing leaves the barrel pointing at the target', () => {
  const fn = race.match(/function launchShell[\s\S]*?\n\}/)?.[0];
  assert.ok(fn, 'launchShell is missing');
  assert.match(fn, /cannon\.aim = Math\.atan2/, 'the barrel does not turn to what it shot');
  assert.match(fn, /CANNON_W - 1\) \/ 2/, 'the shell should leave the centre of the block, not the anchor corner');
});
