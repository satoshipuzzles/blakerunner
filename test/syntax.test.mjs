// The site has no build step: Vercel serves these files verbatim, so a parse error in race.js
// ships to production and the game simply never starts. This is the cheapest gate that exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const jsFiles = (dir = ROOT, out = []) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'test') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) jsFiles(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
};

const files = jsFiles();

test('found the shipped javascript', () => {
  assert.ok(files.length >= 4, `expected the site's js files, found ${files.length}`);
});

for (const file of files) {
  test(`parses: ${relative(ROOT, file)}`, () => {
    // Every shipped file is an ES module (race.js uses import, sw-game.js is a worker).
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', file], {
      stdio: ['ignore', 'ignore', 'pipe'], input: '',
    }), `${relative(ROOT, file)} is not parseable`);
  });
}
