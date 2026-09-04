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
