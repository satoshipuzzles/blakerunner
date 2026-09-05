// End-to-end check that the on-screen ping is a real measurement and not a decoration: load the
// actual page, ride as a guest into a private room, and read #hPing out of the live DOM once real
// ticks have round-tripped through the relay.
//
// Requires playwright and network. Defaults to production; point it at a local build with
//   URL=http://127.0.0.1:8731/game/ node test/perf/ping-live.mjs
const BASE = process.env.URL || 'https://forever21.lol/game';
const SECONDS = Number(process.env.SECONDS || 12);
const ROOM = 'pingcheck' + process.pid;

const loadChromium = async () => {
  try { return (await import('playwright')).chromium; }
  catch { console.error('this script needs playwright: npm i -D playwright && npx playwright install chromium'); process.exit(1); }
};
const browser = await (await loadChromium()).launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', e => console.error('PAGE ERROR:', e.message));

const sep = BASE.includes('?') ? '&' : '?';
await page.goto(`${BASE}${sep}room=${ROOM}&private=1&bots=2`, { waitUntil: 'load' });
await page.click('#btnGuest');
await page.click('#btnRide');

const readings = [];
for (let i = 0; i < SECONDS; i++){
  await page.waitForTimeout(1000);
  readings.push(await page.evaluate(() => ({
    txt: document.getElementById('hPing').textContent,
    colour: document.getElementById('hPing').style.color,
    relay: document.getElementById('hRelay').classList.contains('on'),
  })));
}
for (const [i, r] of readings.entries())
  console.log(`t+${String(i + 1).padStart(2)}s  ping=${r.txt.padEnd(7)} colour=${(r.colour || '-').padEnd(14)} relay=${r.relay ? 'on' : 'off'}`);

const nums = readings.map(r => Number(r.txt.replace('ms', ''))).filter(n => Number.isFinite(n) && n > 0);
console.log(`\n${nums.length}/${SECONDS} readings carried a number` + (nums.length ? `; range ${Math.min(...nums)}-${Math.max(...nums)} ms` : ''));
if (!nums.length) console.error('NO PING EVER RESOLVED — the relay is not echoing our own ticks back to us, which is what this whole feature stands on');
await page.screenshot({ path: '.perf-ping.png', clip: { x: 0, y: 0, width: 1280, height: 120 } });
await browser.close();
process.exit(nums.length ? 0 : 1);
