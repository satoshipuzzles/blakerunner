// How much main-thread time do schnorr sign/verify cost IN THE BROWSER, loading nostr-tools the
// same way game/race.js does (esm.sh, pinned version read out of the source)? Node numbers are a
// different JIT and a different build; the game runs here.
//
// Requires playwright and network. `npm i -D playwright && npx playwright install chromium`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const race = readFileSync(fileURLToPath(new URL('../../game/race.js', import.meta.url)), 'utf8');
const NT = race.match(/from '(https:\/\/esm\.sh\/nostr-tools@[^']+)'/)?.[1];
if (!NT) throw new Error('could not find the nostr-tools import in game/race.js');
const TICK_HZ = Number(race.match(/TICK_HZ = (\d+)/)[1]);
const K_TICK = Number(race.match(/K_TICK = (\d+)/)[1]);
console.log(`${NT}\ntick ${TICK_HZ} Hz, kind ${K_TICK}\n`);

const loadChromium = async () => {
  try { return (await import('playwright')).chromium; }
  catch { console.error('this script needs playwright: npm i -D playwright && npx playwright install chromium'); process.exit(1); }
};
const browser = await (await loadChromium()).launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error') console.error('page error:', m.text()); });
await page.goto('https://forever21.lol/game', { waitUntil: 'domcontentloaded' });

const out = await page.evaluate(async ({ NT, K_TICK }) => {
  const { finalizeEvent, generateSecretKey, verifyEvent } = await import(NT);
  const sk = generateSecretKey();
  // a realistic tick: position, flags, and a run-length tail of the sort a mid-game rider sends
  const tmpl = { kind: K_TICK, created_at: Math.floor(Date.now() / 1000), tags: [['t', 'hodland-r-bench']],
    content: JSON.stringify({ x: 12.34, y: 56.78, d: 1, a: 1, k: 3, dd: 2, b: 0, st: [210, 2], tp: '2f4R12U5L3'.repeat(6) }) };

  // Verification is memoised on the event OBJECT, so every rep must get a fresh one — exactly
  // what arrives off a websocket. Re-verifying one object measures a property read.
  const wire = Array.from({ length: 300 }, (_, i) => JSON.stringify(finalizeEvent({ ...tmpl, content: tmpl.content + i }, sk)));
  const med = (fn, reps) => {
    for (let i = 0; i < 20; i++) fn(i);                       // warm the JIT
    const t = [];
    for (let i = 0; i < reps; i++){ const a = performance.now(); fn(i); t.push(performance.now() - a); }
    t.sort((x, y) => x - y); return t[t.length >> 1];
  };
  const parse = med(i => JSON.parse(wire[i % wire.length]), 200);
  const verify = med(i => verifyEvent(JSON.parse(wire[i % wire.length])), 200) - parse;
  const sign = med(i => finalizeEvent({ ...tmpl, content: tmpl.content + i }, sk), 200);
  const cached = finalizeEvent({ ...tmpl, content: 'x' }, sk); verifyEvent(cached);
  return { sign, verify, parse, cachedVerify: med(() => verifyEvent(cached), 200), ua: navigator.userAgent };
}, { NT, K_TICK });

console.log(`sign   ${out.sign.toFixed(2)} ms`);
console.log(`verify ${out.verify.toFixed(2)} ms   (JSON.parse ${out.parse.toFixed(3)} ms, memoised re-verify ${out.cachedVerify.toFixed(3)} ms)`);
console.log(`\nmain-thread crypto per second, one relay, all riders ticking at ${TICK_HZ} Hz:`);
for (const riders of [2, 4, 8]){
  const inbound = (riders - 1) * TICK_HZ;
  const v = inbound * out.verify, s = TICK_HZ * out.sign;
  console.log(`  ${riders} riders: verify ${v.toFixed(0)} ms/s + sign ${s.toFixed(0)} ms/s = ${((v + s) / 10).toFixed(1)}% of one core`);
}
const burst = 7 * out.verify;
console.log(`\nworst single frame: 8 riders' ticks landing together = ${burst.toFixed(1)} ms of verification in one frame (16.7 ms budget at 60 fps)`);
await browser.close();
