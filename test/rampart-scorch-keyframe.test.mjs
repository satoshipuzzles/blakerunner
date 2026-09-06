// The scorched keyframe had no notion of which round it described. It is a monotonic union — it
// only ever sets scorched[i]=1 and owner[i]=0 — and scorch is cleared at the block rollover on
// each client's own 20s poll plus a 7s podium. So for up to ~27s one client is on the new block
// with a clean board while another still holds a full mask, and any fresh peer publishing in that
// window made the lagging client broadcast its stale mask: craters resurrected onto a fresh board,
// and newly claimed land zeroed with them.
//
// These tests pin the round stamp and, more importantly, reproduce the divergence it prevents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { race } from './source.mjs';

const COLS = 140, ROWS = 90, N = COLS * ROWS;
assert.match(race, /const COLS = 140, ROWS = 90/, 'grid size changed — update this test');

// The real receive guard, lifted as an executable predicate rather than restated.
const guardSrc = (() => {
  const line = race.match(/else if \(c\.t === 'scorched'[^\n]*\n?[^\n]*applyScorchedRle\(c\.rle\); \}/)?.[0]
            || race.match(/else if \(c\.t === 'scorched'[^\n]*\}/)?.[0];
  assert.ok(line, "the 'scorched' receive branch is missing from game/race.js");
  const open = line.indexOf('(');
  const close = line.lastIndexOf('){');
  return line.slice(open + 1, close);
})();
const accepts = (c, chain, mode = { rampart: true }) =>
  new Function('c', 'chain', 'mode', `return !!(${guardSrc});`)(c, chain, mode);

const rle = 'x'.repeat(10);

test('the keyframe carries the block height it describes', () => {
  const send = race.match(/function sendScorched\(\)[\s\S]*?\n\}/)?.[0] || race.match(/function sendScorched\(\)[^\n]*/)?.[0];
  assert.ok(send, 'sendScorched is missing');
  assert.match(send, /t: 'scorched', h: chain\.height/, 'the keyframe does not say which round it is about');
});

test('a keyframe for the current round is applied', () => {
  assert.equal(accepts({ t: 'scorched', h: 900123, rle }, { height: 900123 }), true);
});

test('a keyframe from the previous round is rejected', () => {
  // The exact failure: a peer still on the old block re-broadcasting its mask at a rollover.
  assert.equal(accepts({ t: 'scorched', h: 900122, rle }, { height: 900123 }), false,
    'a stale mask would resurrect craters and zero freshly claimed land');
});

test('a keyframe from a round we have not seen yet is also rejected', () => {
  // Rejecting is the safe direction and self-corrects on the next poll: a crater we skip is
  // re-sent by the next join, whereas a resurrected one silently deletes real territory.
  assert.equal(accepts({ t: 'scorched', h: 900124, rle }, { height: 900123 }), false);
});

test('an untagged keyframe from an older client is rejected', () => {
  assert.equal(accepts({ t: 'scorched', rle }, { height: 900123 }), false);
  assert.equal(accepts({ t: 'scorched', h: undefined, rle }, { height: 900123 }), false);
  assert.equal(accepts({ t: 'scorched', h: null, rle }, { height: 900123 }), false);
  assert.equal(accepts({ t: 'scorched', h: '900123', rle }, { height: 900123 }), false, 'a string height must not match loosely');
});

test('the existing guards still hold', () => {
  assert.equal(accepts({ t: 'scorched', h: 5, rle }, { height: 5 }, { rampart: false }), false, 'applied outside rampart mode');
  assert.equal(accepts({ t: 'scorched', h: 5, rle: 123 }, { height: 5 }), false, 'a non-string rle was accepted');
  assert.equal(accepts({ t: 'scorched', h: 5, rle: 'x'.repeat(30001) }, { height: 5 }), false, 'an oversized rle was accepted');
  assert.equal(accepts({ t: 'land', h: 5, rle }, { height: 5 }), false, 'a land event reached the scorched branch');
});

// ---- the divergence itself, replayed over the real applyScorchedRle ----

