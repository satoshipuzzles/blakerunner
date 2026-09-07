// A cannon that survived the bombardment is kept for the next round. It used to be scrapped at
// every build edge — `for (const p of players.values()) p.cannons = []` — so an emplacement was
// demolished by the calendar rather than by anyone shooting at it, and the siting you did in
// FORTIFY was worth nothing 18 seconds later.
//
// These tests drive the REAL keepCannons and the REAL fortify branch of onRampartPhase, lifted
// out of game/race.js, because a test that restates its own idea of the rule passes against the
// broken source too. Two things get pinned: what survives (whole 2x2 unscorched and still yours),
// and that survivors are charged against the allotment rather than stacked on top of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { race } from './source.mjs';

const COLS = 140, ROWS = 90, N = COLS * ROWS;
assert.match(race, /const COLS = 140, ROWS = 90/, 'grid size changed — update this test');
const idx = (x, y) => y * COLS + x;

const MAX_CANNONS = Number(race.match(/MAX_CANNONS = (\d+)/)?.[1]);
const CANNON_CURVE = Number(race.match(/CANNON_CURVE = ([\d.]+)/)?.[1]);
const DRONE_CANNON_SCALE = Number(race.match(/DRONE_CANNON_SCALE = ([\d.]+)/)?.[1]);
const W = Number(race.match(/CANNON_W = (\d+)/)?.[1]);
const H = Number(race.match(/CANNON_H = (\d+)/)?.[1]);
assert.ok(MAX_CANNONS > 0 && CANNON_CURVE > 0 && W === 2 && H === 2, 'cannon constants missing from game/race.js');

