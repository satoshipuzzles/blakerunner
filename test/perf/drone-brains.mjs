// Do the three drone classes actually play differently, or do they just have different labels?
//
// Node only, no browser, no network. Lifts the REAL brain and the REAL movement/capture/kill code
// out of game/race.js — driveDrone, stepPlayer, enterCell, capture, die, spawn — and runs seven
// drones on a real owner[] grid for six simulated minutes at 60 fps, with nothing stubbed except
// the DOM, the relays and the effects.
//
// This measures rather than asserts. The mechanism is pinned by test/drone-classes.test.mjs,
// which runs in CI; the point of this script is the OUTCOME, which is statistical and would be a
// flaky gate. Run it after touching DRONE_CLASSES — if the ordering below stops holding, the dial
// you moved did not do what you thought.
//
//   node test/perf/drone-brains.mjs            # 5 rounds
//   ROUNDS=20 MINUTES=10 node test/perf/drone-brains.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const race = readFileSync(fileURLToPath(new URL('../../game/race.js', import.meta.url)), 'utf8');
const ROUNDS = Number(process.env.ROUNDS || 5), MINUTES = Number(process.env.MINUTES || 6);

const lift = names => names.map(name => {
  const at = race.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`could not find ${name} in game/race.js`);
  let i = race.indexOf('{', at), depth = 0;
  do { if (race[i] === '{') depth++; else if (race[i] === '}') depth--; i++; } while (depth > 0 && i < race.length);
  return race.slice(at, i);
}).join('\n');
const grab = re => { const m = race.match(re); if (!m) throw new Error(`could not find ${re} in game/race.js`); return m[0]; };

const COLS = Number(race.match(/const COLS = (\d+)/)[1]), ROWS = Number(race.match(/ROWS = (\d+)/)[1]);
const MAX_BOTS = Number(race.match(/MAX_BOTS = (\d+)/)[1]);
const idx = (cx, cy) => cy * COLS + cx;
const stub = () => {};

// SPEED/MAX_TAIL/RESPAWN_MS all live on one `const` line in the source, so that whole line is
// pulled in as a declaration rather than passed as parameters — passing them too would redeclare.
const decls = [
  grab(/const DIRS = \[\[[\s\S]*?\]\];/),
  grab(/const SPEED = [^\n]+/),
  grab(/const DRONE_CLASSES = \[[\s\S]*?\n\];/),
  grab(/const DRONE_CLASS_OF = \[[^\]]*\];/),
  grab(/const droneClass = [^\n]+/),
  grab(/const WHY_ROAM = [^\n]+/),
  grab(/const DRONE_WHY = \[[^\]]*\];/),
].join('\n');
const fns = lift(['droneBlocked', 'droneSteer', 'droneHome', 'droneThreat', 'droneQuarry',
  'driveDrone', 'capture', 'die', 'enterCell', 'stepPlayer', 'spawn', 'clearLand']);

