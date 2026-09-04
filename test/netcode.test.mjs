// Static guards on the relay wiring. These encode bugs that actually shipped, so a future
// refactor can reintroduce them only on purpose. No network — these run on every PR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { race, GAME_RELAYS, PROFILE_RELAYS, KINDS, published, isEphemeral } from './source.mjs';

test('every game relay is a wss:// url', () => {
  for (const url of [...GAME_RELAYS, ...PROFILE_RELAYS]) {
    assert.match(url, /^wss:\/\//, `${url} must be wss://`);
  }
});

test('the live tick/event subscription does not filter on the client clock', () => {
  // The bug: `since: Math.floor(Date.now()/1000) - 8`. A rider whose clock runs fast stamps
  // future created_at values but filters on that same fast clock, so honestly-stamped peers
  // fall outside the window and the grid renders empty. No error, EOSE still fires.
  const call = race.match(/pool\.subscribeMany\(GAME_RELAYS,\s*\[([\s\S]*?)\]\s*,\s*\{/);
  assert.ok(call, 'could not locate the subscribeMany call');
  const momentary = call[1]
    .split('},')
    .find(f => f.includes('K_TICK') || f.includes('K_EVT'));
  assert.ok(momentary, 'could not find the K_TICK/K_EVT filter');
  assert.doesNotMatch(momentary, /Date\.now\(\)/,
    'the momentary filter must not derive a bound from the client clock — use limit: 0');
  assert.match(momentary, /limit:\s*0/,
    'the momentary filter should ask for live-only with limit: 0');
});

test('momentary kinds stay in the ephemeral range', () => {
  // Ticks and events are fire-and-forget. If one is moved into a stored range it is written to
  // disk forever, per rider, with no supersede — the relay operator pays for it.
  for (const name of ['K_TICK', 'K_EVT']) {
    assert.ok(isEphemeral(KINDS[name]),
      `${name} = ${KINDS[name]} must be ephemeral (20000-29999) or every tick is stored forever`);
  }
});

test('stored kinds that guests can publish carry an expiration', () => {
  // A disposable session key means supersede reclaims nothing: every page load is a new author.
  // NIP-40 expiry is then the only thing bounding what the relay keeps.
  const presence = race.match(/kind:\s*K_PRESENCE[\s\S]{0,400}/);
  const tagsBlock = race.match(/const tags = \[[\s\S]{0,300}?\];/);
  assert.ok(tagsBlock, 'could not find the presence tag block');
  assert.match(tagsBlock[0], /'expiration'/,
    'K_PRESENCE is addressable and guest-published; it must carry a NIP-40 expiration');
  assert.ok(presence, 'could not find the presence publish');
});

test('replayed history cannot reach the kill/death counters', () => {
  // Relays that store ephemeral kinds (strfry keeps them ~5min) replay a finished round into a
  // fresh join. Without this guard those die/kill events are applied as live and inflate K/D.
  const guard = race.indexOf('if (!net.ready) return;');
  const killCounter = race.indexOf('local.kills++');
  const claimBranch = race.indexOf("if (e.kind === K_CLAIM)");
  assert.ok(guard > -1, 'the pre-EOSE guard is missing from onevent');
  assert.ok(killCounter > -1, 'could not find the kill counter');
  assert.ok(guard < killCounter, 'the pre-EOSE guard must sit upstream of the kill counter');
  assert.ok(claimBranch > -1 && claimBranch < guard,
    'the guard must sit after the K_CLAIM branch so historical claims still resolve pre-EOSE');
});

test('a dropped subscription is recovered', () => {
  // nostr-tools 2.10.4 has no reconnect of its own: without this a dropped sub stays dropped
  // and the rider silently stops seeing anyone for the rest of the session.
  assert.match(race, /onclose:/, 'subscribeMany needs an onclose handler to resubscribe');
  assert.match(race, /net\.gen/, 'the resubscribe must be generation-guarded against stale closes');
});

test('every published kind is declared as a constant', () => {
  assert.ok(published.length >= 5, `expected the game's published kinds, found ${published.length}`);
  assert.doesNotMatch(race, /kind:\s*\d{3,}/,
    'publish with a named K_* constant, not a bare kind number');
});
