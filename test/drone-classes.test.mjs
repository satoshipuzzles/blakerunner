// Drone classes: dumb / medium / smart, each with a reason, none of them perfect.
//
// Like drones.test.mjs, these lift the real brain out of game/race.js and run it against stubs
// rather than restating it — a restated copy keeps passing after the source drifts. The last test
// runs the PRE-CLASS brain verbatim on the same boards and shows it fails them, so if these ever
// stop discriminating, that one goes green and says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { race, MAX_BOTS } from './source.mjs';

const grab = (re, what) => {
  const m = race.match(re);
  assert.ok(m, `could not find ${what} in game/race.js`);
  return m[0];
};

const lift = names => names.map(name => {
  const at = race.indexOf(`function ${name}(`);
  assert.ok(at > -1, `could not find ${name} in game/race.js`);
  let i = race.indexOf('{', at), depth = 0;
  do { if (race[i] === '{') depth++; else if (race[i] === '}') depth--; i++; } while (depth > 0 && i < race.length);
  return race.slice(at, i);
}).join('\n');

// World constants come from the source too, so a resized grid cannot silently invalidate these.
const COLS = Number(grab(/const COLS = (\d+)/, 'COLS').match(/\d+/)[0]);
const ROWS = Number(race.match(/ROWS = (\d+)/)[1]);
const SPEED = Number(race.match(/const SPEED = ([\d.]+)/)[1]);
const idx = (cx, cy) => cy * COLS + cx;

const DECLS = [
  grab(/const DIRS = \[\[[\s\S]*?\]\];/, 'DIRS'),
  grab(/const DRONE_CLASSES = \[[\s\S]*?\n\];/, 'DRONE_CLASSES'),
  grab(/const DRONE_CLASS_OF = \[[^\]]*\];/, 'DRONE_CLASS_OF'),
  grab(/const droneClass = [^\n]+/, 'droneClass'),
  grab(/const WHY_ROAM = [^\n]+/, 'the WHY_ constants'),
  grab(/const DRONE_WHY = \[[^\]]*\];/, 'DRONE_WHY'),
  grab(/const droneNote = [^\n]+/, 'droneNote'),
].join('\n');

const EXPORTS = `return { driveDrone, droneBlocked, droneSteer, droneHome, droneThreat, droneQuarry,
  droneClass, droneNote, DRONE_CLASSES, DRONE_CLASS_OF, DRONE_WHY,
  WHY_ROAM, WHY_CLAIM, WHY_HOME, WHY_DODGE, WHY_GUARD, WHY_HUNT };`;

// One shared harness: a real owner[] grid, a real players map, a clock we control.
function brain(){
  const owner = new Uint8Array(COLS * ROWS);
  const players = new Map();
  const clock = { t: 1000 };
  const body = `${DECLS}\n${lift(['droneBlocked', 'droneSteer', 'droneHome', 'droneThreat', 'droneQuarry', 'driveDrone'])}\n${EXPORTS}`;
  const api = new Function('COLS', 'ROWS', 'idx', 'owner', 'players', 'now', body)(
    COLS, ROWS, idx, owner, players, () => clock.t);
  return { ...api, owner, players, clock };
}

// A drone at (70,45) heading down the grid, well clear of every wall.
const mkDrone = (i, over = {}) => {
  const d = { pk: 'drone' + i, i, slot: 1, drone: true, alive: true,
    x: 70.5, y: 45.5, d: 1, nd: 1, tail: [], plan: [], inside: true,
    lastCell: -1, thinkAt: 0, why: undefined, ...over };
  d.cell = idx(Math.floor(d.x), Math.floor(d.y));
  d.tailSet = new Set(d.tail);
  return d;
};
const mkRider = (x, y, tail = []) => ({ pk: 'rider', drone: false, alive: true, x: x + .5, y: y + .5, tail, tailSet: new Set(tail) });
// A 5x5 home plot at (48..52, 43..47). Wide enough that droneHome's stride-3 sweep of owner[]
// cannot step over it, which a single cell can be.
const giveLand = (owner, slot = 1) => { for (let y = 43; y <= 47; y++) for (let x = 48; x <= 52; x++) owner[idx(x, y)] = slot; };

