// The service worker caches shell responses network-first. r.clone() must happen synchronously,
// before the response is returned to the page: cloning inside the async caches.open().then()
// callback resolves after `return r` has handed the body to the browser, so it races the body
// being consumed and throws "Failed to execute 'clone' on 'Response': Response body is already
// used". That shipped once and spammed the console on every shell fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sw = readFileSync(fileURLToPath(new URL('../sw-game.js', import.meta.url)), 'utf8');

test('the service worker clones the shell response synchronously, not inside caches.open', () => {
  assert.match(sw, /\.clone\(\)/, 'the shell response must be cloned for the cache');
  assert.doesNotMatch(sw, /put\([^)]*,\s*r\.clone\(\)\s*\)/,
    'clone the response before returning it — r.clone() inside the caches.open().then() put ' +
    'races the browser reading the body and throws "Response body is already used"');
});

// The static guard above pins the one bad shape. These drive the real handler against stubs that
// reproduce the two parts of the browser contract that actually broke — respondWith consumes the
// body, and caches.open() resolves a turn later — so a different route to the same bug is caught
// too, and the cache write is proven to run rather than merely to be written down.
const handlerBody = source => {
  const m = source.match(/self\.addEventListener\('fetch', e => \{([\s\S]*)\n\}\);/);
  assert.ok(m, 'could not extract the fetch handler');
  return m[1];
};

// Kept verbatim so the harness is proven against the bug it claims to model. If this stops
// failing, the harness has stopped modelling the browser and the tests below prove nothing.
const PRE_FIX = `
  const u = new URL(e.request.url); if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  const isShell = SHELL.includes(u.pathname);
  if (!isShell) return;
  e.respondWith(fetch(e.request).then(r => { if (r.ok) caches.open(V).then(c => c.put(e.request, r.clone())); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));`;

const run = async (body, { ok = true, networkFails = false, cached = null } = {}) => {
  const put = [];
  let opened = null;
  const caches = {
    open: () => (opened = new Promise(res => setTimeout(() => res({
      put: (req, resp) => { put.push(resp); return Promise.resolve(); },
    }), 0))),
    match: () => Promise.resolve(cached),
  };
  const fetchStub = () => networkFails
    ? Promise.reject(new Error('offline'))
    : Promise.resolve(new Response('shell-bytes', { status: ok ? 200 : 500 }));
  let responded;
  const e = {
    request: { url: 'https://forever21.lol/game/race.js', method: 'GET' },
    respondWith: p => { responded = p; },
  };
  new Function('e', 'caches', 'fetch', 'location', 'Response', 'SHELL', 'V', body)(
    e, caches, fetchStub, { origin: 'https://forever21.lol' }, Response,
    ['/game', '/game/race.js'], 'hodland-v3');
  let status = null, text = null, thrown = null;
  try {
    const r = await responded;
    status = r?.status ?? null;
    text = r ? await r.text() : null; // the browser streaming the body is what locks it
  } catch (err) { thrown = err; }
  await opened?.catch(() => {});
  await new Promise(r => setTimeout(r, 10));
  return { status, text, thrown, put };
};

test('the pre-fix handler still reproduces the reported clone failure', async () => {
  let caught = null;
  const existing = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  process.once('unhandledRejection', err => { caught = err; });
  await run(PRE_FIX);
  await new Promise(r => setTimeout(r, 25));
  existing.forEach(l => process.on('unhandledRejection', l));
  assert.ok(caught, 'expected the pre-fix handler to reject');
  assert.match(String(caught.message), /already been (read|consumed)|already used|disturbed|unusable/i,
    `expected a body-already-used failure, got: ${caught.message}`);
});

test('the shell reaches the page and a usable copy reaches the cache', async () => {
  // The clone throwing was never only console noise: it meant put() never ran, so the cache held
  // nothing but what install-time addAll wrote.
  const { status, text, thrown, put } = await run(handlerBody(sw));
  assert.equal(thrown, null, `the handler threw: ${thrown?.message}`);
  assert.equal(status, 200);
  assert.equal(text, 'shell-bytes', 'the page must still receive the body');
  assert.equal(put.length, 1, 'the shell response should reach the cache');
  assert.equal(await put[0].text(), 'shell-bytes', 'the cached copy must carry the body');
});

test('a non-ok response is served but not cached', async () => {
  const { status, put } = await run(handlerBody(sw), { ok: false });
  assert.equal(status, 500);
  assert.equal(put.length, 0, 'a 500 must not poison the shell cache');
});

test('an offline hit is served from cache', async () => {
  const { text } = await run(handlerBody(sw), { networkFails: true, cached: new Response('cached-shell') });
  assert.equal(text, 'cached-shell');
});

test('an offline miss answers with a Response instead of undefined', async () => {
  const { status, thrown } = await run(handlerBody(sw), { networkFails: true, cached: null });
  assert.equal(thrown, null);
  assert.equal(status, 504, 'respondWith(undefined) is itself a TypeError');
});
