// The relay list is resolved from a URL param and localStorage, so it parses untrusted input.
// This lifts that resolver out of race.js and exercises it directly rather than restating it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { race } from './source.mjs';

const src = race.match(/const DEFAULT_GAME_RELAYS = [\s\S]*?^\}\)\(\);/m);
assert.ok(src, 'could not extract the relay resolver from game/race.js');

// Evaluate the real source with params/localStorage injected.
const resolve = (query, stored) => {
  const store = new Map(stored === undefined ? [] : [['br_relays', stored]]);
  const params = new URLSearchParams(query);
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: k => store.delete(k),
  };
  const fn = new Function('params', 'localStorage', `${src[0]} return GAME_RELAYS;`);
  return { relays: fn(params, localStorage), stored: store.get('br_relays') };
};

const DEFAULT = ['wss://coolfeed.feeds.relay.tools'];

test('defaults to coolfeed alone', () => {
  assert.deepEqual(resolve('', undefined).relays, DEFAULT);
});

test('?relays= overrides and is remembered', () => {
  const r = resolve('?relays=wss://a.example,wss://b.example');
  assert.deepEqual(r.relays, ['wss://a.example', 'wss://b.example']);
  assert.equal(r.stored, 'wss://a.example,wss://b.example');
});

test('a remembered list is used when no param is given', () => {
  assert.deepEqual(resolve('', 'wss://kept.example').relays, ['wss://kept.example']);
});

test('?relays=default forgets the remembered list', () => {
  const r = resolve('?relays=default', 'wss://kept.example');
  assert.deepEqual(r.relays, DEFAULT);
  assert.equal(r.stored, undefined, 'the stored override must be cleared, not just ignored');
});

test('non-wss entries are dropped rather than dialled', () => {
  const r = resolve('?relays=http://plain.example,javascript:alert(1),wss://ok.example, ,ws://insecure');
  assert.deepEqual(r.relays, ['wss://ok.example']);
});

test('garbage alone falls back to the default instead of leaving no relay', () => {
  assert.deepEqual(resolve('?relays=nonsense').relays, DEFAULT);
  assert.deepEqual(resolve('?relays=').relays, DEFAULT);
});

test('duplicates collapse and the list is capped', () => {
  assert.deepEqual(resolve('?relays=wss://a.example,wss://a.example').relays, ['wss://a.example']);
  const many = Array.from({ length: 20 }, (_, i) => `wss://r${i}.example`).join(',');
  assert.equal(resolve(`?relays=${many}`).relays.length, 8);
});