// Math.random is a module global, so it is swapped rather than injected. `0` makes every
// probability test fire (a slip roll of 0 is below every class's slip), `.999` makes none fire.
const withRandom = (v, fn) => {
  const real = Math.random;
  Math.random = typeof v === 'function' ? v : () => v;
  try { return fn(); } finally { Math.random = real; }
};

const byKey = (B, key) => {
  const i = [...Array(MAX_BOTS).keys()].find(i => B.droneClass(i).key === key);
  assert.ok(i !== undefined, `no drone index maps to the ${key} class`);
  return i;
};

test('every class is imperfect: non-zero slip and a non-zero reaction delay', () => {
  // The literal requirement — "never too perfect". A class that always decides, and decides
  // instantly, is a wall to run into rather than a rider to practise against.
  const { DRONE_CLASSES } = brain();
  assert.equal(DRONE_CLASSES.length, 3, 'dumb, medium and smart');
  for (const c of DRONE_CLASSES){
    assert.ok(c.slip > 0, `${c.key} must be able to fumble a decision (slip ${c.slip})`);
    assert.ok(c.slip < .5, `${c.key} slip ${c.slip} is so high it would barely steer`);
    assert.ok(c.think > 0, `${c.key} must take time to react (think ${c.think})`);
    // A drone whose reaction delay outruns its own lookahead cannot see far enough to use it.
    const cellsPerThink = SPEED * c.think / 1000;
    assert.ok(c.look >= cellsPerThink, `${c.key} covers ${cellsPerThink.toFixed(1)} cells per think but only looks ${c.look} ahead`);
  }
});

test('the table is ordered: dumb sees less, stays out longer, reacts slower, fumbles more', () => {
  // Guards against the classes being quietly flattened into three copies of one behaviour.
  const [dumb, medium, smart] = brain().DRONE_CLASSES;
  assert.ok(dumb.look < medium.look && medium.look < smart.look, 'lookahead must increase with class');
  assert.ok(dumb.greed > medium.greed && medium.greed > smart.greed, 'greed (tail carried before banking) must decrease');
  assert.ok(dumb.think > medium.think && medium.think > smart.think, 'reaction delay must decrease');
  assert.ok(dumb.slip > medium.slip && medium.slip > smart.slip, 'fumble rate must decrease');
  assert.ok(dumb.guard <= medium.guard && medium.guard <= smart.guard, 'tail-watching must not decrease');
  assert.ok(dumb.hunt <= medium.hunt && medium.hunt <= smart.hunt, 'hunting must not decrease');
  assert.equal(dumb.guard, 0, 'the dumb class must never look back — that is what makes it dumb');
  assert.equal(dumb.hunt, 0, 'the dumb class must never hunt');
  assert.ok(smart.hunt > 0, 'something has to hunt or the flock is still scenery');
  // Sloppier loops for the dumber class: bigger boxes mean longer exposure.
  assert.ok(dumb.box[0] + dumb.box[1] > smart.box[0] + smart.box[1], 'the dumb class must draw the looser loop');
});

test('class comes from the drone index alone, and three drones get three different classes', () => {
  const B = brain();
  assert.equal(B.DRONE_CLASS_OF.length, MAX_BOTS, 'every drone index needs a class');
  for (const c of B.DRONE_CLASS_OF) assert.ok(c >= 0 && c < B.DRONE_CLASSES.length, `class index ${c} out of range`);
  // Pure function of i: this is the whole reason the class costs nothing on the wire. Every
  // client must derive the same label for drone 3 without being told.
  for (let i = 0; i < MAX_BOTS; i++) assert.equal(B.droneClass(i), B.droneClass(i));
  assert.equal(new Set([0, 1, 2].map(i => B.droneClass(i).key)).size, 3,
    'the first three indices must cover all three classes, or a 3-drone grid is single-class');
  // Indices arrive off the wire; applyFlock bounds them, but droneClass must not blow up either.
  for (const i of [-1, MAX_BOTS, 999]) assert.ok(B.droneClass(i), `droneClass(${i}) must still return a class`);
});

