// Shared drones: one rider drives the flock and publishes it, everyone else renders it. These lift
// the real authority and flock code out of race.js and run it against stubs, rather than restating
// the logic — a restated copy would keep passing after the source drifted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { race, MAX_BOTS } from './source.mjs';

const lift = names => {
  const src = names.map(name => {
    const at = race.indexOf(`function ${name}(`);
    assert.ok(at > -1, `could not find ${name} in game/race.js`);
    let i = race.indexOf('{', at), depth = 0;
    do { if (race[i] === '{') depth++; else if (race[i] === '}') depth--; i++; } while (depth > 0 && i < race.length);
    return race.slice(at, i);
  }).join('\n');
  return src;
};

// AUTH_STALE_MS and the iDrive arrow are read from source too, so a change to either is caught.
const AUTH_STALE_MS = Number(race.match(/const AUTH_STALE_MS = (\d+)/)?.[1]);
const iDriveSrc = race.match(/const iDrive = [^\n]+/)?.[0];

const mkEnv = ({ me, started, peers }) => {
  const players = new Map();
  for (const [pk, lastAgo] of peers) players.set(pk, { pk, drone: false, last: -lastAgo });
  players.set('drone00', { pk: 'drone00', drone: true, last: 0 });
  const body = `${lift(['droneAuthority'])}\n${iDriveSrc}\nreturn { droneAuthority, iDrive };`;
  return new Function('me', 'started', 'players', 'now', 'AUTH_STALE_MS', body)(
    { sessPub: me }, started, players, () => 0, AUTH_STALE_MS);
};

test('AUTH_STALE_MS is shorter than the 8s peer prune', () => {
  // Handover has to happen well before the renderer drops the departed rider, or the flock
  // freezes for everyone while the old authority is still nominally present.
  assert.ok(Number.isFinite(AUTH_STALE_MS), 'AUTH_STALE_MS not found');
  assert.ok(AUTH_STALE_MS < 8000, `AUTH_STALE_MS ${AUTH_STALE_MS} must be under the 8000ms prune`);
});

test('the lowest live session pubkey drives', () => {
  const { droneAuthority, iDrive } = mkEnv({ me: 'bbbb', started: true, peers: [['aaaa', 100], ['cccc', 100]] });
  assert.equal(droneAuthority(), 'aaaa');
  assert.equal(iDrive(), false, 'a higher pubkey must not drive while a lower one is live');
});

test('we drive when we are the lowest', () => {
  const { droneAuthority, iDrive } = mkEnv({ me: 'aaaa', started: true, peers: [['bbbb', 100]] });
  assert.equal(droneAuthority(), 'aaaa');
  assert.equal(iDrive(), true);
});

test('a stale rider stops counting, so the flock hands over', () => {
  const fresh = mkEnv({ me: 'bbbb', started: true, peers: [['aaaa', 100]] });
  assert.equal(fresh.iDrive(), false, 'while aaaa is live, bbbb must not drive');
  const stale = mkEnv({ me: 'bbbb', started: true, peers: [['aaaa', AUTH_STALE_MS + 500]] });
  assert.equal(stale.droneAuthority(), 'bbbb');
  assert.equal(stale.iDrive(), true, 'once aaaa goes quiet, bbbb takes the flock');
});

test('drones are never considered for authority', () => {
  const { droneAuthority } = mkEnv({ me: 'zzzz', started: true, peers: [] });
  assert.equal(droneAuthority(), 'zzzz', 'the drone entry must not win the sort');
});

test('a lobby with nobody publishing still drives locally', () => {
  // Not started and no live peers: there is no authority to render, so keep the local flock
  // rather than showing an empty grid.
  const { droneAuthority, iDrive } = mkEnv({ me: 'aaaa', started: false, peers: [] });
  assert.equal(droneAuthority(), null);
  assert.equal(iDrive(), true);
});

