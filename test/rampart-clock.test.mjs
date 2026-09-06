// Rampart derives its phase from wall time with no coordinating event, and the tactical phases are
// only 18 seconds each — so a rider whose clock is 18s out has zero overlap with everyone else's
// fortify and bombard. These tests pin that the phase now reads a server-corrected clock, and that
// the correction degrades to a no-op rather than to nonsense.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { race } from './source.mjs';

const phasesBlock = race.match(/const RAMPART_PHASES = \[([\s\S]*?)\];/)?.[1];
assert.ok(phasesBlock, 'RAMPART_PHASES is missing');
const keys = [...phasesBlock.matchAll(/key:\s*'(\w+)'/g)].map(m => m[1]);
const secs = [...phasesBlock.matchAll(/secs:\s*(\d+)/g)].map(m => Number(m[1]));
const PHASES = keys.map((key, i) => ({ key, secs: secs[i] }));
const PERIOD = secs.reduce((a, b) => a + b, 0);

const srcOf = re => { const m = race.match(re); assert.ok(m, `missing: ${re}`); return m[0]; };
// Lifted lazily inside rig(). Building this at module scope makes a missing helper blow up the
// whole file, and "the file threw" says nothing about which guard caught the regression.
const clockSrc = () => [
  srcOf(/let clockSkew = 0;/),
  srcOf(/const syncedNow = [^;]+;/),
  srcOf(/function readServerClock\([\s\S]*?\n\}/),
].join('\n');

// The real clock helpers plus the real rampartPhase, over a controllable browser clock.
function rig(browserMs) {
  let now = browserMs;
  const fakeDate = { now: () => now, parse: Date.parse };
  const api = new Function('Date', 'RAMPART_PHASES', 'RAMPART_PERIOD',
    `${clockSrc()}\n${srcOf(/function rampartPhase\(\)\{[\s\S]*?\n\}/)}
     return { readServerClock, syncedNow, rampartPhase, skew: () => clockSkew };`)(fakeDate, PHASES, PERIOD);
  return { ...api, setBrowser: ms => { now = ms; } };
}
const headers = date => ({ headers: { get: k => (k.toLowerCase() === 'date' && date !== undefined ? date : null) } });

test('the phase is derived from the synced clock, not from Date.now directly', () => {
  const fn = srcOf(/function rampartPhase\(\)\{[\s\S]*?\n\}/);
  assert.match(fn, /syncedNow\(\)/, 'rampartPhase still reads the raw browser clock');
  assert.doesNotMatch(fn, /Date\.now\(\)/, 'rampartPhase still calls Date.now directly');
});

test('a correct server date leaves the clock alone', () => {
  const t = 1789000000000;
  const r = rig(t);
  r.readServerClock(headers(new Date(t).toUTCString()));
  assert.ok(Math.abs(r.skew()) < 1000, `skew ${r.skew()}ms from an already-correct clock`);
});

test('a skewed browser clock is pulled back onto the server clock', () => {
  // 40s fast and 40s slow: both larger than an 18s tactical phase, which is the whole problem.
  for (const drift of [-95000, -40000, -19000, 19000, 40000, 95000]) {
    const server = 1789000000000;
    const r = rig(server + drift);
    r.readServerClock(headers(new Date(server).toUTCString()));
    // HTTP-date has one-second resolution, so allow a second of quantisation
    assert.ok(Math.abs(r.syncedNow() - server) <= 1000,
      `drift ${drift}ms left the synced clock ${r.syncedNow() - server}ms off the server`);
  }
});

test('two riders with clocks 40s apart agree on the phase once corrected', () => {
  const server = 1789000000000;
  const a = rig(server + 40000), b = rig(server - 40000);
  const dateHdr = headers(new Date(server).toUTCString());
  // before correction they disagree — that is the bug
  const rawA = a.rampartPhase().key, rawB = b.rampartPhase().key;
  a.readServerClock(dateHdr); b.readServerClock(dateHdr);
  assert.equal(a.rampartPhase().key, b.rampartPhase().key,
    `corrected clocks still disagree (${a.rampartPhase().key} vs ${b.rampartPhase().key}); uncorrected they were ${rawA}/${rawB}`);
  assert.ok(Math.abs(a.rampartPhase().left - b.rampartPhase().left) <= 1, 'the countdowns disagree by more than a second');
});

test('a drifted pair disagree across a whole tactical phase without the correction', () => {
  // Establishes the failure this exists to prevent, rather than asserting it in the abstract:
  // somewhere in the period, two clocks 40s apart land in different phases.
  const drift = 40000;
  let disagreements = 0;
  for (let s = 0; s < PERIOD; s++) {
    const server = 1789000000000 + s * 1000;
    const a = rig(server + drift), b = rig(server);
    if (a.rampartPhase().key !== b.rampartPhase().key) disagreements++;
  }
  assert.ok(disagreements >= 40, `only ${disagreements}/${PERIOD}s of the period disagree at ${drift}ms drift`);
});

test('a missing, empty or unparseable date header leaves the clock exactly as it was', () => {
  for (const bad of [undefined, '', 'not-a-date', 'Tue, 99 Xxx 20xx', null]) {
    const t = 1789000000000;
    const r = rig(t);
    r.readServerClock(headers(bad));
    assert.equal(r.skew(), 0, `header ${JSON.stringify(bad)} moved the clock`);
    assert.equal(r.syncedNow(), t, 'a bad header must degrade to the browser clock, not to nonsense');
  }
  // and a response with no headers object at all must not throw
  const r = rig(1789000000000);
  assert.doesNotThrow(() => r.readServerClock(undefined));
  assert.doesNotThrow(() => r.readServerClock({}));
  assert.equal(r.skew(), 0);
});

test('the correction is read from the request pollChain already makes', () => {
  const poll = srcOf(/async function pollChain\(\)\{[\s\S]*?\n\}/);
  assert.match(poll, /readServerClock\(/, 'pollChain does not read the server clock');
  // it must reuse the tip response rather than issuing another request for a header
  assert.match(poll, /const tipRes = await fetch\([^)]*\); readServerClock\(tipRes\)/,
    'the clock should come from the tip fetch already being made, not a new request');
  const fetches = (poll.match(/fetch\(/g) || []).length;
  assert.ok(fetches <= 3, `pollChain now makes ${fetches} requests — the clock should not have added one`);
});

test('the phase clock still tiles the period with no gap or overlap', () => {
  const r = rig(1789000000000);
  const seen = [];
  for (let s = 0; s < PERIOD; s++) { r.setBrowser(1789000000000 + s * 1000); seen.push(r.rampartPhase().key); }
  for (const p of PHASES) assert.equal(seen.filter(k => k === p.key).length, p.secs, `${p.key} does not occupy ${p.secs}s`);
});