test('the reflex survives a guaranteed fumble: no class walks into a wall one cell away', () => {
  // The reflex sits ahead of both the cadence gate and the slip roll on purpose. Planning is what
  // a drone should be bad at; one that walks into a wall it is already touching reads as broken.
  const B = brain();
  for (let i = 0; i < MAX_BOTS; i++){
    // At x=1.5 heading left (d=2) the next cell is the wall margin.
    const p = mkDrone(i, { x: 1.5, y: 45.5, d: 2, nd: 2 });
    withRandom(0, () => B.driveDrone(p));   // 0 < slip for every class, so the decision is fumbled
    assert.notEqual(p.nd, 2, `${B.droneClass(i).key} drone must turn off the wall even on a fumbled think`);
    assert.equal(p.why, B.WHY_DODGE, 'and it must say that is what it is doing');
  }
});

test('a fumbled think costs the drone the decision', () => {
  // slip is load-bearing, not decoration: the same board, the same drone, one roll apart.
  const B = brain();
  const i = byKey(B, 'smart');
  const board = () => {
    const p = mkDrone(i);
    B.players.set(p.pk, p);
    B.players.set('rider', mkRider(90, 45, [idx(78, 45), idx(79, 45), idx(80, 45), idx(81, 45)]));
    return p;
  };
  const fumbled = board();
  withRandom(0, () => B.driveDrone(fumbled));
  assert.notEqual(fumbled.why, B.WHY_HUNT, 'a fumbled think must not reach the hunt branch');
  B.players.clear();
  const clean = board();
  withRandom(.999, () => B.driveDrone(clean));
  assert.equal(clean.why, B.WHY_HUNT, 'the same board without the fumble must hunt — otherwise this test proves nothing');
});

test('the sharp class hunts a rival trail in reach; the drifter walks past it', () => {
  // Entering another rider's tail wipes THEM out (enterCell), so a trail nearby is a kill, not a
  // hazard. Noticing that is the top of the skill ladder.
  const B = brain();
  const run = key => {
    B.players.clear();
    const p = mkDrone(byKey(B, key));
    B.players.set(p.pk, p);
    B.players.set('rider', mkRider(90, 45, [idx(78, 45), idx(79, 45), idx(80, 45), idx(81, 45)]));
    withRandom(.999, () => B.driveDrone(p));
    return p;
  };
  const smart = run('smart');
  assert.equal(smart.why, B.WHY_HUNT);
  assert.equal(smart.nd, 0, 'and it must actually turn toward the trail, not just say so');
  assert.notEqual(run('dumb').why, B.WHY_HUNT, 'the dumb class must not hunt');
  assert.notEqual(run('medium').why, B.WHY_HUNT, 'the medium class must not hunt either');
});

test('a rider closing on its trail sends a guarding class home; the drifter keeps going', () => {
  // The only way a drone loses ground. A tail hanging out at (70,35..44) with a rider standing
  // on it, and home over at x=50.
  const B = brain();
  const tail = [];
  for (let y = 35; y <= 44; y++) tail.push(idx(70, y));
  const run = key => {
    B.players.clear();
    B.owner.fill(0); giveLand(B.owner);
    const p = mkDrone(byKey(B, key), { inside: false, tail });
    B.players.set(p.pk, p);
    B.players.set('rider', mkRider(70, 40));
    withRandom(.999, () => B.driveDrone(p));
    return p;
  };
  const smart = run('smart');
  assert.equal(smart.why, B.WHY_GUARD, 'a guarding class must notice and break for home');
  assert.equal(smart.nd, 2, 'home is to the west, so it must turn west');
  const dumb = run('dumb');
  assert.notEqual(dumb.why, B.WHY_GUARD, 'guard 0 means it never looks back');
  assert.equal(dumb.nd, 1, 'and it holds its heading straight past the threat');
});

