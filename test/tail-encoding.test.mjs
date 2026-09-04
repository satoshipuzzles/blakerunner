// The tick used to carry the full tail as a raw index array — up to ~2.5 KB, 31x tank arena's
// whole tick, resent 6x a second by every rider. It now travels as a start cell plus run-length
// directions. These tests run the real encoder/decoder lifted from race.js, and pin the wire
// contract: tp on the way out, tp-or-legacy-tl on the way in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { race } from './source.mjs';

const lift = names => {
  const parts = names.map(n => {
    const m = race.match(new RegExp(`function ${n}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`));
    assert.ok(m, `${n} is missing from game/race.js`);
    return m[0];
  });
  const consts = race.match(/const DIRCH = \{[^}]*\}, CHDIR = \{[^}]*\};/);
  assert.ok(consts, 'DIRCH/CHDIR are missing from game/race.js');
  const [COLS, ROWS] = [140, 90];
  assert.match(race, /const COLS = 140, ROWS = 90/, 'grid size changed — update this test');
  return new Function(
    `const COLS = ${COLS}, ROWS = ${ROWS}, MAX_TAIL = 500; ${consts[0]} ${parts.join('\n')}; return { encodeTail, decodeTail };`
  )();
};
const { encodeTail, decodeTail } = lift(['encodeTail', 'decodeTail']);
const COLS = 140, ROWS = 90;

const randomWalk = len => {
  const cells = [Math.floor(ROWS / 2) * COLS + Math.floor(COLS / 2)];
  const deltas = [1, -1, COLS, -COLS];
  while (cells.length < len) {
    const c = cells[cells.length - 1];
    const opts = deltas.filter(d => {
      const n = c + d;
      if (n < 0 || n >= COLS * ROWS) return false;
      if (d === 1 && c % COLS === COLS - 1) return false;
      if (d === -1 && c % COLS === 0) return false;
      return true;
    });
    cells.push(c + opts[Math.floor(Math.random() * opts.length)]);
  }
  return cells;
};

test('a tail round-trips exactly through encode and decode', () => {
  for (const len of [1, 2, 37, 500]) {
    const cells = randomWalk(len);
    const enc = encodeTail(cells);
    assert.notEqual(enc, null, `a ${len}-cell walk must encode`);
    assert.deepEqual(decodeTail(enc), cells, `a ${len}-cell walk must round-trip`);
  }
  assert.equal(encodeTail([]), '');
  assert.deepEqual(decodeTail(''), []);
});

test('the encoding is dramatically smaller than the raw array it replaces', () => {
  // Worst case: a walk that turns nearly every step, so direction runs are short.
  const walk = randomWalk(500);
  assert.ok(encodeTail(walk).length * 3 < JSON.stringify(walk).length,
    `worst-case walk: encoded ${encodeTail(walk).length} B vs raw ${JSON.stringify(walk).length} B`);
  // Realistic case: riders hold a heading, so runs are long. A 500-cell rectangle sweep.
  const straight = [20 * COLS + 10];
  for (const [d, n] of [[1, 100], [COLS, 10], [-1, 100], [COLS, 10], [1, 100], [COLS, 10], [-1, 100], [COLS, 10], [1, 59]])
    for (let i = 0; i < n; i++) straight.push(straight[straight.length - 1] + d);
  const enc = encodeTail(straight), raw = JSON.stringify(straight);
  assert.deepEqual(decodeTail(enc), straight);
  assert.ok(enc.length * 25 < raw.length,
    `realistic tail: encoded ${enc.length} B vs raw ${raw.length} B`);
});

test('hostile or malformed input decodes to null, never to a bad tail', () => {
  for (const bad of [
    'not a tail', 'R5', '-5R3', 'zzzzz', // garbage, missing start, negative, start out of bounds
    '0L1',                                // walks off the left edge to -1
    '0R' + COLS * ROWS,                   // walks past the end of the grid
    '0R400R400',                          // over MAX_TAIL cells
    '0R' + '9'.repeat(3999),              // absurd run length
    'R'.repeat(5000),                     // over the length guard
    42, null, undefined, ['0R3'],         // non-strings
  ]) assert.equal(decodeTail(bad), null, `must reject: ${String(bad).slice(0, 40)}`);
});

test('non-adjacent cells make the encoder refuse rather than lie', () => {
  assert.equal(encodeTail([0, 5]), null, 'a 5-cell jump is not a path step');
});

test('the tick publishes tp and the receiver accepts tp or the legacy tl array', () => {
  assert.match(race, /tp === null \? \{ tl: tail \} : \{ tp \}/,
    'the tick must send the encoded tail, with raw tl only as the encoder fallback');
  assert.doesNotMatch(race, /st: \[style\.hue, style\.pat\], tl: local\.tail/,
    'the tick must not unconditionally embed the raw tail array');
  assert.match(race, /typeof c\.tp === 'string'/, 'the receiver must read the encoded tail');
  assert.match(race, /else if \(Array\.isArray\(c\.tl\)\)/,
    'the receiver must keep reading legacy raw tails until every client has reloaded');
});