// Both are single-line functions, so the lift must stop at the newline. A `[\s\S]*?\n\}` here
// runs past the end of the function and swallows half the module — it fails loudly with a
// duplicate-declaration SyntaxError, but the same overshoot on a well-formed slice would quietly
// test the wrong code.
const oneLiner = name => {
  const m = race.match(new RegExp(`function ${name}\\([^\\n]*`));
  assert.ok(m, `${name} is missing from game/race.js`);
  assert.ok(m[0].trim().endsWith('}'), `${name} is no longer a one-liner — update this lift`);
  return m[0];
};
const applySrc = oneLiner('applyScorchedRle');
const rleScorchedSrc = oneLiner('rleScorched');

function board() {
  const owner = new Uint8Array(N), scorched = new Uint8Array(N);
  const api = new Function('owner', 'scorched', 'COLS', 'ROWS',
    `${applySrc}\n${rleScorchedSrc}\n return { applyScorchedRle, rleScorched };`)(owner, scorched, COLS, ROWS);
  return { owner, scorched, ...api };
}

test('replaying a stale mask onto a fresh board is exactly the damage described', () => {
  // Lagging client: a round's worth of craters.
  const old = board();
  for (let i = 500; i < 900; i++) old.scorched[i] = 1;
  const staleMask = old.rleScorched();

  // Fresh client: rolled over, board cleared, and a rider has claimed land where craters used to be.
  const fresh = board();
  for (let i = 500; i < 900; i++) fresh.owner[i] = 7;
  const claimedBefore = [...fresh.owner].filter(v => v === 7).length;
  assert.equal(claimedBefore, 400, 'sanity: the fresh board should hold the new claim');

  // What the OLD code did — apply unconditionally.
  fresh.applyScorchedRle(staleMask);
  assert.equal([...fresh.scorched].filter(Boolean).length, 400, 'sanity: the stale mask does re-scorch');
  assert.equal([...fresh.owner].filter(v => v === 7).length, 0,
    'sanity: and it zeroes the freshly claimed land, which is why the stamp is needed');
});

test('the guard is what stops that replay', () => {
  // Same stale mask — a REAL one. An earlier version of this test passed a placeholder string as
  // the rle, which decodes to no runs at all, so it passed against the unguarded source too: the
  // replay did nothing for the wrong reason. The payload has to be capable of doing the damage or
  // the guard is not being tested.
  const old = board();
  for (let i = 500; i < 900; i++) old.scorched[i] = 1;
  const fresh = board();
  for (let i = 500; i < 900; i++) fresh.owner[i] = 7;
  const stale = { t: 'scorched', h: 900122, rle: old.rleScorched() };
  if (accepts(stale, { height: 900123 })) fresh.applyScorchedRle(stale.rle);
  assert.equal([...fresh.scorched].filter(Boolean).length, 0, 'craters were resurrected onto the fresh board');
  assert.equal([...fresh.owner].filter(v => v === 7).length, 400, 'freshly claimed land was zeroed by a stale keyframe');
});

test('applyScorchedRle is still monotonic for a keyframe that is accepted', () => {
  const b = board();
  for (let i = 100; i < 200; i++) b.scorched[i] = 1;
  const mine = b.rleScorched();
  const peer = board();
  for (let i = 300; i < 340; i++) peer.scorched[i] = 1;
  b.applyScorchedRle(peer.rleScorched());
  for (let i = 100; i < 200; i++) assert.equal(b.scorched[i], 1, `own crater ${i} was cleared by a peer keyframe`);
  for (let i = 300; i < 340; i++) assert.equal(b.scorched[i], 1, `peer crater ${i} was not applied`);
  assert.equal(b.rleScorched(), b.rleScorched(), 'sanity: the encoding is stable');
});

test('the block rollover still clears scorch', () => {
  const round = race.match(/setTimeout\(\(\) => \{ \$\('podium'\)[\s\S]*?\}, 7000\);/)?.[0];
  assert.ok(round, 'could not find the block rollover reset');
  assert.match(round, /scorched\.fill\(0\)/, 'the rollover no longer clears scorch');
});