test('a rider who has not started does not take the flock from one who has', () => {
  const { droneAuthority, iDrive } = mkEnv({ me: 'aaaa', started: false, peers: [['bbbb', 100]] });
  assert.equal(droneAuthority(), 'bbbb', 'only a rider actually publishing ticks can drive');
  assert.equal(iDrive(), false);
});

test('the flock is only published by the driver, and only applied from the authority', () => {
  assert.match(race, /iDrive\(\) && drones\.length/,
    'the flock must only be attached to the tick when we are driving');
  const apply = race.match(/if \(Array\.isArray\(c\.dr\)[^\n]*/)?.[0];
  assert.ok(apply, 'could not find the flock receive branch');
  assert.match(apply, /!iDrive\(\)/, 'must not apply a flock while we are driving');
  assert.match(apply, /e\.pubkey === droneAuthority\(\)/,
    'must only accept a flock from the current authority, or two drivers fight');
});

test('a handover adopts the existing drones instead of re-creating them', () => {
  // mkPlayer would replace the adopted object with a fresh one at 0,0 and teleport the whole
  // flock into the corner the moment anyone took over.
  const ensure = race.match(/function ensureDrones\(\)[\s\S]*?\n}/)?.[0];
  assert.ok(ensure, 'could not find ensureDrones');
  assert.doesNotMatch(ensure, /mkPlayer\(/, 'ensureDrones must adopt, not mkPlayer');
  assert.match(ensure, /adoptDrone\(i\)/);
  assert.match(ensure, /players\.has\(dronePk\(i\)\)/, 'only an unseen drone should be spawned');
});

test('a drone index off the wire cannot address a slot outside the flock', () => {
  const apply = race.match(/function applyFlock\([\s\S]*?\n}/)?.[0];
  assert.ok(apply, 'could not find applyFlock');
  assert.match(apply, /i < 0 \|\| i >= MAX_BOTS/, 'flock rows must bound-check the drone index');
  assert.ok(MAX_BOTS > 0 && MAX_BOTS <= 16, `MAX_BOTS looks wrong: ${MAX_BOTS}`);
});

test('an inherited flock is swept when the local bots setting does not want it', () => {
  // The reported bug: rider A drives 4+ drones, rider B watches with bots=0, A leaves. B becomes
  // the authority, but the adopted drones live in `players` and not in B's `drones` list — the
  // pop loop never reached them, step() exempts drones from the stale prune while driving, and
  // the flock ran forever with no way to turn it off. This drives the real ensureDrones.
  const dronePk = i => 'drone' + i + '0000000000000000000000000000000000000000000000000000000000';
  const body = `${lift(['ensureDrones', 'adoptDrone'])}\nensureDrones(); return players;`;
  const runEnsure = (botsWanted, adopted) => {
    const players = new Map();
    const local = { pk: 'me', drone: false };
    players.set('me', local);
    for (const i of adopted) players.set(dronePk(i), { pk: dronePk(i), drone: true, i, x: 5, y: 5, plan: [] });
    return new Function(
      'players', 'local', 'started', 'now', 'botsWanted', 'drones', 'spawn', 'clearLand', 'dronePk',
      'mkPlayer', 'DRONE_NAMES', 'PATTERNS', 'MAX_BOTS', body)(
      players, local, true, () => 0, botsWanted, [], () => {}, () => {}, dronePk,
      (pk, drone) => { const p = { pk, drone, plan: [] }; players.set(pk, p); return p; },
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], [0], MAX_BOTS);
  };
  const off = runEnsure(0, [0, 1, 2, 3]);
  assert.equal([...off.values()].filter(p => p.drone).length, 0,
    'bots=0 must remove every adopted drone');
  const some = runEnsure(2, [0, 1, 2, 3, 4, 5, 6]);
  const left = [...some.values()].filter(p => p.drone).map(p => p.i).sort();
  assert.deepEqual(left, [0, 1], 'bots=2 must keep exactly drones 0 and 1 of an inherited seven');
});