function round(){
  const owner = new Uint8Array(COLS * ROWS);
  const players = new Map();
  const clock = { t: 0 };
  const env = new Function(
    'COLS', 'ROWS', 'CELL', 'idx', 'owner', 'players', 'now', 'rings',
    'local', 'me', 'net', 'iDrive', 'pub', 'signAsSess', 'K_EVT', 'roomTag', 'rleMine', 'label',
    'feed', 'killFx', 'colorOf', 'sendLand',
    `${decls}\n${fns}\nreturn { driveDrone, stepPlayer, spawn, droneClass, DRONE_WHY };`
  )(
    COLS, ROWS, 22, idx, owner, players, () => clock.t, [],
    { pk: 'local' }, { sessPub: 'me' }, { ready: false }, () => true, stub, stub, 21111, () => 't',
    () => '', p => p.pk, stub, stub, () => '#fff', stub);

  const drones = [];
  for (let i = 0; i < MAX_BOTS; i++){
    const d = { pk: 'drone' + i, i, slot: i + 1, drone: true, x: 0, y: 0, d: 0, nd: 0,
      cell: -1, lastCell: -1, tail: [], tailSet: new Set(), alive: false, kills: 0, deaths: 0,
      last: 0, boostUntil: 0, diedAt: 0, plan: [], inside: true, why: 0, thinkAt: 0 };
    players.set(d.pk, d); drones.push(d); env.spawn(d);
  }

  const dt = 1 / 60, FRAMES = Math.round(60 * 60 * MINUTES);
  const claimed = new Map(drones.map(d => [d.i, 0]));
  const why = new Map(drones.map(d => [d.i, new Map()]));
  const held = new Map(drones.map(d => [d.i, 0]));
  for (let f = 0; f < FRAMES; f++){
    clock.t += dt * 1000;
    for (const p of drones){
      if (!p.alive){ if (clock.t - p.diedAt > 2500) env.spawn(p); continue; }
      env.driveDrone(p); env.stepPlayer(p, dt);
      const w = why.get(p.i); w.set(p.why, (w.get(p.why) || 0) + 1);
    }
    // Sample land once a second and accumulate the GAINS. A wipe-out clears the grid, so a
    // point-in-time reading at the end would score a drone on whether it happened to be alive.
    if (f % 60 === 0){
      const n = new Map(drones.map(d => [d.slot, 0]));
      for (let i = 0; i < owner.length; i++) if (n.has(owner[i])) n.set(owner[i], n.get(owner[i]) + 1);
      for (const p of drones){
        const cur = n.get(p.slot), was = held.get(p.i);
        if (cur > was) claimed.set(p.i, claimed.get(p.i) + (cur - was));
        held.set(p.i, cur);
      }
    }
  }
  return drones.map(p => ({ i: p.i, key: env.droneClass(p.i).key, label: env.droneClass(p.i).label,
    claimed: claimed.get(p.i), kills: p.kills, deaths: p.deaths,
    why: [...why.get(p.i)].sort((a, b) => b[1] - a[1]).map(([k, n]) => [env.DRONE_WHY[k], n / FRAMES]) }));
}

const KEYS = ['dumb', 'medium', 'smart'];
const rounds = Array.from({ length: ROUNDS }, round);
const per = new Map(KEYS.map(k => [k, { claimed: [], kills: [], deaths: [], why: new Map(), label: '' }]));
for (const r of rounds){
  const byKey = new Map(KEYS.map(k => [k, { claimed: 0, kills: 0, deaths: 0, n: 0 }]));
  for (const d of r){
    const a = byKey.get(d.key); a.claimed += d.claimed; a.kills += d.kills; a.deaths += d.deaths; a.n++;
    const w = per.get(d.key).why; per.get(d.key).label = d.label;
    for (const [name, share] of d.why) w.set(name, (w.get(name) || 0) + share);
  }
  for (const k of KEYS){ const a = byKey.get(k), s = per.get(k);
    s.claimed.push(a.claimed / a.n); s.kills.push(a.kills / a.n); s.deaths.push(a.deaths / a.n); }
}
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const rng = a => `${Math.min(...a).toFixed(0)}–${Math.max(...a).toFixed(0)}`;

console.log(`${ROUNDS} rounds × ${MINUTES} simulated minutes, ${MAX_BOTS} drones, no human rider.`);
console.log('Per drone, averaged over the round. Range across rounds in brackets.\n');
console.log('  class   label     claimed cells        kills           deaths');
for (const k of KEYS){
  const s = per.get(k);
  console.log(`  ${k.padEnd(7)} ${s.label.padEnd(8)} ${mean(s.claimed).toFixed(0).padStart(6)} [${rng(s.claimed).padEnd(11)}] ${mean(s.kills).toFixed(1).padStart(5)} [${rng(s.kills).padEnd(7)}] ${mean(s.deaths).toFixed(1).padStart(6)} [${rng(s.deaths)}]`);
}
console.log('\n  reasons given, share of frames alive:');
for (const k of KEYS){
  const s = per.get(k);
  const tot = [...s.why.values()].reduce((a, b) => a + b, 0) || 1;
  console.log(`  ${k.padEnd(7)} ${[...s.why].sort((a, b) => b[1] - a[1]).map(([n, v]) => `${n} ${(v / tot * 100).toFixed(0)}%`).join(', ')}`);
}
