// Static guards on the relay wiring. These encode bugs that actually shipped, so a future
// refactor can reintroduce them only on purpose. No network — these run on every PR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { race, GAME_RELAYS, PROFILE_RELAYS, SCORE_RELAYS, KINDS, published, isEphemeral } from './source.mjs';

test('every game relay is a wss:// url', () => {
  for (const url of [...GAME_RELAYS, ...SCORE_RELAYS, ...PROFILE_RELAYS]) {
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
  assert.ok(guard > -1, 'the pre-EOSE guard is missing from onevent');
  assert.ok(killCounter > -1, 'could not find the kill counter');
  assert.ok(guard < killCounter, 'the pre-EOSE guard must sit upstream of the kill counter');
});

test('session claims are not gated by the gameplay EOSE', () => {
  // Claims map a session key to an npub, which is what display names resolve through. They are
  // stored history and must land regardless of the live plane's readiness — so they get their
  // own subscription rather than sharing the guarded gameplay handler.
  const claimSub = race.match(/net\.claimSub = pool\.subscribeMany\(([A-Z_]+), \[([\s\S]*?)\], \{([\s\S]*?)\n  \}\);/);
  assert.ok(claimSub, 'claims should have their own subscription');
  assert.equal(claimSub[1], 'SCORE_RELAYS',
    'claims must be read from the relays they are written to, or names silently stop resolving');
  assert.match(claimSub[2], /K_CLAIM/, 'the claim subscription should filter on K_CLAIM');
  assert.doesNotMatch(claimSub[3], /net\.ready/,
    'the claim handler must not be gated by the gameplay EOSE');
  assert.doesNotMatch(claimSub[2], /Date\.now\(\)/,
    'the claim filter must not derive a bound from the client clock either');
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

test('the kill/death display survives a relay refactor', () => {
  // Added after a relay change was very nearly landed on top of a stale copy of race.js, which
  // would have silently reverted the K/D feature. The netcode guards all stayed green because
  // none of them looked at scoring, so this is the cheap tripwire for that whole class.
  assert.match(race, /const kd = /, 'the K/D ratio helper is missing');
  assert.match(race, /deaths: c\.deaths \| 0/, 'fetchScores must keep reading deaths off the score');
  assert.ok(race.includes('☠'), 'the deaths glyph is missing from the boards');
  assert.match(race, /a\.deaths \+= r\.deaths/, 'the all-time board must keep aggregating deaths');
});

test('published events do not carry an h tag', () => {
  // 'h' is NIP-29's group tag. A relay that implements groups routes any h-tagged event into its
  // workspace plane and requires membership there, so a guest publish comes back
  // "auth-required: relay membership required to publish workspace content". Ticks carried
  // ['h', block height] that nothing read; strfry ignored it, so it only broke once the realtime
  // plane moved to a single NIP-29-aware relay — riders saw each other join but never move.
  // Scans the bracket depth rather than regexing to the first ']', which stops inside the very
  // nested array the tag lives in and makes the check silently vacuous.
  const sites = [];
  for (const m of race.matchAll(/kind:\s*(K_[A-Z]+),\s*tags:\s*\[/g)) {
    let i = m.index + m[0].length - 1, depth = 0;
    do { if (race[i] === '[') depth++; else if (race[i] === ']') depth--; i++; }
    while (depth > 0 && i < race.length);
    sites.push([m[1], race.slice(m.index, i)]);
  }
  assert.ok(sites.length >= 4, `expected the publish sites, found ${sites.length}`);
  for (const [kind, src] of sites) {
    assert.doesNotMatch(src, /\[\s*'h'\s*,/,
      `${kind} publishes an 'h' tag — that is NIP-29 group namespace, put app data in the content`);
  }
});

test('kills and block winners route through the juice layer', () => {
  // Puzz asked for real kill/winner feedback. Both death paths (locally simulated and the
  // remote 'die' event) must go through killFx — a second inline burst here is how the remote
  // path silently loses the shockwave/shake again — and the round-over path must celebrate the
  // winner in-world, not only in the podium list.
  assert.equal((race.match(/killFx\(/g) || []).length >= 3, true,
    'expected killFx defined and called from both death paths');
  assert.doesNotMatch(race, /c\.t === 'die'\)\{ if \(p\.alive\)\{ p\.alive = false; burst\(/,
    "the remote 'die' branch must use killFx, not a bare burst");
  assert.match(race, /celebrateWinner\(rows\[0\], prevHeight\)/,
    'roundOver must celebrate the block winner');
  assert.match(race, /shakeUntil > now\(\)/, 'the camera shake must actually be applied in draw');
});
