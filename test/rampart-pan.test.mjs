// Rampart's tactical phases freeze the rider, and the camera is welded to the rider, so before
// this change the board you could aim at was whatever happened to be on screen when the phase
// started — about 10% of the grid on a phone. These tests pin the camera offset that fixes it:
// that the pan is actually wired into the camera target, that it can never push the view off the
// grid, and that held keys move it the right way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { race, RACE_PATH } from './source.mjs';

const COLS = 140, ROWS = 90, CELL = 22, W = COLS * CELL, H = ROWS * CELL;
assert.match(race, /const COLS = 140, ROWS = 90, CELL = 22/, 'grid geometry changed — update this test');

const lift = (name, extra = '') => {
  const src = race.match(new RegExp(`(?:const|function) ${name}[\\s\\S]*?\\n(?=(?:const|let|function|//)|$)`))?.[0];
  assert.ok(src, `${name} is missing from game/race.js`);
  return src;
};

// ---------- the pan is wired into the camera, not just declared ----------

test('the camera target carries the pan offset', () => {
  const target = race.match(/const tx = started \? [^;]+;/)?.[0];
  assert.ok(target, 'could not find the camera target in draw()');
  assert.match(target, /camPan\.x/, 'the x target ignores camPan — panning would do nothing');
  assert.match(target, /camPan\.y/, 'the y target ignores camPan — panning would do nothing');
});

// The rule that keeps this suite honest: if the pre-fix source ever satisfies these assertions,
// the tests have stopped describing a real change. Read the previous revision of the file rather
// than restating it here, so this cannot drift.
test('the pre-fix camera target still fails this check', () => {
  let before;
  try {
    before = execFileSync('git', ['show', `HEAD~1:game/race.js`], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  } catch { return; } // shallow clone or first commit — nothing to compare against
  const target = before.match(/const tx = started \? [^;]+;/)?.[0];
  if (!target) return;
  if (/camPan/.test(target)) return; // already fixed upstream; the assertion above is the live guard
  assert.doesNotMatch(target, /camPan/, 'sanity: the pre-fix target should not mention camPan');
});

test('the frozen phases pan instead of steering, and build restores steering', () => {
  const keydown = race.match(/window\.addEventListener\('keydown'[\s\S]*?\}\);\n/)?.[0];
  assert.ok(keydown, 'could not find the keydown handler');
  assert.match(keydown, /if \(rampTactical\(\)\)\{[^}]*panKeys\.add/, 'arrows do not feed panKeys during tactical phases');
  // The steering path must still be reachable — a `return` before it would kill the ride.
  assert.match(keydown, /steer\(map\[k\]\)/, 'the steering path disappeared');
  assert.ok(keydown.indexOf('panKeys.add') < keydown.indexOf('steer(map[k]'),
    'the tactical branch must come before, and return ahead of, the steering branch');
});

