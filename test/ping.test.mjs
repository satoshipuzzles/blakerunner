// The on-screen ping times our own tick coming back off the relay. These run the real
// pingSent/pingEcho/oneWayMs lifted out of race.js, because the failure modes here are all
// bookkeeping: an unbounded map, a stale sample counted as fresh, or a number derived from
// somebody else's clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { race } from './source.mjs';

const num = (name) => {
  // the source writes fractions as `.2`, with no leading zero
  const m = race.match(new RegExp(`\\b${name} = (\\d*\\.?\\d+)`));
  assert.ok(m, `${name} is missing from game/race.js`);
  return Number(m[1]);
};
const PING_TIMEOUT = num('PING_TIMEOUT'), PING_SMOOTH = num('PING_SMOOTH');

const lift = () => {
  const parts = ['pingSent', 'pingEcho'].map(n => {
    const m = race.match(new RegExp(`function ${n}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`));
    assert.ok(m, `${n} is missing from game/race.js`);
    return m[0];
  });
  const oneWay = race.match(/const oneWayMs = [^\n]+/)?.[0];
  assert.ok(oneWay, 'oneWayMs is missing from game/race.js');
  let t = 0;
  const body = `const pings = new Map(); const ping = { ms: 0, lost: 0 }; const now = () => clock.t;
    ${parts.join('\n')}\n${oneWay}
    return { pings, ping, pingSent, pingEcho, oneWayMs };`;
  const clock = { t: 0 };
  const api = new Function('clock', 'PING_TIMEOUT', 'PING_SMOOTH', body)(clock, PING_TIMEOUT, PING_SMOOTH);
  return { ...api, clock };
};

test('a round trip becomes the ping, smoothed toward later samples', () => {
  const { pings, ping, pingSent, pingEcho, clock } = lift();
  clock.t = 1000; pingSent('a', 1000);
  clock.t = 1080; pingEcho('a');
  assert.equal(ping.ms, 80, 'first sample should be taken whole, not blended with a zero');
  assert.equal(pings.size, 0, 'an echoed id must be dropped');

  clock.t = 2000; pingSent('b', 2000);
  clock.t = 2180; pingEcho('b');
  assert.equal(ping.ms, 80 + (180 - 80) * PING_SMOOTH);
  assert.ok(ping.ms > 80 && ping.ms < 180, 'smoothing should move toward the new sample, not jump to it');
});

test('an id we never published contributes nothing', () => {
  const { ping, pingEcho } = lift();
  pingEcho('someone-elses-event-id');
  assert.equal(ping.ms, 0);
});

test('a replay of our own tick can be counted at most once, and not if it is stale', () => {
  const { ping, pingEcho, pingSent, clock } = lift();
  clock.t = 0; pingSent('a', 0);
  clock.t = 50; pingEcho('a');
  assert.equal(ping.ms, 50);
  clock.t = 9000; pingEcho('a');                    // the relay hands our own event back again
  assert.equal(ping.ms, 50, 'a replayed id must not be measured twice');

  // and an echo that arrives after the timeout is discarded rather than smeared into the average
  clock.t = 10000; pingSent('b', 10000);
  clock.t = 10000 + PING_TIMEOUT + 1; pingEcho('b');
  assert.equal(ping.ms, 50, 'an echo slower than PING_TIMEOUT must not count');
});

test('outstanding ids are swept, so the map cannot grow without bound', () => {
  const { pings, ping, pingSent } = lift();
  for (let i = 0; i < 500; i++) pingSent('id' + i, i * 100);   // 10 Hz, nothing ever echoes
  // everything older than the timeout is gone; what is left is one timeout's worth of ticks
  const newest = 499 * 100;
  for (const t of pings.values()) assert.ok(newest - t <= PING_TIMEOUT, 'swept map still holds an entry older than PING_TIMEOUT');
  assert.ok(pings.size <= PING_TIMEOUT / 100 + 1, `map held ${pings.size} entries`);
  assert.ok(ping.lost > 0, 'unanswered ticks should be counted as lost');
});

test('the sweep relies on Map insertion order, so it must break on the first live entry', () => {
  // pingSent walks the map and stops at the first entry inside the window. That is only correct
  // because Maps iterate in insertion order and we insert in time order; if the loop ever became
  // a filter over the whole map it would be O(n) per tick instead of O(swept).
  const src = race.match(/function pingSent\([^)]*\)\{[\s\S]*?\n\}/)[0];
  assert.match(src, /break/, 'pingSent no longer short-circuits its sweep');
});

test('one-way delay is half the round trip and is capped', () => {
  const { ping, oneWayMs } = lift();
  ping.ms = 0; assert.equal(oneWayMs(), 0, 'no measurement means no compensation');
  ping.ms = 80; assert.equal(oneWayMs(), 40);
  ping.ms = 4000; assert.equal(oneWayMs(), 150, 'a wild sample must not fling riders across the grid');
});

test('extrapolation compensates for transit and stays inside the 350 ms cap', () => {
  const m = race.match(/const ahead = Math\.min\(([^;]+)\);/);
  assert.ok(m, 'the remote-rider glide no longer computes `ahead`');
  assert.match(m[1], /oneWayMs\(\)/, 'ahead does not account for transit time');
  assert.match(m[1], /\.35/, 'the 350 ms extrapolation cap is gone');
  // oneWayMs caps at 150 ms, so even a pathological ping cannot push `ahead` past the outer cap
  const ahead = (sinceArrival, oneWay) => Math.min((sinceArrival + oneWay) / 1000, .35);
  assert.equal(ahead(0, 150), .15);
  assert.equal(ahead(5000, 150), .35);
});

test('our own events are discarded before the signature check, not after', () => {
  // Verifying an event we signed and are about to drop is pure waste — it is the whole inbound
  // verification cost when riding alone. Order matters, so assert on order.
  const sub = race.slice(race.indexOf('net.sub = pool.subscribeMany'));
  const handler = sub.slice(0, sub.indexOf('oneose:'));
  const mine = handler.indexOf('e.pubkey === me.sessPub');
  const verify = handler.indexOf('verifyEvent(e)');
  assert.ok(mine > -1 && verify > -1, 'could not find both checks in the tick/event handler');
  assert.ok(mine < verify, 'own-event check must come before verifyEvent');
  // and the events we do act on must still be verified
  assert.match(handler, /if \(!verifyEvent\(e\)\) return;/, 'inbound events are no longer verified at all');
});

test('the ping never renders a number it has not measured', () => {
  const src = race.match(/function renderPing\(\)\{[\s\S]*?\n\}/)?.[0];
  assert.ok(src, 'renderPing is missing from game/race.js');
  assert.match(src, /!ping\.ms/, 'renderPing does not guard on having a measurement');
  assert.match(src, /'…'/, 'renderPing should show an ellipsis before the first round trip');
});
