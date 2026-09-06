// A shell fired near the end of BOMBARD used to be destroyed by the phase edge: onRampartPhase
// wiped `shells` on entering build, and boom() only ever fires from stepShells at t >= 1, so the
// shot vanished — no crater, nothing published, cannon still spent. These tests drive the real
// stepShells across the edge and pin that it now lands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { race } from './source.mjs';

const SHELL_MS = Number(race.match(/SHELL_MS = (\d+)/)?.[1]);
assert.ok(SHELL_MS > 0, 'SHELL_MS missing from game/race.js');

const stepSrc = race.match(/function stepShells\(dt\)\{[\s\S]*?\n\}/)?.[0];
assert.ok(stepSrc, 'stepShells is missing from game/race.js');

// A rig around the real stepShells: records craters and published boom events.
function rig() {
  const shells = [], booms = [], published = [];
  const stepShells = new Function('shells', 'SHELL_MS', 'boom', 'pub', 'signAsSess', 'net', 'roomTag', 'K_EVT', 'JSON',
    `${stepSrc}; return stepShells;`)(
    shells, SHELL_MS,
    (x, y, mine) => booms.push({ x, y, mine }),
    e => published.push(e), o => o, { ready: true }, () => 'tag', 21111, JSON);
  const fire = (mine = true) => shells.push({ sx: 10.5, sy: 10.5, tx: 50.5, ty: 50.5, x: 10.5, y: 10.5, t: 0, hue: 0, mine });
  return { shells, booms, published, stepShells, fire };
}

// What the build phase edge does to shells, read out of the source rather than restated.
const onPhase = race.match(/function onRampartPhase[\s\S]*?\n\}/)?.[0];
assert.ok(onPhase, 'onRampartPhase is missing');
const MARK = "key === 'build'){";
const buildBranch = onPhase.slice(onPhase.indexOf(MARK));
// The REAL build-edge body, executable. Binding it rather than restating it is the whole point:
// a test that applies its own idea of the edge passes against the broken source too, which is
// exactly how this suite was vacuous on its first run.
const buildBody = (() => {
  const after = onPhase.slice(onPhase.indexOf(MARK) + MARK.length);
  return after.slice(0, after.indexOf('\n  }'));
})();
const applyBuildEdge = shells => new Function('shells', 'players', 'feed', 'started', 'prev', buildBody)(
  shells, new Map(), () => {}, true, 'bombard');

test('the phase edge no longer discards shells in flight', () => {
  assert.doesNotMatch(buildBranch, /shells\.length = 0/,
    'entering build still wipes shells — a shot fired in the last SHELL_MS is destroyed mid-arc');
});

test('a shell fired just before the edge still lands and still publishes', () => {
  for (const beforeEdge of [0.05, 0.2, 0.3, 0.5, SHELL_MS / 1000 - 0.01]) {
    const { booms, published, stepShells, fire, shells } = rig();
    fire(true);
    const dt = 1 / 60;
    let t = 0, flipped = false;
    while (t < SHELL_MS / 1000 + 0.5) {
      stepShells(dt);
      t += dt;
      // the phase edge, applied exactly as onRampartPhase would
      // the real build-edge body, lifted from onRampartPhase and executed verbatim
      if (!flipped && t >= beforeEdge) { flipped = true; applyBuildEdge(shells); }
    }
    assert.equal(booms.length, 1, `fired ${beforeEdge}s before the edge: expected one crater, got ${booms.length}`);
    assert.equal(published.length, 1, `fired ${beforeEdge}s before the edge: the boom was not published`);
  }
});

test('the pre-fix edge behaviour still destroys the shot (the bug this replaces)', () => {
  // Keeps the original defect reproducible. If this ever stops failing, the rig has stopped
  // modelling the thing the fix is about and the test above stops being evidence.
  const { booms, published, stepShells, fire, shells } = rig();
  fire(true);
  const dt = 1 / 60;
  let t = 0, wiped = false;
  while (t < SHELL_MS / 1000 + 0.5) {
    stepShells(dt);
    t += dt;
    if (!wiped && t >= 0.3) { shells.length = 0; wiped = true; }   // the old build branch, verbatim
  }
  assert.equal(booms.length, 0, 'sanity: the old wipe should destroy the shell');
  assert.equal(published.length, 0, 'sanity: the old wipe should publish nothing');
});

test('a shell that reaches its target lands exactly once', () => {
  const { booms, published, stepShells, fire, shells } = rig();
  fire(true);
  for (let i = 0; i < 600; i++) stepShells(1 / 60);   // ten seconds, far past arrival
  assert.equal(booms.length, 1, 'the shell landed more than once');
  assert.equal(published.length, 1);
  assert.equal(shells.length, 0, 'a landed shell must be removed from the flight list');
});

test("only the firer publishes; someone else's shell craters locally without re-broadcasting", () => {
  const { booms, published, stepShells, fire } = rig();
  fire(false);                                   // mine: false — a peer's shell we are rendering
  for (let i = 0; i < 600; i++) stepShells(1 / 60);
  assert.equal(booms.length, 1, 'a remote shell should still crater locally');
  assert.equal(published.length, 0, 'a remote shell must not be re-published, or booms would echo');
});

test('the block rollover is still where shells are cleared', () => {
  // Dropping the phase-edge wipe must not leave shells surviving a whole new round.
  const round = race.match(/setTimeout\(\(\) => \{ \$\('podium'\)[\s\S]*?\}, 7000\);/)?.[0];
  assert.ok(round, 'could not find the block rollover reset');
  assert.match(round, /shells\.length = 0/, 'the rollover no longer clears shells');
});