test('a tail past the class greed goes and banks itself', () => {
  const B = brain();
  const i = byKey(B, 'dumb');
  const greed = B.droneClass(i).greed;
  B.owner.fill(0); giveLand(B.owner);
  const tail = [];
  for (let k = 0; k <= greed; k++) tail.push(idx(70, 44 - (k % 40)));
  const p = mkDrone(i, { inside: false, tail });
  B.players.set(p.pk, p);
  withRandom(.999, () => B.driveDrone(p));
  assert.equal(p.why, B.WHY_HOME);
  assert.equal(p.nd, 2, 'home is west of the drone');
});

test('decisions are gated on the class cadence, not taken every frame', () => {
  // The reaction delay only means something if a second call inside the window is a no-op.
  const B = brain();
  const i = byKey(B, 'smart');
  const p = mkDrone(i);
  B.players.set(p.pk, p);
  withRandom(.999, () => B.driveDrone(p));
  assert.ok(p.thinkAt > B.clock.t, 'the first think must arm the cadence');
  p.why = 'untouched';
  B.clock.t += B.droneClass(i).think - 1;
  withRandom(.999, () => B.driveDrone(p));
  assert.equal(p.why, 'untouched', 'a second call inside the window must not re-decide');
  B.clock.t += 2;
  withRandom(.999, () => B.driveDrone(p));
  assert.notEqual(p.why, 'untouched', 'and it must decide again once the window is up');
});

test('another rider\'s trail is the prize, never an obstacle', () => {
  // If droneBlocked ever treated a rival tail as a wall, the hunt branch would steer at a cell it
  // then refuses to enter, and the smart class would be a very busy pacifist.
  const B = brain();
  const p = mkDrone(0);
  const rivalCell = idx(71, 45);
  B.players.set('rider', mkRider(71, 45, [rivalCell]));
  assert.equal(B.droneBlocked({ ...p, x: 70.5, y: 45.5, d: 0 }, 0, 3), false,
    'a rival trail directly ahead must not read as blocked');
  const own = mkDrone(0, { tail: [rivalCell] });
  assert.equal(B.droneBlocked(own, 0, 3), true, 'but the drone\'s OWN trail must');
});

