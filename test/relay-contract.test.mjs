// Live contract against the relays the game actually publishes to. Network-dependent, so this
// is not on the PR gate — run it with `npm run test:relays` before changing a kind constant or
// the relay list, and on a schedule to catch a relay changing its policy under you.
//
// This is the check that would have caught coolfeed silently rejecting 4 of the 5 kinds: the
// game kept running only because the other relays carried the traffic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { GAME_RELAYS, published, isEphemeral, isAddressable } from './source.mjs';

const TIMEOUT = 45_000;

const open = url => new Promise((res, rej) => {
  const ws = new WebSocket(url);
  const t = setTimeout(() => rej(new Error(`${url}: open timed out`)), 15_000);
  ws.addEventListener('open', () => { clearTimeout(t); res(ws); });
  ws.addEventListener('error', () => { clearTimeout(t); rej(new Error(`${url}: connect failed`)); });
});

const wait = ms => new Promise(r => setTimeout(r, ms));

// Every probe event must be unique. N events with identical kind/created_at/tags/content from
// one key produce N identical ids; relays that store the kind dedupe them and you measure 1/N
// delivery and read it as broken fanout.
let nonce = 0;
const mkEvent = (sk, kind, tags = []) => finalizeEvent({
  kind, created_at: Math.floor(Date.now() / 1000), tags,
  content: JSON.stringify({ probe: 'blakerunner-ci', n: nonce++ }),
}, sk);

// The gameplay plane is what a guest needs to ride at all: ticks, events, presence. If any
// relay in the list refuses one of these, riders on that relay see a dead grid.
const GAMEPLAY = published.filter(([, k]) => isEphemeral(k) || k === 30078);
// Scoring kinds are deliberately gated on some relays while the score protocol is undecided,
// so per-relay refusal is policy, not breakage. What must hold is that scores land somewhere.
const SCORING = published.filter(([, k]) => !GAMEPLAY.some(([, g]) => g === k));

const publishAll = async (url, kinds) => {
  const ws = await open(url);
  const sk = generateSecretKey();
  const oks = new Map(), byId = new Map();
  ws.addEventListener('message', m => {
    const f = JSON.parse(String(m.data));
    if (f[0] === 'OK') oks.set(f[1], { ok: f[2], reason: f[3] });
  });
  for (const [name, kind] of kinds) {
    const ev = mkEvent(sk, kind, isAddressable(kind)
      ? [['d', 'ci-probe'], ['expiration', String(Math.floor(Date.now() / 1000) + 120)]]
      : [['t', 'blakerunner-ci']]);
    byId.set(ev.id, `${name} (${kind})`);
    ws.send(JSON.stringify(['EVENT', ev]));
    await wait(400);
  }
  await wait(4000);
  ws.close();
  const results = [];
  for (const [id, label] of byId) {
    const r = oks.get(id);
    if (!r) results.push({ label, ok: false, reason: 'no OK frame — relay stayed silent' });
    else results.push({ label, ok: r.ok, reason: r.reason || '' });
  }
  return results;
};

for (const url of GAME_RELAYS) {
  test(`${url} carries the gameplay plane for a guest`, { timeout: TIMEOUT }, async () => {
    const bad = (await publishAll(url, GAMEPLAY)).filter(r => !r.ok)
      .map(r => `${r.label}: ${r.reason}`);
    assert.deepEqual(bad, [],
      `${url} will not carry gameplay:\n  ${bad.join('\n  ')}\n` +
      `A "restricted:" reason means the relay's write gate needs these kinds exempted.`);
  });

  test(`${url} fans out live gameplay between two guests`, { timeout: TIMEOUT }, async () => {
    // An OK is a receipt, not a delivery. This is the only check that proves a second rider
    // actually sees the first one.
    const room = `blakerunner-ci-${Date.now()}-${Math.abs(url.length)}`;
    const ephemeral = published.filter(([, k]) => isEphemeral(k));
    assert.ok(ephemeral.length, 'no ephemeral kinds found to test fanout with');

    const listener = await open(url);
    const seen = new Set();
    listener.addEventListener('message', m => {
      const f = JSON.parse(String(m.data));
      if (f[0] === 'EVENT') seen.add(f[2].id);
    });
    listener.send(JSON.stringify(['REQ', 'ci', {
      kinds: ephemeral.map(([, k]) => k), '#t': [room], limit: 0,
    }]));
    await wait(2000);

    const publisher = await open(url);
    const sk = generateSecretKey();
    const sent = [];
    for (const [name, kind] of ephemeral) {
      const ev = mkEvent(sk, kind, [['t', room]]);
      sent.push([ev.id, `${name} (${kind})`]);
      publisher.send(JSON.stringify(['EVENT', ev]));
      await wait(400);
    }
    await wait(5000);
    listener.close(); publisher.close();

    const missing = sent.filter(([id]) => !seen.has(id)).map(([, label]) => label);
    assert.deepEqual(missing, [],
      `${url} accepted these but never delivered them to a second guest: ${missing.join(', ')}`);
  });
}

test('a guest score lands on at least one relay', { timeout: TIMEOUT * 2 }, async () => {
  // Per-relay gating of the scoring kinds is a deliberate policy call. What would be a real
  // break is every relay refusing them: the leaderboard would stop recording, silently.
  const landed = new Map(SCORING.map(([n, k]) => [`${n} (${k})`, []]));
  for (const url of GAME_RELAYS) {
    for (const r of await publishAll(url, SCORING)) {
      if (r.ok) landed.get(r.label)?.push(url);
    }
  }
  for (const [label, relays] of landed) {
    console.log(`      ${label} accepted by: ${relays.length ? relays.join(', ') : 'NOBODY'}`);
  }
  const orphaned = [...landed].filter(([, r]) => !r.length).map(([l]) => l);
  assert.deepEqual(orphaned, [],
    `no relay in GAME_RELAYS accepts ${orphaned.join(', ')} — scores are being silently dropped`);
});

test('guest identity is disposable, so nothing stored may be unbounded', () => {
  // Guards the storage side of the contract rather than the wire: a fresh key per page load
  // means supersede reclaims nothing, so a stored guest-writable kind needs an expiration.
  for (const [name, kind] of published) {
    if (isEphemeral(kind)) continue;
    assert.ok(kind < 30000 || isAddressable(kind),
      `${name} (${kind}) is stored — confirm the relay can reclaim it`);
  }
});