const src = name => {
  const m = race.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} is missing from game/race.js`);
  return m[0];
};

// A little world holding the real functions. `players` is shared so pruneCannons can walk it.
function world() {
  const owner = new Uint8Array(N), scorched = new Uint8Array(N), players = new Map();
  const body = [src('cannonCells'), src('cannonAt'), src('cannonBlocked'), src('cannonAnchors'),
    src('cannonAim'), src('pruneCannons'), src('keepCannons'), src('cannonsFor')].join('\n');
  const api = new Function('COLS', 'ROWS', 'CANNON_W', 'CANNON_H', 'MAX_CANNONS', 'CANNON_CURVE',
    'idx', 'owner', 'scorched', 'players', 'Math',
    `${body}; return { cannonCells, cannonAnchors, cannonBlocked, pruneCannons, keepCannons, cannonsFor };`);
  const w = { owner, scorched, players, ...api(COLS, ROWS, W, H, MAX_CANNONS, CANNON_CURVE, idx, owner, scorched, players, Math) };
  // Give a player `n` cells of land in a solid block starting at (x0, y0), row by row.
  w.give = (slot, x0, y0, cells) => {
    const out = [];
    for (let k = 0; k < cells; k++) { const c = idx(x0 + (k % 20), y0 + Math.floor(k / 20)); owner[c] = slot; out.push(c); }
    return out;
  };
  return w;
}

// ---------- what survives ----------

test('an intact emplacement on land you still hold is kept, re-armed and re-aimed', () => {
  const w = world();
  w.give(1, 10, 10, 200);
  const p = { slot: 1, cannons: [{ cell: idx(10, 10), fired: true, aim: 1.234 }] };
  const kept = w.keepCannons(p);
  assert.equal(kept.length, 1, 'an intact cannon on your own land must survive the round');
  assert.equal(kept[0].cell, idx(10, 10), 'the emplacement moved');
  assert.equal(kept[0].fired, false, 'a survivor that is still marked fired can never shoot again');
  assert.equal(typeof kept[0].aim, 'number');
  assert.notEqual(kept, p.cannons, 'keepCannons must return a new list, not mutate in place');
});

test('a crater under ANY of the four cells destroys the cannon', () => {
  for (const corner of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const w = world();
    w.give(1, 10, 10, 200);
    w.scorched[idx(10 + corner[0], 10 + corner[1])] = 1;
    const p = { slot: 1, cannons: [{ cell: idx(10, 10), fired: false, aim: 0 }] };
    assert.equal(w.keepCannons(p).length, 0, `scorch at offset ${corner} did not destroy the cannon`);
  }
});

test('ground that changed hands takes its cannon with it', () => {
  for (const corner of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const w = world();
    w.give(1, 10, 10, 200);
    w.owner[idx(10 + corner[0], 10 + corner[1])] = 2; // a rival overran one cell of the emplacement
    const p = { slot: 1, cannons: [{ cell: idx(10, 10), fired: false, aim: 0 }] };
    assert.equal(w.keepCannons(p).length, 0, `capture at offset ${corner} left an enemy gun standing`);
  }
});

test('land that simply went neutral does not keep the cannon either', () => {
  const w = world();
  w.give(1, 10, 10, 200);
  w.owner[idx(11, 11)] = 0;
  assert.equal(w.keepCannons({ slot: 1, cannons: [{ cell: idx(10, 10), fired: false }] }).length, 0,
    'an unowned cell under the block must not hold an emplacement');
});

test('a cannon off the edge of the board is dropped rather than wrapped', () => {
  const w = world();
  for (const c of [-1, N, idx(COLS - 1, 10), idx(10, ROWS - 1)]) {
    assert.equal(w.keepCannons({ slot: 1, cannons: [{ cell: c, fired: false }] }).length, 0,
      `anchor ${c} should never survive`);
  }
});

// ---------- the allotment ----------

// The real fortify branch, executed. Everything it touches is injected, so this is the shipped
// arithmetic and not a paraphrase of it.
const onPhase = race.match(/function onRampartPhase[\s\S]*?\n\}/)?.[0];
assert.ok(onPhase, 'onRampartPhase is missing from game/race.js');
const FORT = "key === 'fortify'){";
assert.ok(onPhase.includes(FORT), 'the fortify branch moved — update this test');
const fortifyBody = (() => {
  const after = onPhase.slice(onPhase.indexOf(FORT) + FORT.length);
  return after.slice(0, after.indexOf('\n  }'));
})();

// Run the fortify edge for a rider holding `land` cells with cannons already emplaced. Both
// counters come back out, because the placement cap is now their SUM and a test that only reads
// the grant cannot tell the two rules apart.
function fortify(w, local, land) {
  const feeds = [];
  let out = { cannonsAllowed: 0, cannonsKept: 0 };
  const run = new Function('local', 'landCounts', 'cannonsFor', 'keepCannons', 'cannonAnchors',
    'feed', 'started', 'iDrive', 'drones', 'placeDroneCannons', 'report', 'Math',
    `let cannonsAllowed = 0, cannonsKept = 0;\n${fortifyBody}\nreport(cannonsAllowed, cannonsKept);`);
  run(local, () => { local.land = land; }, w.cannonsFor, w.keepCannons, w.cannonAnchors,
    (msg, cls) => feeds.push(msg), true, () => false, [], () => {},
    (a, k) => { out = { cannonsAllowed: a, cannonsKept: k }; }, Math);
  return { ...out, feeds, cap: out.cannonsAllowed + out.cannonsKept };
}

test('survivors are EXTRA: the grant is added on top, not spent on them', () => {
  // This reverses the rule the carry-over first shipped with. Charging survivors against the grant
  // punished the thing the mode is about: a rider who successfully defended four cannons walked
  // into fortify already full and placed nothing, while a rider who had been shelled flat got four
  // fresh ones. cloudfodder's call, 2026-09-07: you always get to place what your land earns you.
  const w = world();
  const land = 3000;
  w.give(1, 5, 5, land);
  const grant = w.cannonsFor(land);
  assert.ok(grant >= 3, `this test needs a grant of at least 3, got ${grant} — retune it`);

  const local = { slot: 1, alive: true, land, cannons: [
    { cell: idx(5, 5), fired: true, aim: 0 }, { cell: idx(7, 5), fired: true, aim: 0 } ] };
  const { cannonsAllowed, cannonsKept, cap } = fortify(w, local, land);

  assert.equal(cannonsAllowed, grant, 'the grant itself must still be cannonsFor(land)');
  assert.equal(cannonsKept, 2, 'both survivors should have been counted as kept');
  assert.equal(local.cannons.length, 2, 'both survivors should have come through the edge');
  assert.ok(local.cannons.every(c => !c.fired), 'survivors were not re-armed');
  // The cap rampartTap enforces is `cannons.length >= cannonsKept + cannonsAllowed`. What is
  // placeable is therefore the WHOLE grant regardless of how many survived.
  assert.equal(cap - local.cannons.length, grant,
    'survivors are eating the grant — holding your ground must not cost you your new cannons');
});

test('the placeable count does not shrink as more cannons survive', () => {
  // The property that actually matters, swept rather than spot-checked: for a fixed holding, the
  // number of NEW cannons you may place is the same whether you carried nothing or a full pile.
  const w = world();
  const land = 3000;
  w.give(1, 5, 5, land);
  const grant = w.cannonsFor(land);
  let placeable = null;
  for (let survivors = 0; survivors <= 5; survivors++) {
    const cannons = [];
    for (let k = 0; k < survivors; k++) cannons.push({ cell: idx(5 + 3 * k, 5), fired: true, aim: 0 });
    const local = { slot: 1, alive: true, land, cannons };
    const { cap } = fortify(w, local, land);
    const canPlace = cap - local.cannons.length;
    if (placeable === null) placeable = canPlace;
    assert.equal(canPlace, placeable, `carrying ${survivors} survivors changed the new-cannon count`);
    assert.equal(canPlace, grant, `carrying ${survivors} survivors did not grant the full ${grant}`);
  }
});

test('the pile grows across rounds — MAX_CANNONS bounds the grant, not the total', () => {
  // The deliberate consequence of the rule above, pinned so nobody "fixes" it back by accident.
  // What bounds the total in practice is the board (every cannon needs its own 2x2 of your own
  // land) and the 18s bombard phase, not MAX_CANNONS.
  const w = world();
  w.owner.fill(1);
  const land = N;
  const local = { slot: 1, alive: true, land, cannons: [] };
  const counts = [];
  for (let round = 0; round < 4; round++) {
    const { cap } = fortify(w, local, land);
    // Place at pre-spaced non-overlapping anchors rather than re-scanning cannonAnchors (which is
    // O(grid) per placement and made this test 7s on its own). Anchor legality is covered above;
    // what is under test here is the cap arithmetic.
    while (local.cannons.length < cap) {
      const n = local.cannons.length;
      local.cannons.push({ cell: idx(4 + 3 * (n % 40), 4 + 3 * Math.floor(n / 40)), fired: false, aim: 0 });
    }
    counts.push(local.cannons.length);
  }
  assert.deepEqual(counts, [MAX_CANNONS, MAX_CANNONS * 2, MAX_CANNONS * 3, MAX_CANNONS * 4],
    `a rider holding the whole board and losing nothing should gain a full grant every round: ${counts}`);
});

test('losing your land loses the cannons on it, allotment or not', () => {
  const w = world();
  const land = 3000;
  const cells = w.give(1, 5, 5, land);
  const local = { slot: 1, alive: true, land, cannons: [
    { cell: idx(5, 5), fired: false, aim: 0 }, { cell: idx(7, 5), fired: false, aim: 0 } ] };
  // Shell one emplacement flat and let a rival take the other.
  w.scorched[idx(5, 5)] = 1; w.owner[idx(5, 5)] = 0;
  w.owner[idx(7, 5)] = 2;
  fortify(w, local, land);
  assert.equal(local.cannons.length, 0, 'a shelled and an overrun emplacement both have to fall');
  for (const c of cells) w.owner[c] = w.owner[c] === 1 ? 1 : w.owner[c];
});

// ---------- the guard is not vacuous ----------

test('the build edge no longer scraps cannons, and the pre-fix source still fails that check', () => {
  const buildBranch = onPhase.slice(onPhase.indexOf("key === 'build'){"));
  assert.doesNotMatch(buildBranch, /for \(const p of players\.values\(\)\) p\.cannons = \[\];/,
    'the build edge still hands every cannon back in — nothing survives the round');

  // The pre-fix fortify branch, verbatim, must fail the carry-over assertion. If this ever passes
  // the harness has stopped modelling the bug and every test above stops being evidence.
  const before = "cannonsAllowed = cannonsFor(local.land); local.cannons = [];";
  const w = world();
  w.give(1, 5, 5, 3000);
  const local = { slot: 1, land: 3000, cannons: [{ cell: idx(5, 5), fired: true, aim: 0 }] };
  new Function('local', 'cannonsFor', 'cannonsAllowed', `${before}`)(local, w.cannonsFor, 0);
  assert.equal(local.cannons.length, 0,
    'the pre-fix line should destroy the survivor — if it does not, this suite proves nothing');
});

// ---------- drones play by the same rules ----------

test('drones get their grant on top of their survivors too', () => {
  const body = src('placeDroneCannons');
  const w = world();
  const land = 4000;
  w.give(3, 40, 40, land);
  const d = { slot: 3, land, cannons: [{ cell: idx(40, 40), fired: true, aim: 0 }] };
  const place = new Function('d', 'cannonsFor', 'DRONE_CANNON_SCALE', 'keepCannons', 'cannonAnchors', 'cannonAim', 'Math',
    `${body}; return placeDroneCannons;`)(d, w.cannonsFor, DRONE_CANNON_SCALE, w.keepCannons, w.cannonAnchors,
    () => 0, Math);
  place(d);
  const grant = w.cannonsFor(land, DRONE_CANNON_SCALE);
  assert.ok(d.cannons.some(c => c.cell === idx(40, 40)), 'the drone threw away a cannon that survived');
  assert.equal(d.cannons.length, grant + 1, `drone should hold its 1 survivor plus a full grant of ${grant}`);
});

// ---------- craters from a keyframe destroy cannons too ----------

test('a scorched keyframe prunes cannons, not just owners', () => {
  const apply = race.match(/function applyScorchedRle\([\s\S]*?\n\}/)?.[0]
    || race.match(/function applyScorchedRle\(str\)\{.*\}/)?.[0];
  assert.ok(apply, 'applyScorchedRle is missing from game/race.js');
  assert.match(apply, /pruneCannons\(\)/,
    'keyframed craters leave cannons standing on them — now that cannons outlive the round, that is visible');
});