test('the reason rides the wire as one bounded int, and the class rides for free', () => {
  const B = brain();
  const flock = grab(/const flock = iDrive\(\) && drones\.length[\s\S]*?: null;/, 'the flock tick builder');
  assert.match(flock, /d\.why \| 0/, 'the tick must carry the drone\'s current reason');
  const apply = grab(/function applyFlock\([\s\S]*?\n}/, 'applyFlock');
  assert.match(apply, /row\[6\]/, 'the receiver must read the reason');
  assert.match(apply, /DRONE_WHY\[row\[6\] \| 0\] !== undefined/,
    'an out-of-range reason off the wire must fall back, not index past the table');
  assert.match(apply, /row\.length > 6/,
    'the field must be optional so a driver on the old build still renders');
  // Class is derived from the index on every client. If it ever starts being sent, the flock row
  // grows for all seven drones on every one of the 10 ticks a second.
  assert.doesNotMatch(flock, /droneClass|\.cls\b/, 'class must be derived from row[0], never sent');
  assert.match(grab(/const droneClass = [^\n]+/, 'droneClass'), /DRONE_CLASS_OF\[/);
  // And both halves reach the rider's eye.
  const p = mkDrone(byKey(B, 'smart'), { why: B.WHY_HUNT });
  assert.equal(B.droneNote(p), 'sharp · hunting');
  assert.equal(B.droneNote(mkDrone(0, { why: 99 })), `${B.droneClass(0).label} · roaming`,
    'a nonsense reason must still render something');
});

test('the pre-class brain fails both boards, so these tests discriminate', () => {
  // Verbatim driveDrone from 0b63206, the commit before this change. If this ever goes green the
  // boards above have stopped telling the old behaviour from the new one, and every sibling test
  // here stops being evidence.
  const OLD = `function driveDrone(p){
  const cx = Math.floor(p.x), cy = Math.floor(p.y);
  const ahead = (d, n = 1) => { const [dx, dy] = DIRS[d]; return [cx + dx * n, cy + dy * n]; };
  const danger = d => { const [ax, ay] = ahead(d); if (ax < 1 || ay < 1 || ax >= COLS - 1 || ay >= ROWS - 1) return true; const c = idx(ax, ay); return p.tailSet.has(c); };
  if (p.inside && !p.plan.length){ const a = 3 + Math.floor(Math.random() * 8), b = 3 + Math.floor(Math.random() * 8), turnR = Math.random() < .5; let d0 = p.d; for (let i = 0; i < 4; i++){ const [ax, ay] = ahead(d0, a + 1); if (ax > 1 && ay > 1 && ax < COLS - 2 && ay < ROWS - 2) break; d0 = (d0 + 1) % 4; } const t = d => turnR ? (d + 1) % 4 : (d + 3) % 4; p.plan = [[d0, a], [t(d0), b], [t(t(d0)), a + 2], [t(t(t(d0))), 60]]; p.legLeft = p.plan[0][1]; p.nd = p.plan[0][0]; p.lastCell = -1; }
  if (p.cell !== p.lastCell){ p.lastCell = p.cell; if (p.plan.length){ p.legLeft--; if (p.legLeft <= 0){ p.plan.shift(); if (p.plan.length){ p.nd = p.plan[0][0]; p.legLeft = p.plan[0][1]; } } } }
  if (p.inside && p.plan.length && p.plan.length < 3) p.plan = [];
  if (danger(p.nd) || danger(p.d)){ const opts = [(p.d + 1) % 4, (p.d + 3) % 4].filter(d => !danger(d)); if (opts.length){ p.nd = opts[Math.floor(Math.random() * opts.length)]; p.plan = p.plan.length ? [[p.nd, 3], [(p.nd + (Math.random() < .5 ? 1 : 3)) % 4, 60]] : []; p.legLeft = 3; } }
  if (!p.inside && p.tail.length > 70){ let best = null, bd = 1e9; for (let i = 0; i < owner.length; i += 3) if (owner[i] === p.slot){ const ox = i % COLS, oy = (i - ox) / COLS; const d = Math.abs(ox - cx) + Math.abs(oy - cy); if (d < bd){ bd = d; best = [ox, oy]; } } if (best){ const pref = Math.abs(best[0] - cx) > Math.abs(best[1] - cy) ? (best[0] > cx ? 0 : 2) : (best[1] > cy ? 1 : 3); if (!danger(pref) && (pref + 2) % 4 !== p.d) p.nd = pref; } }
}`;
  const owner = new Uint8Array(COLS * ROWS);
  const players = new Map();
  const old = new Function('COLS', 'ROWS', 'idx', 'owner', 'players', 'DIRS',
    `${OLD}\nreturn driveDrone;`)(COLS, ROWS, idx, owner, players, [[1, 0], [0, 1], [-1, 0], [0, -1]]);

  // The hunt board: a rival trail eight cells east.
  const hunter = mkDrone(0);
  players.set('rider', mkRider(90, 45, [idx(78, 45), idx(79, 45), idx(80, 45), idx(81, 45)]));
  withRandom(.999, () => old(hunter));
  assert.equal(hunter.why, undefined, 'the old brain has no notion of a reason at all');

  // The guard board: a rider standing on its trail, home to the west.
  players.clear(); giveLand(owner);
  const tail = []; for (let y = 35; y <= 44; y++) tail.push(idx(70, y));
  const guarded = mkDrone(0, { inside: false, tail });
  players.set('rider', mkRider(70, 40));
  withRandom(.999, () => old(guarded));
  assert.equal(guarded.why, undefined);
  assert.equal(guarded.nd, 1, 'the old brain holds its heading straight past a rider on its own tail');
});
