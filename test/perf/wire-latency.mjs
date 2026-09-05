// What does a tick actually cost on the wire, and can a client measure its own round trip?
//
// Node only, needs the network. Answers three things the game can't guess at:
//   1. Does the relay echo an ephemeral back to the socket that published it? An on-screen ping
//      built on self-echo is dead in the water if it doesn't.
//   2. What is the publish -> delivery round trip, from a second socket (what another rider
//      actually waits) and from the publishing socket (what a self-echo ping would read)?
//   3. What do schnorr sign and verify cost per event? At TICK_HZ x riders those run in the
//      frame loop, and they are not free.
//
// Every event carries distinct content: identical kind/created_at/tags/content from one key
// produce identical ids, and a relay that dedupes then makes delivery look broken.
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const race = readFileSync(fileURLToPath(new URL('../../game/race.js', import.meta.url)), 'utf8');
const relays = process.env.RELAYS ? process.env.RELAYS.split(',')
  : [...race.match(/const DEFAULT_GAME_RELAYS = \[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
const K_TICK = Number(race.match(/K_TICK = (\d+)/)[1]);
const TICK_HZ = Number(race.match(/TICK_HZ = (\d+)/)[1]);
const N = Number(process.env.N || 40);
const ROOM = 'hodland-r-latencyprobe' + process.pid;

const sk = generateSecretKey(), pk = getPublicKey(sk);
console.log(`relays ${relays.join(', ')}\nkind ${K_TICK}  tick ${TICK_HZ} Hz  probe key ${pk.slice(0, 8)}  n=${N}\n`);

// ---- 1/2: echo + round trip ------------------------------------------------
// Two independent pools so "publisher's socket" and "someone else's socket" are really separate
// connections, not two subscriptions multiplexed onto one.
const pubPool = new SimplePool(), obsPool = new SimplePool();
const sentAt = new Map();
const seen = { self: new Map(), other: new Map() };
const filter = { kinds: [K_TICK], '#t': [ROOM], limit: 0 };
const ready = {};
const sub = (pool, which) => new Promise(res => {
  const s = pool.subscribeMany(relays, [filter], {
    onevent: e => { const t = sentAt.get(e.id); if (t !== undefined && !seen[which].has(e.id)) seen[which].set(e.id, Number(process.hrtime.bigint() - t) / 1e6); },
    oneose: () => res(s),
  });
  ready[which] = s;
});
await Promise.all([sub(pubPool, 'self'), sub(obsPool, 'other')]);
console.log('both subscriptions EOSE, publishing…');

for (let i = 0; i < N; i++){
  const ev = finalizeEvent({ kind: K_TICK, created_at: Math.floor(Date.now() / 1000),
    tags: [['t', ROOM]], content: JSON.stringify({ x: i, y: i * 2, d: i & 3, seq: i }) }, sk);
  sentAt.set(ev.id, process.hrtime.bigint());
  for (const p of pubPool.publish(relays, ev)) p.catch(() => {});
  await new Promise(r => setTimeout(r, 1000 / TICK_HZ));
}
await new Promise(r => setTimeout(r, 3000));

const stat = m => {
  const v = [...m.values()].sort((a, b) => a - b);
  if (!v.length) return null;
  const q = p => v[Math.min(v.length - 1, Math.floor(v.length * p))];
  return { n: v.length, min: v[0], p50: q(.5), p90: q(.9), max: v[v.length - 1] };
};
for (const which of ['self', 'other']){
  const s = stat(seen[which]);
  const label = which === 'self' ? 'publisher socket (what a self-echo ping reads)' : 'second socket (what another rider waits)';
  console.log(s
    ? `${label}\n  delivered ${s.n}/${N}   min ${s.min.toFixed(1)}  p50 ${s.p50.toFixed(1)}  p90 ${s.p90.toFixed(1)}  max ${s.max.toFixed(1)} ms`
    : `${label}\n  delivered 0/${N} — NO ECHO`);
}
pubPool.close(relays); obsPool.close(relays);

// ---- 3: schnorr cost -------------------------------------------------------
const tmpl = { kind: K_TICK, created_at: Math.floor(Date.now() / 1000), tags: [['t', ROOM]],
  content: JSON.stringify({ x: 12.34, y: 56.78, d: 1, a: 1, k: 3, dd: 2, tp: '2f4R12U5L3'.repeat(6) }) };
// nostr-tools memoises verification on the event OBJECT (a `verified` symbol), so re-verifying
// the same object measures a property read, not schnorr. Events off a websocket are always fresh
// objects, so each rep gets a fresh one — this is the difference between 0.00 ms and the truth.
const wire = Array.from({ length: 200 }, (_, i) => JSON.stringify(finalizeEvent({ ...tmpl, content: tmpl.content + i }, sk)));
const time = (fn, reps) => { const t0 = process.hrtime.bigint(); for (let i = 0; i < reps; i++) fn(i); return Number(process.hrtime.bigint() - t0) / 1e6 / reps; };
const signMs = time(i => finalizeEvent({ ...tmpl, content: tmpl.content + i }, sk), 200);
const parseMs = time(i => JSON.parse(wire[i % wire.length]), 200);
const verifyMs = time(i => verifyEvent(JSON.parse(wire[i % wire.length])), 200) - parseMs;
// sanity: a re-verified object should be ~free, which is what caught the mistake above
const cached = finalizeEvent({ ...tmpl, content: 'cached' }, sk); verifyEvent(cached);
const cachedMs = time(() => verifyEvent(cached), 200);
console.log(`\n(JSON.parse ${parseMs.toFixed(3)} ms, re-verify of an already-verified object ${cachedMs.toFixed(3)} ms — memoised, do not measure this)`);
console.log(`\nschnorr  sign ${signMs.toFixed(2)} ms   verify ${verifyMs.toFixed(2)} ms  (nostr-tools 2.10.4, node ${process.version})`);
for (const riders of [2, 4, 8]){
  const inbound = (riders - 1) * TICK_HZ;
  console.log(`  ${riders} riders: ${inbound} inbound ticks/s -> ${(inbound * verifyMs).toFixed(0)} ms/s verifying (${(inbound * verifyMs / 10).toFixed(1)}% of one core), plus ${(TICK_HZ * signMs).toFixed(0)} ms/s signing`);
}
process.exit(0);