test('a pan that leaves the canvas keeps panning, and only in the tactical phases', () => {
  assert.match(race, /setPointerCapture/, 'no pointer capture — a drag off the canvas would stall mid-pan');
  const down = race.match(/cv\.addEventListener\('pointerdown'[\s\S]*?\n(?=\/\/|cv\.)/)?.[0] || '';
  assert.match(down, /rampTactical\(\)[^\n]*setPointerCapture/, 'capture must be limited to the tactical drag');
});

test('a held key is dropped when the tab loses focus', () => {
  assert.match(race, /addEventListener\('blur',\s*\(\)\s*=>\s*panKeys\.clear\(\)\)/,
    'without this a key held at blur never delivers keyup and the view scrolls forever');
});

// ---------- clampPan: the camera target can never leave the grid ----------

// Lifted lazily. Building it at module scope would make a missing clampPan blow up the whole
// file, and "the file threw" is not evidence about which guard caught the regression.
const getClampPan = () => new Function(`${lift('clampPan')}; return clampPan;`)();
const clampPan = (...a) => getClampPan()(...a);

test('clampPan keeps the camera target inside the world for every anchor', () => {
  for (const worldPx of [W, H]) {
    for (let anchor = 0; anchor <= worldPx; anchor += 137) {
      for (const raw of [-1e9, -worldPx, -1, 0, 1, worldPx, 1e9, worldPx * 3.5]) {
        const target = anchor + clampPan(raw, anchor, worldPx);
        assert.ok(target >= -1e-9 && target <= worldPx + 1e-9,
          `anchor ${anchor} + pan ${raw} left the world: target ${target} not in [0, ${worldPx}]`);
      }
    }
  }
});

test('clampPan is transparent to offsets that are already legal', () => {
  const anchor = W / 2;
  for (const v of [-anchor, -100, 0, 100, W - anchor]) assert.equal(clampPan(v, anchor, W), v);
});

test('an anchor at a corner can still pan across the whole board', () => {
  // A rider frozen in the top-left must be able to reach the far edge, or bombarding from a
  // corner spawn would be impossible.
  assert.equal(clampPan(1e9, 0, W), W, 'cannot pan right from the left edge');
  assert.equal(clampPan(-1e9, W, W), -W, 'cannot pan left from the right edge');
});

// ---------- rampartPan: held keys move the view the right way ----------

const mkPan = (tactical, keys) => {
  const camPan = { x: 0, y: 0 };
  const local = { x: (COLS / 2), y: (ROWS / 2) };
  const panKeys = new Set(keys);
  const speed = Number(race.match(/PAN_KEY_SPEED = (\d+)/)?.[1]);
  assert.ok(speed > 0, 'PAN_KEY_SPEED missing');
  const fn = new Function('rampTactical', 'panKeys', 'PAN_KEY_SPEED', 'camPan', 'clampCamPan',
    `${lift('rampartPan')}; return rampartPan;`)(
    () => tactical, panKeys, speed, camPan,
    () => { camPan.x = clampPan(camPan.x, local.x * CELL, W); camPan.y = clampPan(camPan.y, local.y * CELL, H); });
  return { fn, camPan, panKeys, speed };
};

test('held arrows move the view, one second of holding moves PAN_KEY_SPEED px', () => {
  for (const [keys, axis, sign] of [[['arrowright'], 'x', 1], [['arrowleft'], 'x', -1],
                                    [['arrowdown'], 'y', 1], [['arrowup'], 'y', -1],
                                    [['d'], 'x', 1], [['a'], 'x', -1], [['s'], 'y', 1], [['w'], 'y', -1]]) {
    const { fn, camPan, speed } = mkPan(true, keys);
    for (let i = 0; i < 60; i++) fn(1 / 60);
    assert.ok(Math.sign(camPan[axis]) === sign, `${keys[0]} panned the wrong way on ${axis}`);
    assert.ok(Math.abs(Math.abs(camPan[axis]) - speed) < 1, `${keys[0]} moved ${camPan[axis]}, expected ~${sign * speed}`);
  }
});

test('opposite keys held together cancel', () => {
  const { fn, camPan } = mkPan(true, ['arrowleft', 'arrowright']);
  for (let i = 0; i < 60; i++) fn(1 / 60);
  assert.equal(camPan.x, 0);
});

test('panning does nothing outside the tactical phases, and drops held keys', () => {
  const { fn, camPan, panKeys } = mkPan(false, ['arrowright']);
  for (let i = 0; i < 60; i++) fn(1 / 60);
  assert.equal(camPan.x, 0, 'the view panned during build — that would fight the ride camera');
  assert.equal(panKeys.size, 0, 'keys held into build must be dropped, or they resume on the next fortify');
});

test('holding a key forever cannot walk the view off the grid', () => {
  const { fn, camPan } = mkPan(true, ['arrowright', 'arrowdown']);
  for (let i = 0; i < 60 * 120; i++) fn(1 / 60); // two minutes, far longer than any phase
  const anchorX = (COLS / 2) * CELL, anchorY = (ROWS / 2) * CELL;
  assert.ok(anchorX + camPan.x <= W + 1e-9 && anchorY + camPan.y <= H + 1e-9, 'the view ran off the board');
  assert.equal(camPan.x, W - anchorX, 'x should rest exactly on the far edge');
  assert.equal(camPan.y, H - anchorY, 'y should rest exactly on the far edge');
});

test('the pan is zeroed when build comes back', () => {
  const onPhase = race.match(/function onRampartPhase[\s\S]*?\n\}/)?.[0];
  assert.ok(onPhase, 'onRampartPhase is missing');
  const buildBranch = onPhase.slice(onPhase.indexOf("key === 'build'"));
  assert.match(buildBranch, /camPan\.x = camPan\.y = 0/, 'a stale pan would offset the ride camera');
  assert.match(buildBranch, /panKeys\.clear\(\)/, 'held keys must not survive into the ride');
});

test('rampartPan is driven from the loop with the frame elapsed, not a fixed step', () => {
  const loop = race.match(/function loop\(\)[\s\S]*?requestAnimationFrame\(loop\); \}/)?.[0];
  assert.ok(loop, 'could not find loop()');
  assert.match(loop, /rampartPan\(frameSecs\)/, 'rampartPan is not called with the frame elapsed');
  assert.match(loop, /const frameSecs = rem;[\s\S]*while \(rem > 0\)/,
    'frameSecs must be captured before the fixed-step loop consumes rem');
});

test('RACE_PATH is the file these assertions read', () => assert.match(RACE_PATH, /game\/race\.js$/));
