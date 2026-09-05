// HODLAND: claim and hold land on the neon grid. Nostr relays are the netcode, a BLAKE2b block is a round.
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey, nip19, verifyEvent } from 'https://esm.sh/nostr-tools@2.10.4';
import { BunkerSigner, parseBunkerInput } from 'https://esm.sh/nostr-tools@2.10.4/nip46';

const params = new URLSearchParams(location.search);
// One fast relay beats three. The pool takes the first copy of an event to arrive, so extra
// relays never make a tick land sooner — but `oneose` fires only once EVERY relay has answered,
// and nothing moves until it does, so each join and grid change paid the slowest relay's
// latency. Measured, median of 7 from one host:
//
//   coolfeed      63ms to EOSE       65ms peer round-trip
//   relay.mostr  137ms              221ms
//   purplerelay  876ms (2.9s worst) 474ms (1.1s worst)
//
// Three relays made joining ~14x slower than one and bought no tick speed, only redundancy.
// That is the trade being made here: one relay is also a single point of failure, so the list
// is overridable — ?relays=wss://a,wss://b is remembered, ?relays=default forgets it again.
// nos.lol is not a candidate: it demands 28 bits of PoW on every kind and we mine none.
const DEFAULT_GAME_RELAYS = ['wss://coolfeed.feeds.relay.tools'];
const GAME_RELAYS = (() => {
  const raw = params.get('relays');
  if (raw === 'default') { localStorage.removeItem('br_relays'); return DEFAULT_GAME_RELAYS; }
  const wanted = [...new Set((raw ?? localStorage.getItem('br_relays') ?? '').split(',')
    .map(s => s.trim()).filter(s => /^wss:\/\/[^\s,]+$/.test(s)))].slice(0, 8);
  if (!wanted.length) return DEFAULT_GAME_RELAYS;
  if (raw) localStorage.setItem('br_relays', wanted.join(','));
  return wanted;
})();
// Scores and claims kept their own list only because coolfeed's write gate refused 2112/2113.
// That gate is now open for both kinds, and the 164 signed events that existed on the old
// relays (141 scores, 23 claims) were republished to coolfeed and read back, so no round is
// orphaned by this move. Still a separate constant from the realtime list: these are stored
// kinds written once per block, and the day 2112 moves to a blakerunner-specific addressable
// kind, this is the line that changes rather than the netcode.
const SCORE_RELAYS = ['wss://coolfeed.feeds.relay.tools'];
const PROFILE_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band'];
const K_TICK = 21110, K_EVT = 21111, K_SCORE = 2112, K_CLAIM = 2113, K_PRESENCE = 30078, TAG = 'hodland';
// Rooms (Tank Arena pattern): a room is a string two people agreed on. Ticks/events carry the room tag so grids
// stay separate; presence is an addressable kind 30078 with NIP-40 expiry so the lobby can list live grids.
const PRESENCE_D = 'hodland/here', PRESENCE_TAG = 'hodland-live', BEACON_MS = 30000, PRESENCE_TTL_S = 120, SEATS = 8, MAX_BOTS = 7;
const cleanRoom = r => String(r || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'lobby';
const room = { name: cleanRoom(params.get('room') || localStorage.getItem('br_room') || 'lobby'), listed: params.get('private') !== '1' && localStorage.getItem('br_room_private') !== '1' };
// Combat is a property of the grid, not the rider: it is baked into the room tag, so a classic
// rider and a combat rider on the same room name are on different tags and never see each other.
// Chosen in the lobby before riding, carried by the invite link.
const mode = { combat: (params.get('mode') || localStorage.getItem('br_mode')) === 'combat' };
const roomTag = () => TAG + '-r-' + room.name + (mode.combat ? '-combat' : '');
const MEMPOOL = '/mp';
const COLS = 140, ROWS = 90, CELL = 22, W = COLS * CELL, H = ROWS * CELL;
const SPEED = 7.5, BOOST = 1.6, BOOST_MS = 800, BOOST_CD = 3500, TICK_HZ = 10, KEY_MS = 5000, RESPAWN_MS = 2500, MAX_TAIL = 500;
// Combat bolts: ~3x rider speed so they are dodgeable at range and lethal up close, range capped
// so a bolt is a duel, not cross-map artillery. The cooldown keeps land-claiming the core game.
const BOLT_SPEED = 22, BOLT_RANGE = 20, BOLT_HIT_R = .7, FIRE_CD_MS = 2500;
// Drones: local practice riders. Preference lives in localStorage and the invite link; the count is what the room feels like, not a rule.
let botsWanted = (() => { const u = params.get('bots'); const raw = u !== null ? u : localStorage.getItem('br_bots'); const n = raw === null ? 5 : Math.floor(Number(raw)); return Number.isFinite(n) ? Math.max(0, Math.min(MAX_BOTS, n)) : 5; })(); let botsLast = botsWanted || 5;
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const PATTERNS = ['solid', 'stripes', 'dots', 'checker', 'grid'];
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const now = () => performance.now();
const enc = new TextEncoder();
const hexToBytes = h => Uint8Array.from(h.match(/.{2}/g), b => parseInt(b, 16));
const bytesToHex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const idx = (cx, cy) => cy * COLS + cx;

// ---------- identity ----------
const pool = new SimplePool();
const me = { id: null, sk: null, nip07: false, bunker: null, sess: generateSecretKey(), sessPub: null, guest: false };
me.sessPub = getPublicKey(me.sess);
const profiles = new Map(), claims = new Map(), imgs = new Map();
const idOf = pk => claims.get(pk) || pk;
const nameOf = pk => { const p = profiles.get(idOf(pk)) || {}; return p.display_name || p.name || (pk === me.sessPub ? 'you' : 'rider-' + pk.slice(0, 4)); };
const avatar = pk => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='32' fill='#${pk.slice(0,6)}'/><text x='32' y='42' font-size='28' font-family='Arial' font-weight='700' text-anchor='middle' fill='#fff'>${pk.slice(0,1).toUpperCase()}</text></svg>`)}`;
const picOf = pk => { const p = profiles.get(idOf(pk)) || {}; return /^https?:\/\//.test(p.picture || '') ? p.picture : avatar(idOf(pk)); };
const npubLink = pk => claims.has(pk) || (pk === me.sessPub && me.id && !me.guest) ? '/p/' + nip19.npubEncode(idOf(pk)) : null;
function imgOf(pk){ const src = picOf(pk); let e = imgs.get(pk); if (e && e.src === src) return e.img; const img = new Image(); img.decoding = 'async'; img.src = src; imgs.set(pk, { src, img }); return img; }
const wantP = new Set(); let pT = null;
function wantProfile(pk){ if (!pk || profiles.has(pk) || wantP.has(pk)) return; wantP.add(pk); clearTimeout(pT); pT = setTimeout(async () => { const a = [...wantP]; wantP.clear(); const evs = await pool.querySync(PROFILE_RELAYS, { kinds: [0], authors: a }, { maxWait: 4000 }).catch(() => []); const best = new Map(); for (const e of evs) if (!best.has(e.pubkey) || best.get(e.pubkey).created_at < e.created_at) best.set(e.pubkey, e); for (const pk of a){ let p = {}; try { p = JSON.parse(best.get(pk)?.content || '{}'); } catch {} profiles.set(pk, p); } renderHud(); showWho(); }, 200); }
async function signAsMe(t){ t.created_at = Math.floor(Date.now()/1000); if (me.bunker) return me.bunker.signEvent(t); if (me.nip07) return window.nostr.signEvent(t); return finalizeEvent(t, me.sk); }
const signAsSess = t => { t.created_at = Math.floor(Date.now()/1000); return finalizeEvent(t, me.sess); };
async function kdf(pass, salt){ const km = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']); return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']); }
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function loungeKey(){
  const rec = JSON.parse(localStorage.getItem('br_key') || 'null'); const ses = JSON.parse(localStorage.getItem('br_session') || 'null');
  if (ses?.signer === 'bunker' && localStorage.getItem('br_bunker')) return loginBunker(localStorage.getItem('br_bunker'));
  if (!rec && ses?.signer === 'nip07') return loginNip07();
  if (!rec) throw new Error('No lounge login in this browser. Log in on the lounge first, or use one of the other buttons.');
  if (rec.plain) return setIdentity(getPublicKey(hexToBytes(rec.plain)), hexToBytes(rec.plain));
  $('passIn').classList.remove('hidden'); const pass = $('passIn').value; if (!pass) throw new Error('Enter your lounge passphrase, then press the button again.');
  try { const sk = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv) }, await kdf(pass, unb64(rec.salt)), unb64(rec.ct))); return setIdentity(getPublicKey(sk), sk); } catch { throw new Error('Wrong passphrase.'); }
}
async function loginNip07(){ if (!window.nostr) throw new Error('No NIP-07 extension found.'); const pk = await window.nostr.getPublicKey(); me.nip07 = true; me.bunker = null; return setIdentity(pk, null); }
async function loginBunker(str){
  const bp = await parseBunkerInput(str.trim()); if (!bp) throw new Error('That is not a bunker:// URL or a nostrconnect name.');
  let csk = localStorage.getItem('br_bunker_sk'); csk = csk ? hexToBytes(csk) : generateSecretKey();
  const signer = new BunkerSigner(csk, bp, { pool }); await Promise.race([signer.connect(), new Promise((_, r) => setTimeout(() => r(new Error('Bunker did not answer in 20 s. Approve the connection in your signer app and try again.')), 20000))]);
  const pk = await signer.getPublicKey(); localStorage.setItem('br_bunker', str.trim()); localStorage.setItem('br_bunker_sk', bytesToHex(csk)); me.bunker = signer; me.nip07 = false; return setIdentity(pk, null);
}
function setIdentity(pk, sk){ me.id = pk; me.sk = sk; me.guest = false; claims.set(me.sessPub, pk); wantProfile(pk); showWho(); }
function guest(){ me.id = me.sessPub; me.sk = me.sess; me.guest = true; me.nip07 = false; me.bunker = null; claims.delete(me.sessPub); showWho(); }
function showWho(){ if (!me.id) return; $('who').classList.remove('hidden'); $('whoPic').src = picOf(me.sessPub); $('whoName').textContent = me.guest ? 'guest rider ' + me.sessPub.slice(0, 6) : nameOf(me.sessPub) + ' · ' + nip19.npubEncode(me.id).slice(0, 14) + '…' + (me.bunker ? ' · bunker' : me.nip07 ? ' · NIP-07' : ''); $('loginRow').classList.add('hidden'); $('rideRow').classList.remove('hidden'); }
const pub = ev => { for (const p of pool.publish(GAME_RELAYS, ev)) p.catch(() => {}); };
const pubScore = ev => { for (const p of pool.publish(SCORE_RELAYS, ev)) p.catch(() => {}); };
async function publishClaim(){ if (me.guest) return; try { pubScore(await signAsMe({ kind: K_CLAIM, tags: [['t', TAG], ['p', me.sessPub]], content: me.sessPub })); } catch (e) { feed('Could not sign the session claim: ' + e.message, 'kill'); } }

// ---------- style (land color + pattern) ----------
const style = Object.assign({ hue: parseInt(me.sessPub.slice(0, 4), 16) % 360, pat: 0 }, JSON.parse(localStorage.getItem('br_style') || '{}'));
const patCache = new Map();
function landFill(hue, pat, alpha = .45){
  const key = `${hue}|${pat}|${alpha}`; if (patCache.has(key)) return patCache.get(key);
  const c = document.createElement('canvas'); c.width = c.height = CELL; const x = c.getContext('2d');
  // The 1px gutter between cells used to come from insetting every per-cell rect. draw() now
  // fills whole runs of cells in one rect, so the inset lives in the tile instead: the pattern is
  // anchored to the world origin and repeats every CELL world units, which puts the transparent
  // margin on exactly the pixels the per-cell inset used to leave bare.
  x.save(); x.beginPath(); x.rect(.5, .5, CELL - 1, CELL - 1); x.clip();
  x.fillStyle = `hsla(${hue},95%,58%,${alpha})`; x.fillRect(0, 0, CELL, CELL);
  x.fillStyle = `hsla(${hue},100%,80%,${alpha * .9})`; x.strokeStyle = x.fillStyle; x.lineWidth = 2;
  const p = PATTERNS[pat] || 'solid';
  if (p === 'stripes'){ x.beginPath(); x.moveTo(0, CELL); x.lineTo(CELL, 0); x.moveTo(-CELL/2, CELL/2); x.lineTo(CELL/2, -CELL/2); x.moveTo(CELL/2, CELL * 1.5); x.lineTo(CELL * 1.5, CELL/2); x.stroke(); }
  else if (p === 'dots'){ x.beginPath(); x.arc(CELL/2, CELL/2, 3.5, 0, Math.PI * 2); x.fill(); }
  else if (p === 'checker'){ x.fillRect(0, 0, CELL/2, CELL/2); x.fillRect(CELL/2, CELL/2, CELL/2, CELL/2); }
  else if (p === 'grid'){ x.strokeRect(1, 1, CELL - 2, CELL - 2); }
  x.restore();
  const pat2 = cx.createPattern(c, 'repeat'); patCache.set(key, pat2); return pat2;
}
function saveStyle(){ localStorage.setItem('br_style', JSON.stringify(style)); local.hue = style.hue; local.pat = style.pat; drawStylePreview(); }
function bindStyle(hueId, patsId){
  const hue = $(hueId); hue.value = style.hue; hue.oninput = () => { style.hue = +hue.value; saveStyle(); syncStyleUI(); };
  const box = $(patsId); box.innerHTML = PATTERNS.map((p, i) => `<div class="swatch${i === style.pat ? ' on' : ''}" data-pat="${i}" title="${p}"></div>`).join('');
  box.querySelectorAll('.swatch').forEach(s => { s.onclick = () => { style.pat = +s.dataset.pat; saveStyle(); syncStyleUI(); }; });
}
function syncStyleUI(){ for (const id of ['hueIn', 'hueIn2']) $(id).value = style.hue; for (const id of ['patterns', 'patterns2']) $(id).querySelectorAll('.swatch').forEach(s => { s.classList.toggle('on', +s.dataset.pat === style.pat); const t = document.createElement('canvas'); t.width = t.height = CELL; const x = t.getContext('2d'); x.fillStyle = landFillOn(x, style.hue, +s.dataset.pat); x.fillRect(0, 0, CELL, CELL); s.style.backgroundImage = `url(${t.toDataURL()})`; s.style.backgroundColor = `hsl(${style.hue},95%,45%)`; }); }
function landFillOn(ctx, hue, pat){ const c = document.createElement('canvas'); c.width = c.height = CELL; const x = c.getContext('2d'); x.fillStyle = `hsla(${hue},95%,58%,.9)`; x.fillRect(0, 0, CELL, CELL); x.fillStyle = `hsla(${hue},100%,85%,.9)`; x.strokeStyle = x.fillStyle; x.lineWidth = 2; const p = PATTERNS[pat]; if (p === 'stripes'){ x.beginPath(); x.moveTo(0, CELL); x.lineTo(CELL, 0); x.stroke(); } else if (p === 'dots'){ x.beginPath(); x.arc(CELL/2, CELL/2, 3.5, 0, Math.PI*2); x.fill(); } else if (p === 'checker'){ x.fillRect(0, 0, CELL/2, CELL/2); x.fillRect(CELL/2, CELL/2, CELL/2, CELL/2); } else if (p === 'grid'){ x.strokeRect(1, 1, CELL-2, CELL-2); } return ctx.createPattern(c, 'repeat'); }
function drawStylePreview(){ const c = $('stylePreview'); const x = c.getContext('2d'); x.fillStyle = '#0b0220'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = landFillOn(x, style.hue, style.pat); x.fillRect(20, 20, 200, 80); }

// ---------- block clock ----------
const chain = { height: 0, hash: '', time: 0, seed: 1 };
async function pollChain(){
  try { const h = Number(await fetch(MEMPOOL + '/blocks/tip/height', { cache: 'no-store' }).then(r => r.text())); const hash = (await fetch(MEMPOOL + '/blocks/tip/hash', { cache: 'no-store' }).then(r => r.text())).trim();
    if (h && hash && h !== chain.height){ const prev = chain.height; chain.height = h; chain.hash = hash; chain.seed = parseInt(hash.slice(-8), 16) || 1; const b = await fetch(MEMPOOL + '/block/' + hash).then(r => r.json()).catch(() => null); chain.time = b?.timestamp || Math.floor(Date.now()/1000); $('hBlock').textContent = h.toLocaleString(); if (prev) roundOver(prev); } } catch (e) { console.warn('chain', e); }
}
setInterval(() => { if (!chain.time) return; const s = Math.max(0, 600 - (Date.now()/1000 - chain.time)); $('hClock').textContent = s > 0 ? `~${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2, '0')}` : 'any second'; }, 1000);

// ---------- world ----------
const owner = new Uint8Array(COLS * ROWS);
const slots = [null]; const slotOf = new Map();
function slot(pk){ if (slotOf.has(pk)) return slotOf.get(pk); const s = slots.length; slots.push(pk); slotOf.set(pk, s); return s; }
const players = new Map(); let started = false;
function mkPlayer(pk, drone = false){ const p = { pk, slot: slot(pk), drone, x: 0, y: 0, d: 0, nd: 0, cell: -1, tail: [], tailSet: new Set(), alive: false, kills: 0, deaths: 0, land: 0, last: now(), cd: 0, boostUntil: 0, fireCd: 0, diedAt: 0, netX: 0, netY: 0, netAt: 0, hue: parseInt(pk.slice(0, 4), 16) % 360, pat: 0 }; players.set(pk, p); return p; }
function clearLand(s){ for (let i = 0; i < owner.length; i++) if (owner[i] === s) owner[i] = 0; }
function spawn(p){
  clearLand(p.slot); p.tail = []; p.tailSet = new Set(); p.alive = true; p.boostUntil = 0;
  for (let tries = 0; tries < 300; tries++){ const cx = 5 + Math.floor(Math.random() * (COLS - 10)), cy = 5 + Math.floor(Math.random() * (ROWS - 10)); let free = true; for (let y = -4; y <= 4 && free; y++) for (let x = -4; x <= 4; x++) if (owner[idx(cx + x, cy + y)]){ free = false; break; }
    if (free || tries === 299){ for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) owner[idx(cx + x, cy + y)] = p.slot; p.x = cx + .5; p.y = cy + .5; p.cell = idx(cx, cy); p.d = p.nd = Math.floor(Math.random() * 4); p.inside = true; return; } }
}
const local = mkPlayer(me.sessPub); local.hue = style.hue; local.pat = style.pat;
let drones = [];
// Drones used to be simulated independently in every browser, so no two riders saw the same ones:
// same colour slot, different cells, and a kill nobody else witnessed. Now exactly one rider —
// the live one with the lowest session pubkey — steps them and publishes them like players, and
// everyone else renders what arrives. Deterministic replay was the other option and does not work
// here: driveDrone steers off owner[] and the tails, which are reconciled lossily every KEY_MS, so
// two clients diverge on the first differing cell and never re-converge.
const AUTH_STALE_MS = 2500;
const dronePk = i => 'drone' + i + '0000000000000000000000000000000000000000000000000000000000';
function droneAuthority(){
  let best = started ? me.sessPub : null;
  for (const p of players.values()){
    if (p.drone || p.pk === me.sessPub || now() - p.last > AUTH_STALE_MS) continue;
    if (!best || p.pk < best) best = p.pk;
  }
  return best;
}
// Nobody publishing at all (a lobby on your own) still gets drones to look at — they are simply
// local until someone starts riding. A shorter window than the 8 s peer prune so a rider who
// closes the tab hands the flock over in a stutter rather than a long freeze.
const iDrive = () => { const a = droneAuthority(); return a === null || a === me.sessPub; };
function adoptDrone(i){
  const pk = dronePk(i);
  let d = players.get(pk);
  if (!d){ d = mkPlayer(pk, true); d.name = DRONE_NAMES[i % DRONE_NAMES.length]; d.hue = (i * 67 + 200) % 360; d.pat = i % PATTERNS.length; d.plan = []; d.i = i; d.why = WHY_ROAM; d.thinkAt = 0; d.lastCell = -1; }
  return d;
}
// Applied only from the current authority: two clients that briefly disagree about who is in
// charge would otherwise both drive and the flock would jitter between two simulations.
function applyFlock(list){
  const seen = new Set();
  for (const row of list){
    if (!Array.isArray(row) || typeof row[1] !== 'number' || typeof row[2] !== 'number') continue;
    const i = row[0] | 0; if (i < 0 || i >= MAX_BOTS) continue;
    seen.add(i);
    const d = adoptDrone(i);
    if (!d.alive && row[4] || Math.hypot(row[1] - d.x, row[2] - d.y) > 4){ d.x = row[1]; d.y = row[2]; }
    d.netX = row[1]; d.netY = row[2]; d.netAt = now(); d.d = row[3] & 3; d.alive = !!row[4]; d.last = now();
    // The reason the driver's brain gave, so a watching client can show why a drone did what it
    // did and not just that it did it. Bounds-checked like the index above, and optional: a driver
    // on the old build sends no row[6] and the watcher falls back to the class label alone.
    d.why = row.length > 6 && DRONE_WHY[row[6] | 0] !== undefined ? row[6] | 0 : WHY_ROAM;
    const t = typeof row[5] === 'string' ? decodeTail(row[5]) : null;
    if (t){ d.tail = t; d.tailSet = new Set(t); }
    if (d.alive && local.alive){ const hc = idx(Math.floor(row[1]), Math.floor(row[2])); if (local.tailSet.has(hc)) die(local, d.pk, ''); }
  }
  for (let i = 0; i < MAX_BOTS; i++) if (!seen.has(i)){ const d = players.get(dronePk(i)); if (d){ clearLand(d.slot); players.delete(d.pk); } }
}
const DRONE_NAMES = ['Nakamoto', 'Finney', 'Szabo', 'Back', 'Dai', 'Todd', 'Wuille', 'Maxwell'];
// Drone classes. The behaviour that reads these is driveDrone further down; the table lives up
// here with the other per-index drone constants because adoptDrone needs it initialised.
//
// The flock used to be seven copies of one habit — a random rectangle plan, a one-cell wall check
// and "head home when the tail passes 70" — and nothing in it ever looked at another player, so
// drones were scenery rather than opposition.
//
// The detail the classes are built around is in enterCell: entering someone ELSE'S tail kills
// them, not you. A drone can therefore only lose ground by leaving a long trail out while somebody
// walks up it. So "dumb" is not bad steering — it is big sloppy loops, long exposure and never
// checking its back, which is free territory for any rider willing to take the walk. "Smart" is
// tight loops, banking early, noticing a rider closing on its tail, and going to cut yours.
//
// One loop, six dials, three rows. A class is a row in this table, never a separate code path.
//   look   cells of wall and own tail it plans against
//   box    [min, span] leg length of its roaming loop — how sloppy the shape is
//   greed  tail length it will carry before banking; greedier is worth more to cut off
//   guard  radius at which it notices a rider closing on its own trail (0 = never looks back)
//   hunt   radius at which it goes for a rival's trail (0 = never hunts)
//   think  ms between decisions: reaction time
//   slip   chance a decision is fumbled outright
const DRONE_CLASSES = [
  { key: 'dumb',   label: 'drifter', look: 3, box: [6, 14], greed: 150, guard: 0,  hunt: 0,  think: 300, slip: .25 },
  { key: 'medium', label: 'steady',  look: 4, box: [4, 9],  greed: 85,  guard: 7,  hunt: 0,  think: 170, slip: .12 },
  { key: 'smart',  label: 'sharp',   look: 6, box: [3, 6],  greed: 55,  guard: 12, hunt: 18, think: 90,  slip: .05 },
];
// `look` is floored by `think`: at SPEED 7.5 a 300 ms drone has already covered 2.2 cells by the
// time it reacts, so a lookahead under that is dead weight — it cannot see far enough ahead to
// use what it saw. drone-classes.test.mjs holds that relationship, and caught this table when
// dumb was written with look 2.
// Class comes from the drone index and nothing else, so every client labels drone 3 identically
// for zero bytes on the wire — the flock row is already the fattest thing in a tick. Ordered so a
// three-drone grid gets one of each rather than three of the same.
const DRONE_CLASS_OF = [1, 0, 2, 0, 1, 2, 0];
const droneClass = i => DRONE_CLASSES[DRONE_CLASS_OF[((i | 0) % DRONE_CLASS_OF.length + DRONE_CLASS_OF.length) % DRONE_CLASS_OF.length]];
// The reason, in the order the brain considers them. These are not labels bolted on top: each one
// is set by the branch that actually fired, so what a watcher reads is what the drone did.
const WHY_ROAM = 0, WHY_CLAIM = 1, WHY_HOME = 2, WHY_DODGE = 3, WHY_GUARD = 4, WHY_HUNT = 5;
const DRONE_WHY = ['roaming', 'claiming', 'heading home', 'dodging', 'guarding its tail', 'hunting'];
const droneNote = p => `${droneClass(p.i).label} · ${DRONE_WHY[p.why | 0] || DRONE_WHY[WHY_ROAM]}`;
function ensureDrones(){ const humans = [...players.values()].filter(p => !p.drone && (p === local ? started : now() - p.last < 6000)).length; const want = Math.max(0, botsWanted - Math.max(0, humans - 1)); while (drones.length < want){ const i = drones.length;
    // Adopt rather than re-create. On a handover this drone is already in players with the last
    // position the previous authority published, and mkPlayer would replace it with a fresh
    // object at 0,0 — the whole flock would teleport to the corner the moment anyone took over.
    const had = players.has(dronePk(i)); const d = adoptDrone(i); d.plan = d.plan || [];
    if (!had) spawn(d);
    drones.push(d); } while (drones.length > want){ const d = drones.pop(); clearLand(d.slot); players.delete(d.pk); }
  // Sweep adopted strays. After a handover, the previous authority's flock sits in `players` but
  // not in `drones`, so the pop loop above never reaches it — and step() exempts drones from the
  // stale prune while we drive, so a client that inherited a flock kept driving it forever, even
  // with bots set to 0 ("drones off but I still see bots").
  for (const p of [...players.values()]) if (p.drone && drones.indexOf(p) < 0){ clearLand(p.slot); players.delete(p.pk); } }
const label = p => p.drone ? p.name : nameOf(p.pk);
function capture(p){
  for (const c of p.tail) owner[c] = p.slot;
  const seen = new Uint8Array(COLS * ROWS); const q = [];
  const push = (cx, cy) => { const i = idx(cx, cy); if (!seen[i] && owner[i] !== p.slot){ seen[i] = 1; q.push(i); } };
  for (let x = 0; x < COLS; x++){ push(x, 0); push(x, ROWS - 1); } for (let y = 0; y < ROWS; y++){ push(0, y); push(COLS - 1, y); }
  while (q.length){ const i = q.pop(); const cx = i % COLS, cy = (i - cx) / COLS; if (cx > 0) push(cx - 1, cy); if (cx < COLS - 1) push(cx + 1, cy); if (cy > 0) push(cx, cy - 1); if (cy < ROWS - 1) push(cx, cy + 1); }
  let gained = p.tail.length, sx = 0, sy = 0; for (let i = 0; i < owner.length; i++) if (!seen[i] && owner[i] !== p.slot){ owner[i] = p.slot; gained++; sx += i % COLS; sy += (i - i % COLS) / COLS; }
  const n = gained - p.tail.length; if (n > 0) rings.push({ x: (sx / n + .5) * CELL, y: (sy / n + .5) * CELL, r: 10, max: Math.sqrt(n) * CELL * 1.2, life: 1, color: colorOf(p, 1) });
  p.tail = []; p.tailSet = new Set();
  if (p === local){ if (gained > 20) feed(`you claimed ${gained} cells`, 'claim me'); sendLand(true); }
  else {
    // A watching client renders a drone's trail from the flock but never runs this capture, so
    // without publishing the result it would see the trail vanish and no territory appear.
    if (p.drone && iDrive() && net.ready) pub(signAsSess({ kind: K_EVT, tags: [['t', roomTag()]], content: JSON.stringify({ t: 'dland', i: p.i, rle: rleMine(p.slot) }) }));
    if (gained > 120) feed(`${label(p)} claimed ${gained} cells`, 'claim');
  }
}
function die(p, by, why, verb){
  if (!p.alive) return; p.alive = false; p.deaths++; p.diedAt = now(); clearLand(p.slot); p.tail = []; p.tailSet = new Set();
  killFx(p, p === local || by === me.sessPub);
  const killer = by && players.get(by); if (killer && killer !== p) killer.kills++;
  const who = label(p); const kn = killer ? label(killer) : null;
  feed(kn ? `${kn} ${verb || 'wiped out'} ${who}` : `${who} ${why || 'wiped out'}`, p === local || by === me.sessPub ? 'kill me' : 'kill');
  if (p === local){ $('deadBy').textContent = kn ? (verb ? verb + ' by ' : 'cut off by ') + kn : why; $('deadMsg').classList.remove('hidden'); setTimeout(() => $('deadMsg').classList.add('hidden'), RESPAWN_MS); if (navigator.vibrate) navigator.vibrate(120); if (net.ready) pub(signAsSess({ kind: K_EVT, tags: [['t', roomTag()]], content: JSON.stringify({ t: 'die', by: by || null, ...(verb === 'shot down' ? { how: 'shot' } : {}) }) })); }
}
// ---------- combat: bolts ----------
// A bolt lives entirely in cell space and hits the first living rider within BOLT_HIT_R. Deaths
// follow the same authority rules as tail cuts: your own death is always yours to detect (every
// client simulates every published bolt), a drone's death is applied by whoever may act for it,
// and a remote rider hit by YOUR bolt gets the same victim-honoured 'kill' event a tail cut sends.
const bolts = [];
function spawnBolt(pk, x, y, d, hue){ if (!mode.combat) return; bolts.push({ pk, x, y, d: d & 3, left: BOLT_RANGE, hue }); }
function fire(p){
  if (!mode.combat || !started || !p.alive || now() < (p.fireCd || 0)) return;
  p.fireCd = now() + FIRE_CD_MS + (p.drone ? Math.random() * 1200 : 0);
  spawnBolt(p.pk, p.x, p.y, p.d, p.hue);
  if (net.ready && (p === local || (p.drone && iDrive()))) pub(signAsSess({ kind: K_EVT, tags: [['t', roomTag()]], content: JSON.stringify({ t: 'shot', x: +p.x.toFixed(2), y: +p.y.toFixed(2), d: p.d, ...(p.drone ? { i: p.i } : {}) }) }));
}
function stepBolts(dt){
  outer: for (let i = bolts.length - 1; i >= 0; i--){
    const b = bolts[i]; const mv = BOLT_SPEED * dt; const [dx, dy] = DIRS[b.d]; b.x += dx * mv; b.y += dy * mv; b.left -= mv;
    if (b.left <= 0 || b.x < 0 || b.y < 0 || b.x >= COLS || b.y >= ROWS){ bolts.splice(i, 1); continue; }
    for (const q of players.values()){
      if (!q.alive || q.pk === b.pk) continue;
      if (Math.hypot(q.x - b.x, q.y - b.y) > BOLT_HIT_R) continue;
      bolts.splice(i, 1); burst(b.x * CELL, b.y * CELL, colorOf(q, 1), 18);
      const mine = b.pk === me.sessPub;
      if (q === local) die(local, b.pk, '', 'shot down');
      else if (q.drone){ if (iDrive() || mine){ die(q, b.pk, '', 'shot down'); if (mine && net.ready && !iDrive()) pub(signAsSess({ kind: K_EVT, tags: [['t', roomTag()], ['p', q.pk]], content: JSON.stringify({ t: 'kill', victim: q.pk, how: 'shot' }) })); } }
      else if (mine){ die(q, b.pk, '', 'shot down'); if (net.ready) pub(signAsSess({ kind: K_EVT, tags: [['t', roomTag()], ['p', q.pk]], content: JSON.stringify({ t: 'kill', victim: q.pk, how: 'shot' }) })); }
      // Somebody else's bolt hitting somebody else: the spark is shown, the death is the
      // victim's own client's call — it is simulating this same bolt.
      continue outer;
    }
  }
}
function enterCell(p, c){
  const cx = c % COLS, cy = (c - cx) / COLS;
  if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return die(p, null, 'hit the edge');
  if (p.tailSet.has(c)) return die(p, null, 'crossed their own tail');
  for (const q of players.values()){ if (q === p || !q.alive) continue; if (q.tailSet.has(c)){
      if (q === local) die(local, p.pk, '');
      else { die(q, p.pk, ''); if (p === local && net.ready && (!q.drone || !iDrive())) pub(signAsSess({ kind: K_EVT, tags: [['t', roomTag()], ['p', q.pk]], content: JSON.stringify({ t: 'kill', victim: q.pk }) })); } } }
  if (!p.alive) return;
  if (owner[c] === p.slot){ if (p.tail.length) capture(p); p.inside = true; }
  else { p.tail.push(c); p.tailSet.add(c); p.inside = false; if (p.tail.length > MAX_TAIL) die(p, null, 'stretched too thin'); }
}
function stepPlayer(p, dt){
  const sp = SPEED * (p.boostUntil > now() ? BOOST : 1) * dt; const [dx, dy] = DIRS[p.d]; p.x += dx * sp; p.y += dy * sp;
  const fx = Math.floor(p.x), fy = Math.floor(p.y);
  if (fx < 0 || fy < 0 || fx >= COLS || fy >= ROWS) return die(p, null, 'hit the edge');
  const c = idx(fx, fy);
  if (c !== p.cell){ p.cell = c; enterCell(p, c); if (!p.alive) return; if (p.nd !== p.d && (p.nd + 2) % 4 !== p.d){ p.d = p.nd; p.x = fx + .5; p.y = fy + .5; } }
}
function step(dt){
  for (const p of players.values()){
    if (!p.alive){ if ((p === local && started || p.drone) && now() - p.diedAt > RESPAWN_MS) spawn(p); continue; }
    if (p !== local && (!p.drone || !iDrive())){ if (now() - p.last > 8000){ clearLand(p.slot); players.delete(p.pk); continue; }
      // Glide toward the last network position, dead-reckoned along the rider's heading so they
      // keep moving between ticks instead of pausing on each one. Extrapolation is capped at
      // 350 ms so a stalled sender drifts to a stop instead of sailing through walls.
      if (p.netAt){ const sp = SPEED * (p.boostUntil > now() ? BOOST : 1); const [ddx, ddy] = DIRS[p.d];
        // Extrapolate from when the tick was SENT, not when it landed. netAt is arrival, so the
        // transit time was being rendered as staleness: on coolfeed that is ~65 ms of measured
        // round trip, half a tick at 10 Hz, and every remote rider sat that far behind where they
        // actually were. Still capped at 350 ms in total. This is cosmetic only — remote riders
        // never run stepPlayer(), and collisions read the tick's own x/y, not this glide.
        const ahead = Math.min((now() - p.netAt + oneWayMs()) / 1000, .35);
        const tx = p.netX + ddx * sp * ahead, ty = p.netY + ddy * sp * ahead;
        const k = Math.min(1, dt * 12); p.x += (tx - p.x) * k; p.y += (ty - p.y) * k; }
      continue; }
    if (p.drone){ driveDrone(p); if (mode.combat) droneMaybeFire(p); }
    stepPlayer(p, dt);
  }
  if (bolts.length) stepBolts(dt);
  for (const q of parts){ q.x += q.vx * dt; q.y += q.vy * dt; q.vy += 300 * dt; q.life -= dt * 1.4; } for (let i = parts.length - 1; i >= 0; i--) if (parts[i].life <= 0) parts.splice(i, 1);
  for (const f of floats){ f.y -= 26 * dt; f.life -= dt; } for (let i = floats.length - 1; i >= 0; i--) if (floats[i].life <= 0) floats.splice(i, 1);
  for (const r of rings){ r.r += (r.max - r.r) * dt * 4; r.life -= dt * 1.1; } for (let i = rings.length - 1; i >= 0; i--) if (rings[i].life <= 0) rings.splice(i, 1);
  if (iDrive()) ensureDrones(); else if (drones.length) drones = [];
}
// ---------- drone brains ----------
// One loop for all three classes; DRONE_CLASSES up by DRONE_NAMES is the table of dials, and the
// comment there is the why.
//
// Wall and own tail only. Another player's tail is not an obstacle — it is the prize.
function droneBlocked(p, d, n){
  const [dx, dy] = DIRS[d], cx = Math.floor(p.x), cy = Math.floor(p.y);
  for (let k = 1; k <= n; k++){
    const ax = cx + dx * k, ay = cy + dy * k;
    if (ax < 1 || ay < 1 || ax >= COLS - 1 || ay >= ROWS - 1) return true;
    if (p.tailSet.has(idx(ax, ay))) return true;
  }
  return false;
}
// Head for a cell: try the axis with the bigger gap first, then the other, and take neither if
// both are blocked at this class's lookahead. Reversing is not a legal turn (stepPlayer drops it),
// so it is filtered here rather than being set and silently ignored.
function droneSteer(p, tx, ty, why, look){
  const cx = Math.floor(p.x), cy = Math.floor(p.y), dx = tx - cx, dy = ty - cy;
  const opts = [];
  if (dx) opts.push(dx > 0 ? 0 : 2);
  if (dy) opts.push(dy > 0 ? 1 : 3);
  if (opts.length === 2 && Math.abs(dy) > Math.abs(dx)) opts.reverse();
  for (const d of opts){
    if ((d + 2) % 4 === p.d) continue;
    if (droneBlocked(p, d, look)) continue;
    p.nd = d; p.why = why; p.plan = []; return true;
  }
  return false;
}
// Nearest own cell. Same stride-3 sweep the old brain used — it is 4200 reads, and it now runs on
// the class's think cadence instead of every frame, so the sharpest drone pays it 11x a second
// rather than 60x.
function droneHome(p){
  const cx = Math.floor(p.x), cy = Math.floor(p.y);
  let best = null, bd = 1e9;
  for (let i = 0; i < owner.length; i += 3) if (owner[i] === p.slot){
    const ox = i % COLS, oy = (i - ox) / COLS, d = Math.abs(ox - cx) + Math.abs(oy - cy);
    if (d < bd){ bd = d; best = [ox, oy]; }
  }
  return best;
}
// Is a live rider closing on our trail? Sampled every 5th cell: a drone's sense of being followed
// is allowed to be coarse, and this runs for every drone on every think.
function droneThreat(p, r){
  for (const q of players.values()){
    if (q === p || !q.alive) continue;
    const qx = Math.floor(q.x), qy = Math.floor(q.y);
    for (let i = 0; i < p.tail.length; i += 5){
      const t = p.tail[i], tx = t % COLS, ty = (t - tx) / COLS;
      if (Math.abs(qx - tx) + Math.abs(qy - ty) <= r) return q;
    }
  }
  return null;
}
// Nearest cell of somebody else's trail within reach. Entering it wipes its owner out.
function droneQuarry(p, r){
  const cx = Math.floor(p.x), cy = Math.floor(p.y);
  let best = null, bd = r + 1;
  for (const q of players.values()){
    if (q === p || !q.alive) continue;
    for (let i = 0; i < q.tail.length; i += 3){
      const t = q.tail[i], tx = t % COLS, ty = (t - tx) / COLS, d = Math.abs(cx - tx) + Math.abs(cy - ty);
      if (d < bd){ bd = d; best = [tx, ty]; }
    }
  }
  return best;
}
function driveDrone(p){
  const c = droneClass(p.i);
  // Executing a decision already made, so it runs every frame: the plan's legs are counted in
  // cells, and gating them on the think cadence would miscount every leg.
  if (p.cell !== p.lastCell){
    p.lastCell = p.cell;
    if (p.plan.length){ p.legLeft--; if (p.legLeft <= 0){ p.plan.shift(); if (p.plan.length){ p.nd = p.plan[0][0]; p.legLeft = p.plan[0][1]; } } }
  }
  // Reflex: one cell, every frame, every class, ahead of both gates below. Planning is what a
  // drone is supposed to be bad at — one that walks into a wall it is already touching reads as
  // broken rather than as dumb.
  if (droneBlocked(p, p.nd, 1) || droneBlocked(p, p.d, 1)){
    const open = [(p.d + 1) % 4, (p.d + 3) % 4].filter(d => !droneBlocked(p, d, 1));
    if (open.length){ p.nd = open[Math.floor(Math.random() * open.length)]; p.plan = []; p.why = WHY_DODGE; }
    p.thinkAt = 0;
  }
  // Everything past here is a decision, and decisions cost time. `think` is the reaction delay —
  // at SPEED 7.5 a 300 ms drone has already covered 2.2 cells before it responds to anything —
  // and `slip` throws the decision away outright for a whole period. Both are non-zero for every
  // class including the sharpest: a drone you cannot beat is not a practice partner, it is a wall.
  if (now() < (p.thinkAt || 0)) return;
  p.thinkAt = now() + c.think;
  if (Math.random() < c.slip) return;
  // 1. Being followed with a trail out is the only way a drone loses ground, so looking back is
  //    the first thing the dumb class does not do.
  if (c.guard && p.tail.length > 4 && droneThreat(p, c.guard)){
    const h = droneHome(p);
    if (h && droneSteer(p, h[0], h[1], WHY_GUARD, c.look)) return;
  }
  // 2. A rival trail within reach is a kill.
  if (c.hunt && p.tail.length < c.greed){
    const q = droneQuarry(p, c.hunt);
    if (q && droneSteer(p, q[0], q[1], WHY_HUNT, c.look)) return;
  }
  // 3. Bank it.
  if (!p.inside && p.tail.length > c.greed){
    const h = droneHome(p);
    if (h && droneSteer(p, h[0], h[1], WHY_HOME, c.look)) return;
  }
  // 4. Nothing pressing: draw a loop out of our own land and follow it. Back inside with the plan
  //    nearly spent means the land is already banked, so start a fresh shape.
  if (p.inside && p.plan.length && p.plan.length < 3) p.plan = [];
  if (p.inside && !p.plan.length){
    const a = c.box[0] + Math.floor(Math.random() * c.box[1]), b = c.box[0] + Math.floor(Math.random() * c.box[1]), turnR = Math.random() < .5;
    let d0 = p.d; for (let i = 0; i < 4; i++){ if (!droneBlocked(p, d0, a + 1)) break; d0 = (d0 + 1) % 4; }
    const t = d => turnR ? (d + 1) % 4 : (d + 3) % 4;
    p.plan = [[d0, a], [t(d0), b], [t(t(d0)), a + 2], [t(t(t(d0))), 60]];
    p.legLeft = p.plan[0][1]; p.nd = p.plan[0][0]; p.lastCell = -1;
  }
  // The other thing that separates the classes: how far down its own committed heading a drone
  // looks before it changes its mind. The reflex above only ever sees the next cell.
  if (droneBlocked(p, p.nd, c.look)){
    const open = [(p.nd + 1) % 4, (p.nd + 3) % 4].filter(d => (d + 2) % 4 !== p.d && !droneBlocked(p, d, c.look));
    if (open.length){ p.nd = open[Math.floor(Math.random() * open.length)]; p.plan = []; p.why = WHY_DODGE; return; }
  }
  p.why = p.inside ? WHY_ROAM : WHY_CLAIM;
}
// Combat grids only, and deliberately outside driveDrone: the steering brain is lifted verbatim
// into the class tests, which have no netcode to stub. A rider lined up down the drone's heading
// is a target; the class's think delay and slip apply, so the sharp class snaps shots and the
// drifter misses its moment. Drones never shoot each other — the flock cannot thin itself out.
function droneMaybeFire(p){
  if (!p.alive || now() < (p.fireCd || 0) || now() < (p.aimAt || 0)) return;
  const c = droneClass(p.i);
  p.aimAt = now() + c.think;
  if (Math.random() < c.slip) return;
  const [fx, fy] = DIRS[p.d];
  for (const q of players.values()){
    if (q === p || !q.alive || q.drone) continue;
    const ddx = q.x - p.x, ddy = q.y - p.y;
    const along = ddx * fx + ddy * fy, across = Math.abs(ddx * fy - ddy * fx);
    if (along > 2 && along < BOLT_RANGE && across < .8){ fire(p); return; }
  }
}

// ---------- land sync ----------
function rleMine(s){ const runs = []; let cur = 0, n = 0; for (let i = 0; i < owner.length; i++){ const v = owner[i] === s ? 1 : 0; if (v === cur) n++; else { runs.push(n); cur = v; n = 1; } } runs.push(n); return runs.join(','); }
function applyRle(s, str){ clearLand(s); let i = 0, v = 0; for (const part of str.split(',')){ const n = Number(part) | 0; if (v) for (let k = 0; k < n && i + k < owner.length; k++) owner[i + k] = s; i += n; v ^= 1; } }
let lastKey = 0;
function sendLand(force){ if (!started || !net.ready) return; if (!force && now() - lastKey < KEY_MS) return; lastKey = now(); pub(signAsSess({ kind: K_EVT, tags: [['t', roomTag()]], content: JSON.stringify({ t: 'land', rle: rleMine(local.slot) }) })); }

// ---------- netcode ----------
// Ticks carry only their room tag. They also used to carry ['h', block height], which nothing
// ever read — and 'h' is NIP-29's group tag, so a relay implementing groups routes the event
// into its workspace plane and demands membership. strfry ignores it, which is why this only
// surfaced once the realtime plane moved to a single NIP-29-aware relay: every guest tick came
// back "auth-required: relay membership required to publish workspace content", so riders saw
// each other join and take land but never move. If a tick ever needs the block height, put it
// in the content — a single-letter tag is relay-reserved namespace, not app scratch space.
const net = { ready: false, lastTick: 0, sub: null, claimSub: null, gen: 0, retry: null };
// Ping, measured against nothing but our own clock. Every tick we publish comes straight back to
// us on our own subscription (measured: 40/40 on coolfeed), so the round trip is
// publish -> relay -> us, timed with one Date.now() at each end. No peer's created_at is
// involved, which matters: a rider with a skewed clock would otherwise poison the number, the
// same trapdoor that made `since` filters black out the grid.
//
// Nothing here can grow without bound: an id is dropped the moment it comes back, and anything
// still outstanding after PING_TIMEOUT is swept on the next tick.
const PING_TIMEOUT = 5000, PING_SMOOTH = .2;
const pings = new Map();
const ping = { ms: 0, lost: 0 };
function pingSent(id, at){
  pings.set(id, at);
  for (const [k, t] of pings) { if (at - t <= PING_TIMEOUT) break; pings.delete(k); ping.lost++; }
}
// Only ever called for an event whose id we published, so a replay of one of our own ticks can
// contribute at most one late sample and then never again.
function pingEcho(id){
  const at = pings.get(id); if (at === undefined) return;
  pings.delete(id);
  const rtt = now() - at; if (rtt > PING_TIMEOUT) return;
  ping.ms = ping.ms ? ping.ms + (rtt - ping.ms) * PING_SMOOTH : rtt;
}
// Half the round trip is the closest honest estimate of how stale a peer's tick is by the time we
// draw it, and it is a LOWER bound: a peer's tick travels their leg plus ours, and we can only
// see ours. Capped so a bad sample can never fling a rider across the grid.
const oneWayMs = () => Math.min(ping.ms / 2, 150);
function subscribe(){
  if (net.sub) { try { net.sub.close(); } catch {} } if (net.claimSub) { try { net.claimSub.close(); } catch {} } net.ready = false; $('hRelay').classList.remove('on');
  // Ticks published against the old subscription will never echo; keeping them would count every
  // one as lost and hold the map open until the sweep caught up.
  pings.clear();
  clearTimeout(net.retry); const gen = ++net.gen;
  // Ticks and events are live-only: `limit: 0` instead of a `since`. A client-clock `since` is a
  // trapdoor — a player whose clock runs fast stamps future timestamps but filters on its own
  // clock, so everyone else's honestly-stamped events fall outside the window and the grid looks
  // empty. No error, EOSE still fires. `limit: 0` asks the same question without a clock: strfry
  // (mostr, purplerelay) stores ephemeral kinds for ~5min and replays them without it, newlay
  // (coolfeed) never stores them at all, and all three honour it.
  // Claims live with the scores, so they are read from the relays they are written to. Their own
  // subscription: a claim is a stored lookup (session key -> npub, for display names) and must
  // not gate, or be gated by, the gameplay plane.
  net.claimSub = pool.subscribeMany(SCORE_RELAYS, [{ kinds: [K_CLAIM], '#t': [TAG], limit: 500 }], {
    onevent: e => { if (!verifyEvent(e)) return;
      const sp = e.tags.find(t => t[0] === 'p')?.[1];
      if (sp && /^[0-9a-f]{64}$/.test(sp) && sp !== me.sessPub){ claims.set(sp, e.pubkey); wantProfile(e.pubkey); } },
  });
  net.sub = pool.subscribeMany(GAME_RELAYS, [{ kinds: [K_TICK, K_EVT], '#t': [roomTag()], limit: 0 }], {
    onevent: e => {
      // Our own events come back to us and were only ever going to be discarded, so discard them
      // before paying for a signature check — that is a fifth of the verification at two riders
      // and the whole cost when riding alone. Safe because an impostor stamping our pubkey on an
      // event lands in exactly the same branch: dropped, unread. It buys them nothing, and
      // pingEcho only accepts ids we published ourselves.
      if (e.pubkey === me.sessPub){ pingEcho(e.id); return; }
      if (!verifyEvent(e)) return;
      // Belt and braces for a relay that ignores `limit: 0`: anything before EOSE is stored
      // history, and a replayed shot or death would be applied as if it just happened.
      if (!net.ready) return;
      let c; try { c = JSON.parse(e.content); } catch { return; }
      const fresh = !players.has(e.pubkey); const p = players.get(e.pubkey) || mkPlayer(e.pubkey); if (!claims.has(e.pubkey)) wantProfile(e.pubkey);
      if (fresh){ feed(`${nameOf(e.pubkey)} joined the grid`); sendLand(true); }
      if (e.kind === K_TICK){
        // The flock rides on the authority's own tick. Ignore it from anyone else, and ignore it
        // entirely while we are the ones driving — otherwise a stale authority's rows fight ours.
        if (Array.isArray(c.dr) && !iDrive() && e.pubkey === droneAuthority()) applyFlock(c.dr);
        if (typeof c.x !== 'number') return; p.d = c.d & 3;
        // Ticks arrive at TICK_HZ; the draw loop runs at 60. Snapping x/y here made remote riders
        // teleport between tick positions. Store the network position and let step() glide toward
        // it — snap only on first sight, respawn, or a jump too big to be motion (> 4 cells).
        if (!p.alive && c.a || Math.hypot(c.x - p.x, c.y - p.y) > 4){ p.x = c.x; p.y = c.y; }
        p.netX = c.x; p.netY = c.y; p.netAt = now();
        p.alive = !!c.a; p.kills = c.k | 0; p.deaths = c.dd | 0; p.boostUntil = c.b ? now() + 300 : 0; p.last = now();
        if (Array.isArray(c.st)){ p.hue = (c.st[0] | 0) % 360; p.pat = Math.min(PATTERNS.length - 1, c.st[1] | 0); }
        if (typeof c.tp === 'string'){ const t = decodeTail(c.tp); if (t){ p.tail = t; p.tailSet = new Set(t); } }
        // Legacy raw-array tails, kept so a not-yet-reloaded client's ticks still render.
        else if (Array.isArray(c.tl)){ p.tail = c.tl.filter(n => Number.isInteger(n) && n >= 0 && n < owner.length).slice(-MAX_TAIL); p.tailSet = new Set(p.tail); }
        if (p.alive && local.alive){ const hc = idx(Math.floor(c.x), Math.floor(c.y)); if (local.tailSet.has(hc)) die(local, p.pk, ''); } }
      else if (e.kind === K_EVT){ p.last = now();
        if (c.t === 'land' && typeof c.rle === 'string' && c.rle.length < 30000) applyRle(p.slot, c.rle);
        else if (c.t === 'die'){
          // A death we applied locally under two seconds ago (our bolt, or their tail on our sim)
          // makes this event a pure echo — and the alive flag alone cannot tell: the victim's last
          // pre-death tick often lands in between and briefly flips them alive again. Respawn takes
          // 2.5 s, so a real second death can never be this close. Counting the echo doubled the
          // shooter's kills, which in combat mode is the score.
          if (now() - p.diedAt < 1500){ p.alive = false; }
          else { if (p.alive){ p.alive = false; killFx(p, c.by === me.sessPub); const kn = c.by && players.get(c.by) ? label(players.get(c.by)) : c.by === me.sessPub ? nameOf(me.sessPub) : null; const vb = c.how === 'shot' ? 'shot down' : 'wiped out'; feed(kn ? `${kn} ${vb} ${nameOf(p.pk)}` : `${nameOf(p.pk)} ${vb}`, c.by === me.sessPub ? 'kill me' : 'kill'); if (c.by === me.sessPub) local.kills++; } p.diedAt = now(); clearLand(p.slot); p.tail = []; p.tailSet = new Set(); } }
        else if (c.t === 'shot' && mode.combat && typeof c.x === 'number' && typeof c.y === 'number'){
          // A drone's shot (c.i set) is honoured only from the flock authority — same single-writer
          // rule as the flock rows themselves. A rider's shot is their own.
          if (Number.isInteger(c.i)){ if (c.i >= 0 && c.i < MAX_BOTS && !iDrive() && e.pubkey === droneAuthority()){ const d = players.get(dronePk(c.i)); spawnBolt(dronePk(c.i), c.x, c.y, c.d & 3, d ? d.hue : 200); } }
          else spawnBolt(e.pubkey, c.x, c.y, c.d & 3, p.hue); }
        else if (c.t === 'dland' && typeof c.rle === 'string' && c.rle.length < 30000){
          if (!iDrive() && e.pubkey === droneAuthority()){ const i = c.i | 0; if (i >= 0 && i < MAX_BOTS) applyRle(adoptDrone(i).slot, c.rle); } }
        else if (c.t === 'kill'){
          const vb = c.how === 'shot' ? 'shot down' : undefined;
          if (c.victim === me.sessPub) die(local, e.pubkey, '', vb);
          // A rider who cuts off a drone reports it; only the authority acts on that, so the
          // flock has exactly one writer.
          else if (iDrive() && typeof c.victim === 'string' && c.victim.startsWith('drone')){
            const d = players.get(c.victim); if (d && d.drone) die(d, e.pubkey, '', vb); } } } },
    oneose: () => { net.ready = true; $('hRelay').classList.add('on'); },
    // nostr-tools 2.10.4 has no reconnect of its own, so a dropped subscription stays dropped and
    // the rider silently stops seeing anyone. This fires once every relay is gone; come back with
    // a fresh subscription. `gen` keeps a late close from resurrecting a subscription we replaced.
    onclose: () => { if (gen !== net.gen) return; net.ready = false; $('hRelay').classList.remove('on');
      clearTimeout(net.retry); net.retry = setTimeout(() => { if (gen === net.gen) subscribe(); }, 2000); } });
}
// A tail is a path of edge-adjacent cells, so it compresses to a start cell plus run-length
// directions ("2f4R12U5L3") instead of up to 500 raw indices. Every tick still carries the
// COMPLETE tail — nothing accumulates between ticks, so a late joiner's first tick is enough —
// but a full tail is now tens of bytes instead of ~2.5 KB, which per rider at tick rate is the
// difference between a ~3 KB/s room and the ~105 KB/s that was drowning phones.
const DIRCH = { 1: 'R', [-1]: 'L', [COLS]: 'D', [-COLS]: 'U' }, CHDIR = { R: 1, L: -1, D: COLS, U: -COLS };
function encodeTail(cells){
  if (!cells.length) return '';
  let s = cells[0].toString(36), runCh = '', runN = 0;
  for (let i = 1; i < cells.length; i++){
    const ch = DIRCH[cells[i] - cells[i - 1]]; if (!ch) return null; // non-adjacent: caller falls back to raw tl
    if (ch === runCh) runN++; else { if (runN) s += runCh + runN; runCh = ch; runN = 1; }
  }
  if (runN) s += runCh + runN;
  return s;
}
function decodeTail(str){
  if (typeof str !== 'string' || str.length > 4000) return null; if (!str) return [];
  const m = str.match(/^([0-9a-z]+)((?:[RLDU]\d+)*)$/); if (!m) return null;
  let c = parseInt(m[1], 36); if (!(c >= 0 && c < COLS * ROWS)) return null;
  const out = [c];
  for (const run of m[2].matchAll(/([RLDU])(\d+)/g)){
    const d = CHDIR[run[1]]; let n = +run[2];
    while (n--){ c += d; if (c < 0 || c >= COLS * ROWS || out.length >= MAX_TAIL) return null; out.push(c); }
  }
  return out;
}
function tick(){ if (!started || !net.ready) return; if (now() - net.lastTick < 1000 / TICK_HZ) return; net.lastTick = now();
  const tail = local.tail.slice(-MAX_TAIL), tp = encodeTail(tail);
  // The whole flock rides in this same event: seven separate drone events would mean seven
  // schnorr signatures per tick, 42 a second, for no benefit.
  const flock = iDrive() && drones.length
    // row[6] is the drone's current reason — one small int, the only thing the classes cost the
    // wire. The class itself is derived from row[0] on every client, so it costs nothing.
    ? drones.map(d => [d.i, +d.x.toFixed(2), +d.y.toFixed(2), d.d, d.alive ? 1 : 0, encodeTail(d.tail.slice(-MAX_TAIL)), d.why | 0])
    : null;
  // The tick is the ping's carrier: it already goes out on a fixed cadence, so timing its echo
  // costs one map entry and no extra traffic.
  const ev = signAsSess({ kind: K_TICK, tags: [['t', roomTag()]], content: JSON.stringify({ x: +local.x.toFixed(2), y: +local.y.toFixed(2), d: local.d, a: local.alive ? 1 : 0, k: local.kills, dd: local.deaths, b: local.boostUntil > now() ? 1 : 0, st: [style.hue, style.pat], ...(tp === null ? { tl: tail } : { tp }), ...(flock ? { dr: flock, nb: botsWanted } : {}) }) });
  pingSent(ev.id, now()); pub(ev);
  sendLand(false); }

// ---------- rooms: presence beacons and the live-grid list ----------
let beaconT = null;
async function beacon(){
  if (!started || !me.id) return;
  const at = Math.floor(Date.now()/1000); landCounts();
  const payload = { room: room.name, name: (me.guest ? 'guest-' + me.sessPub.slice(0, 4) : nameOf(me.sessPub)).slice(0, 16), hue: style.hue, role: 'seat', at, block: chain.height || undefined, bots: botsWanted, land: +(local.land / (COLS * ROWS) * 100).toFixed(1), ...(mode.combat ? { mode: 'combat' } : {}) };
  const tags = [['d', PRESENCE_D], ...(room.listed ? [['t', PRESENCE_TAG]] : []), ['t', roomTag()], ['expiration', String(at + PRESENCE_TTL_S)]];
  try { const ev = me.guest ? signAsSess({ kind: K_PRESENCE, tags, content: JSON.stringify(payload) }) : await signAsMe({ kind: K_PRESENCE, tags, content: JSON.stringify(payload) }); pub(ev); } catch {}
}
function startBeacon(){ clearInterval(beaconT); beacon(); beaconT = setInterval(beacon, BEACON_MS); }
function groupRooms(evs){
  // A combat grid and a classic grid may share a room name but are different tags, so the card
  // list keys on name + mode and each card knows which one it is.
  const rooms = new Map(); const cutoff = Math.floor(Date.now()/1000) - PRESENCE_TTL_S * 3;
  for (const e of evs){ let p; try { p = JSON.parse(e.content); } catch { continue; } if (!p || typeof p.room !== 'string' || e.created_at < cutoff) continue; const r = cleanRoom(p.room); const combat = p.mode === 'combat'; const key = r + (combat ? '|combat' : ''); let g = rooms.get(key); if (!g) rooms.set(key, g = { name: r, combat, occ: new Map() }); const prev = g.occ.get(e.pubkey); if (!prev || prev.at < e.created_at) g.occ.set(e.pubkey, { pk: e.pubkey, name: String(p.name || '').slice(0, 16), hue: p.hue | 0, at: e.created_at, block: p.block, bots: p.bots, land: p.land }); }
  const out = [...rooms.values()].map(g => { const riders = [...g.occ.values()].sort((a, b) => b.at - a.at); const bots = riders.find(r => typeof r.bots === 'number')?.bots; return { name: g.name, combat: g.combat, riders, open: Math.max(0, SEATS - riders.length), block: riders[0]?.block, bots, freshest: riders[0]?.at || 0 }; });
  if (!out.some(r => r.name === 'lobby' && !r.combat)) out.push({ name: 'lobby', combat: false, riders: [], open: SEATS, standing: true, freshest: 0 });
  return out.sort((a, b) => b.riders.length - a.riders.length || b.freshest - a.freshest);
}
async function fetchLiveRooms(){ const evs = await pool.querySync(GAME_RELAYS, { kinds: [K_PRESENCE], '#t': [PRESENCE_TAG], limit: 300 }, { maxWait: 3500 }).catch(() => []); return groupRooms(evs.filter(e => verifyEvent(e))); }
let liveT = null;
async function renderLive(){
  const list = await fetchLiveRooms(); const box = $('liveRooms'); if (!box) return;
  for (const r of list) for (const o of r.riders) wantProfile(o.pk);
  box.innerHTML = list.slice(0, 8).map(r => { const dots = r.riders.slice(0, SEATS).map(o => `<i title="${esc(o.name || nameOf(o.pk))}" style="background:hsl(${o.hue},95%,60%)"></i>`).join(''); const bits = []; if (r.combat) bits.push('⚔️ combat'); if (r.block) bits.push('block ' + Number(r.block).toLocaleString()); if (typeof r.bots === 'number') bits.push(r.bots + ' drone' + (r.bots === 1 ? '' : 's')); if (r.standing) bits.push('the standing grid · always open'); const here = r.name === room.name && !!r.combat === mode.combat;
    return `<div class="lr${here ? ' here' : ''}"><div class="lrt"><b>${esc(r.name)}${r.combat ? ' ⚔️' : ''}</b><span class="seats ${r.open ? 'open' : 'full'}">${r.riders.length}/${SEATS}</span></div><div class="dots">${dots || '<span class="muted small">nobody riding</span>'}</div><div class="small muted">${bits.join(' · ')}</div><button class="btn ghost tiny" data-join="${esc(r.name)}" data-mode="${r.combat ? 'combat' : 'classic'}">${here ? 'this grid' : r.open ? 'Join' : 'Squeeze in'}</button></div>`; }).join('');
  box.querySelectorAll('[data-join]').forEach(b => { b.onclick = () => { setMode(b.dataset.mode === 'combat'); setRoom(b.dataset.join); }; });
}
function setRoom(name, opts = {}){
  const n = cleanRoom(name); const changed = n !== room.name; room.name = n; if (opts.listed !== undefined) room.listed = !!opts.listed;
  localStorage.setItem('br_room', n); localStorage.setItem('br_room_private', room.listed ? '0' : '1');
  syncRoomUI(); if (changed){ bolts.length = 0; for (const p of [...players.values()]) if (p !== local && !p.drone){ clearLand(p.slot); players.delete(p.pk); } subscribe(); if (started){ feed(`moved to grid “${n}”`); sendLand(true); startBeacon(); } }
  history.replaceState(null, '', inviteUrl().replace(location.origin, ''));
}
// Same shape as setRoom: a mode change is a tag change, so it clears the remote roster and
// resubscribes. Bolts in flight belong to the grid being left.
function setMode(combat, opts = {}){
  combat = !!combat; if (combat === mode.combat){ syncModeUI(); return; }
  mode.combat = combat; localStorage.setItem('br_mode', combat ? 'combat' : 'classic');
  bolts.length = 0; local.fireCd = 0;
  for (const p of [...players.values()]) if (p !== local && !p.drone){ clearLand(p.slot); players.delete(p.pk); }
  subscribe(); syncModeUI(); syncRoomUI();
  if (started && !opts.quiet){ feed(combat ? 'combat grid — F or the FIRE button shoots' : 'classic grid'); sendLand(true); startBeacon(); }
  history.replaceState(null, '', inviteUrl().replace(location.origin, ''));
}
function syncModeUI(){ $('modeClassic').classList.toggle('on', !mode.combat); $('modeCombat').classList.toggle('on', mode.combat); $('btnFire').classList.toggle('hidden', !mode.combat); $('inviteUrl').textContent = inviteUrl().replace(/^https?:\/\//, ''); }
function inviteUrl(){ const u = new URL(location.origin + '/game'); if (room.name !== 'lobby') u.searchParams.set('room', room.name); if (mode.combat) u.searchParams.set('mode', 'combat'); if (botsWanted !== 5) u.searchParams.set('bots', String(botsWanted)); if (!room.listed) u.searchParams.set('private', '1'); return u.toString(); }
function syncRoomUI(){ $('roomIn').value = room.name; $('hRoom').textContent = room.name + (mode.combat ? ' ⚔️' : ''); $('privToggle').classList.toggle('on', !room.listed); $('privToggle').textContent = room.listed ? 'Listed' : 'Private'; $('inviteUrl').textContent = inviteUrl().replace(/^https?:\/\//, ''); }
async function share(btn){
  const url = inviteUrl(); const text = `Ride with me on HODLAND, grid “${room.name}”. Claim land on the BLAKE2b grid, rounds are blocks.`;
  if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) { try { await navigator.share({ title: 'HODLAND', text, url }); return; } catch {} }
  try { await navigator.clipboard.writeText(url); const old = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => btn.textContent = old, 1500); } catch { prompt('Copy this link', url); }
}
// ---------- bots (drones) stepper ----------
function setBots(n){ botsWanted = Math.max(0, Math.min(MAX_BOTS, Math.floor(Number(n) || 0))); if (botsWanted) botsLast = botsWanted; localStorage.setItem('br_bots', String(botsWanted)); syncBotsUI(); ensureDrones(); if (started) feed(botsWanted ? `${botsWanted} drone${botsWanted === 1 ? '' : 's'} on the grid` : 'drones off'); history.replaceState(null, '', inviteUrl().replace(location.origin, '')); }
function syncBotsUI(){ for (const id of ['botsLbl', 'botsLbl2']) $(id).textContent = botsWanted ? `Drones: ${botsWanted}` : 'Drones: off'; for (const id of ['botsLess', 'botsLess2']) $(id).disabled = botsWanted <= 0; for (const id of ['botsMore', 'botsMore2']) $(id).disabled = botsWanted >= MAX_BOTS; $('inviteUrl').textContent = inviteUrl().replace(/^https?:\/\//, ''); }

// ---------- rounds, scores, leaderboards ----------
function landCounts(){ const n = new Uint32Array(slots.length); for (let i = 0; i < owner.length; i++) n[owner[i]]++; for (const p of players.values()) p.land = n[p.slot] || 0; }
const pct = p => (p.land / (COLS * ROWS) * 100).toFixed(1) + '%';
const kd = (k, d) => d ? (k / d).toFixed(2) : k ? k.toFixed(2) : '—';
function standings(){ landCounts(); return [...players.values()].filter(p => p.drone || p === local || now() - p.last < 8000).sort((a, b) => mode.combat ? (b.kills - a.kills || b.land - a.land) : (b.land - a.land || b.kills - a.kills)); }
const rowHTML = (p, i) => { const href = p.drone ? null : npubLink(p.pk); return `<${href ? `a href="${href}" target="_blank" rel="noopener"` : 'div'} class="p"><span class="mono muted">${i + 1}</span><img src="${p.drone ? avatar(p.pk) : picOf(p.pk)}" alt=""><span>${esc(label(p))}${p.drone ? ` <span class="sub">${esc(droneNote(p))}</span>` : ''}</span><b>${pct(p)} · ${p.kills}✂ ${p.deaths}☠</b></${href ? 'a' : 'div'}>`; };
async function roundOver(prevHeight){
  const rows = standings(); $('podBlock').textContent = prevHeight.toLocaleString(); $('podList').innerHTML = rows.slice(0, 8).map(rowHTML).join('') || '<div class="sys">Nobody rode this block.</div>'; $('podium').classList.remove('hidden');
  if (rows[0]){ feed(`block ${prevHeight.toLocaleString()} goes to ${label(rows[0])} with ${pct(rows[0])}`, 'claim'); celebrateWinner(rows[0], prevHeight); }
  if (started && me.id){ try { const ev = await signAsMe({ kind: K_SCORE, tags: [['t', TAG], ['t', `${TAG}-${prevHeight}`], ['d', String(prevHeight)], ['client', 'blakerunner']], content: JSON.stringify({ height: prevHeight, land: local.land, cells: COLS * ROWS, kills: local.kills, deaths: local.deaths, chain: 'blake2b', mode: mode.combat ? 'combat' : 'classic' }) }); await Promise.any(pool.publish(SCORE_RELAYS, ev)); $('podNote').textContent = 'Your result is signed by your npub and on the relays.'; } catch (e) { $('podNote').textContent = 'Could not publish your score: ' + e.message; } }
  setTimeout(() => { $('podium').classList.add('hidden'); owner.fill(0); for (const p of players.values()){ p.kills = 0; p.deaths = 0; if (p === local ? started : true) spawn(p); } }, 7000);
}
async function fetchScores(limit = 500){ const evs = await pool.querySync(SCORE_RELAYS, { kinds: [K_SCORE], '#t': [TAG], limit }, { maxWait: 4000 }).catch(() => []); const rows = []; const seen = new Set(); for (const e of evs){ const h = Number(e.tags.find(t => t[0] === 'd')?.[1]);
    // Some early events carry a unix timestamp where the height belongs; a BLAKE2b height is
    // ~1e6, a timestamp ~1.8e9. Anything past 50M is not a block on this chain.
    if (!h || h > 50e6 || seen.has(e.pubkey + h)) continue; seen.add(e.pubkey + h); let c = {}; try { c = JSON.parse(e.content); } catch {} rows.push({ pk: e.pubkey, h, land: c.land | 0, cells: c.cells || COLS * ROWS, kills: c.kills | 0, deaths: c.deaths | 0 }); } return rows; }
async function lastPodium(){ const rows = await fetchScores(80); if (!rows.length) return; const top = Math.max(...rows.map(r => r.h)); const rr = rows.filter(r => r.h === top).sort((a, b) => b.land - a.land); for (const r of rr) wantProfile(r.pk); $('lastPodium').innerHTML = `<div class="muted small" style="text-align:center">Last signed round · block ${top.toLocaleString()}</div>` + rr.slice(0, 5).map((r, i) => `<a class="p" href="/p/${nip19.npubEncode(r.pk)}" target="_blank" rel="noopener"><span class="mono muted">${i + 1}</span><img src="${picOf(r.pk)}" alt=""><span>${esc(nameOf(r.pk))}</span><b>${(r.land / r.cells * 100).toFixed(1)}%</b></a>`).join(''); }
// Block wall (Tank Arena pattern): one card per block in chain order, the way an explorer shows
// blocks — the winner is whoever published the biggest signed land number for that height. Same
// caveat as the whole screen: these are self-signed claims, winning means publishing the number.
async function blockWall(){
  const rows = await fetchScores(500); if (!rows.length){ $('boardBlocks').innerHTML = '<div class="sys">No signed rounds on the relays yet. Be the first.</div>'; return; }
  const byH = new Map(); for (const r of rows){ let b = byH.get(r.h); if (!b) byH.set(r.h, b = { h: r.h, riders: 0, win: r }); b.riders++; if (r.land > b.win.land) b.win = r; }
  const blocks = [...byH.values()].sort((a, b) => b.h - a.h).slice(0, 30); for (const b of blocks) wantProfile(b.win.pk);
  $('boardBlocks').innerHTML = blocks.map(b => `<a class="p won" href="/p/${nip19.npubEncode(b.win.pk)}" target="_blank" rel="noopener"><span class="bh">#${b.h.toLocaleString()}</span><img src="${picOf(b.win.pk)}" alt=""><span>${esc(nameOf(b.win.pk))}<br><span class="sub">${b.riders} rider${b.riders === 1 ? '' : 's'} signed · ${b.win.kills}✂ ${b.win.deaths}☠</span></span><b>${(b.win.land / b.win.cells * 100).toFixed(1)}%</b></a>`).join('')
    + (byH.size > 30 ? '<div class="sys">…older blocks fell off the wall.</div>' : '');
}
async function career(){
  const rows = await fetchScores(500); if (!rows.length){ $('boardCareer').innerHTML = '<div class="sys">No signed rounds on the relays yet. Be the first.</div>'; return; }
  const byH = new Map(); for (const r of rows){ if (!byH.has(r.h) || byH.get(r.h).land < r.land) byH.set(r.h, r); }
  const agg = new Map(); for (const r of rows){ const a = agg.get(r.pk) || { pk: r.pk, rounds: 0, wins: 0, kills: 0, deaths: 0, best: 0 }; a.rounds++; a.kills += r.kills; a.deaths += r.deaths; a.best = Math.max(a.best, r.land / r.cells * 100); agg.set(r.pk, a); } for (const w of byH.values()) agg.get(w.pk).wins++;
  const list = [...agg.values()].sort((a, b) => b.wins - a.wins || b.best - a.best).slice(0, 25); for (const a of list) wantProfile(a.pk);
  $('boardCareer').innerHTML = list.map((a, i) => `<a class="p" href="/p/${nip19.npubEncode(a.pk)}" target="_blank" rel="noopener"><span class="mono muted">${i + 1}</span><img src="${picOf(a.pk)}" alt=""><span>${esc(nameOf(a.pk))}<br><span class="sub">${a.rounds} round${a.rounds === 1 ? '' : 's'} · ${a.kills}✂ ${a.deaths}☠ · K/D&nbsp;${kd(a.kills, a.deaths)}</span></span><b>${a.wins} block${a.wins === 1 ? '' : 's'} · best ${a.best.toFixed(1)}%</b></a>`).join('');
}

// ---------- render ----------
const cv = $('cv'), cx = cv.getContext('2d'); let vw = 0, vh = 0, dpr = 1;
function resize(){ dpr = Math.min(2, window.devicePixelRatio || 1); vw = cv.clientWidth; vh = cv.clientHeight; cv.width = vw * dpr; cv.height = vh * dpr; }
window.addEventListener('resize', resize); resize();
const cam = { x: W/2, y: H/2 }; const parts = [], rings = [], floats = []; let camZoom = 1;
const colorOf = (p, a) => `hsla(${p.hue},95%,60%,${a})`;
function burst(x, y, color, n){ for (let i = 0; i < n; i++){ const a = Math.random() * Math.PI * 2, s = 80 + Math.random() * 260; parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 80, life: .8 + Math.random() * .5, color, sz: 3 + Math.random() * 5 }); } }
// ---------- juice: shake, floating text, celebrations ----------
let shakeUntil = 0, shakeAmp = 0;
// Shake only for kills the local rider is part of: constant shake for other people's fights
// would read as jank, not impact.
function kick(amp){ shakeAmp = Math.max(shakeAmp, amp); shakeUntil = now() + 260; }
function float(x, y, text, color, big = false){ floats.push({ x, y, text, color, big, life: big ? 2.4 : 1.3 }); }
// A death is the game's loudest beat, so it gets the full stack: two-tone burst, an expanding
// shockwave ring, and the name drifting up from the wreck.
function killFx(p, mine){
  const px = p.x * CELL, py = p.y * CELL;
  burst(px, py, colorOf(p, 1), 44); burst(px, py, 'rgba(255,255,255,.95)', 18);
  rings.push({ x: px, y: py, r: 6, max: CELL * 5.5, life: 1, color: colorOf(p, 1) });
  float(px, py - CELL, `${label(p)} ✂`, colorOf(p, 1));
  if (mine) kick(7);
}
// Block rollover: shower the winner's colours from above the visible sky and stamp the win in
// the world, not just the podium list.
function celebrateWinner(p, height){
  const ww = vw / camZoom, wh = vh / camZoom; // world-units extent of the current view
  for (let i = 0; i < 130; i++) parts.push({ x: cam.x - ww / 2 + Math.random() * ww, y: cam.y - wh / 2 - Math.random() * 120,
    vx: (Math.random() - .5) * 120, vy: 60 + Math.random() * 160, life: 1.6 + Math.random() * 1.2,
    color: `hsla(${(p.hue + (Math.random() * 60 - 30) + 360) % 360},95%,${55 + Math.random() * 25}%,.95)`, sz: 3 + Math.random() * 6 });
  float(cam.x, cam.y - wh * .18, `👑 ${label(p)} takes block ${height.toLocaleString()}`, colorOf(p, 1), true);
  if (p === local) kick(6);
}
// Territory used to be drawn one canvas call per owned cell, so frame time grew with how much
// land was on the board — a fully owned grid cost thousands of rects every frame in the world
// layer and thousands more in the minimap. Both layers now walk rows and emit one rect per
// horizontal run of same-owner cells. `step` is the sampling stride (1 for the world grid, 2 for
// the minimap); each run is [x, y, width] in cell units, and a run's height is `step` cells.
// The trailing flush matters: without it a run touching the right edge is dropped.
function ownerRuns(x0, y0, x1, y1, step){
  const runs = new Map();
  const add = (s, x, y, w) => { let a = runs.get(s); if (!a){ a = []; runs.set(s, a); } a.push(x, y, w); };
  for (let y = y0; y < y1; y += step){
    let s = 0, from = x0, x = x0;
    for (; x < x1; x += step){ const v = owner[idx(x, y)]; if (v === s) continue; if (s) add(s, from, y, x - from); s = v; from = x; }
    if (s) add(s, from, y, x - from);
  }
  return runs;
}
function draw(){
  const small = vw < 760; const zoom = Math.max(small ? .7 : .55, Math.min(vw / (small ? 900 : 1500), vh / (small ? 700 : 1000), 1)); const tx = started ? local.x * CELL : W/2, ty = started ? local.y * CELL : H/2;
  cam.x += (tx - cam.x) * .12; cam.y += (ty - cam.y) * .12; cam.x = Math.max(vw/2/zoom, Math.min(W - vw/2/zoom, cam.x)); cam.y = Math.max(vh/2/zoom, Math.min(H - vh/2/zoom, cam.y));
  camZoom = zoom;
  // Impact shake: a decaying random offset on the camera, only ever kicked by local kills.
  let shx = 0, shy = 0;
  if (shakeUntil > now()){ const k = shakeAmp * (shakeUntil - now()) / 260; shx = (Math.random() - .5) * 2 * k; shy = (Math.random() - .5) * 2 * k; } else shakeAmp = 0;
  cx.setTransform(dpr, 0, 0, dpr, 0, 0); cx.clearRect(0, 0, vw, vh);
  const g = cx.createLinearGradient(0, 0, 0, vh); g.addColorStop(0, '#1a0640'); g.addColorStop(1, '#0b0220'); cx.fillStyle = g; cx.fillRect(0, 0, vw, vh);
  cx.translate(vw/2 - cam.x * zoom + shx, vh/2 - cam.y * zoom + shy); cx.scale(zoom, zoom);
  const x0 = Math.max(0, Math.floor((cam.x - vw/2/zoom) / CELL) - 1), x1 = Math.min(COLS, Math.ceil((cam.x + vw/2/zoom) / CELL) + 1), y0 = Math.max(0, Math.floor((cam.y - vh/2/zoom) / CELL) - 1), y1 = Math.min(ROWS, Math.ceil((cam.y + vh/2/zoom) / CELL) + 1);
  const bySlot = new Map(); for (const p of players.values()) bySlot.set(p.slot, p);
  // land: batch runs per player so each fillStyle (pattern) is set once. The per-cell gutter is
  // baked into the pattern tile by landFill(), so these rects are flush.
  const runs = ownerRuns(x0, y0, x1, y1, 1);
  for (const [s, arr] of runs){ const p = bySlot.get(s); if (!p) continue; cx.fillStyle = landFill(p.hue, p.pat, p.alive ? .5 : .2); cx.beginPath(); for (let i = 0; i < arr.length; i += 3) cx.rect(arr[i] * CELL, arr[i + 1] * CELL, arr[i + 2] * CELL, CELL); cx.fill(); }
  const hue = chain.seed % 360; cx.lineWidth = 1; cx.strokeStyle = `hsla(${(hue + 180) % 360},100%,70%,.10)`; cx.beginPath(); for (let x = x0; x <= x1; x++){ cx.moveTo(x * CELL, y0 * CELL); cx.lineTo(x * CELL, y1 * CELL); } for (let y = y0; y <= y1; y++){ cx.moveTo(x0 * CELL, y * CELL); cx.lineTo(x1 * CELL, y * CELL); } cx.stroke();
  for (const p of players.values()){ if (!p.alive || !p.tail.length) continue; cx.fillStyle = colorOf(p, .9); cx.shadowColor = colorOf(p, 1); cx.shadowBlur = 10; cx.beginPath(); for (const c of p.tail){ const tx2 = c % COLS, ty2 = (c - tx2) / COLS; if (tx2 < x0 || tx2 > x1 || ty2 < y0 || ty2 > y1) continue; cx.rect(tx2 * CELL + 3, ty2 * CELL + 3, CELL - 6, CELL - 6); } cx.fill(); cx.shadowBlur = 0; }
  for (const r of rings){ cx.strokeStyle = r.color; cx.globalAlpha = Math.max(0, r.life) * .9; cx.lineWidth = 4; cx.beginPath(); cx.arc(r.x, r.y, r.r, 0, Math.PI * 2); cx.stroke(); cx.globalAlpha = 1; }
  cx.lineCap = 'round';
  for (const b of bolts){ const [bdx, bdy] = DIRS[b.d]; const bx = b.x * CELL, by = b.y * CELL; cx.strokeStyle = `hsla(${b.hue},100%,70%,.95)`; cx.shadowColor = cx.strokeStyle; cx.shadowBlur = 16; cx.lineWidth = 5; cx.beginPath(); cx.moveTo(bx - bdx * CELL * .9, by - bdy * CELL * .9); cx.lineTo(bx, by); cx.stroke(); cx.shadowBlur = 0; }
  cx.lineCap = 'butt';
  for (const p of players.values()){ if (!p.alive) continue; const px = p.x * CELL, py = p.y * CELL, R = CELL * .62;
    cx.shadowColor = colorOf(p, 1); cx.shadowBlur = p.boostUntil > now() ? 34 : 16; cx.fillStyle = colorOf(p, 1); cx.beginPath(); cx.arc(px, py, R + 3, 0, Math.PI * 2); cx.fill(); cx.shadowBlur = 0;
    const img = p.drone ? null : imgOf(p.pk); cx.save(); cx.beginPath(); cx.arc(px, py, R, 0, Math.PI * 2); cx.clip();
    if (img && img.complete && img.naturalWidth) cx.drawImage(img, px - R, py - R, R * 2, R * 2); else { cx.fillStyle = '#fff'; cx.fillRect(px - R, py - R, R * 2, R * 2); cx.fillStyle = colorOf(p, 1); cx.fillRect(px - R * .4, py - R * .4, R * .8, R * .8); }
    cx.restore();
    const [dx, dy] = DIRS[p.d]; cx.fillStyle = '#fff'; cx.beginPath(); cx.arc(px + dx * (R + 5), py + dy * (R + 5), 3, 0, Math.PI * 2); cx.fill();
    cx.fillStyle = 'rgba(255,255,255,.92)'; cx.font = '700 12px sans-serif'; cx.textAlign = 'center'; cx.fillText(label(p), px, py - R - 8); }
  for (const q of parts){ cx.globalAlpha = Math.max(0, Math.min(1, q.life)); cx.fillStyle = q.color; cx.fillRect(q.x - q.sz/2, q.y - q.sz/2, q.sz, q.sz); } cx.globalAlpha = 1;
  for (const f of floats){ cx.globalAlpha = Math.max(0, Math.min(1, f.life)); cx.fillStyle = f.color; cx.font = `800 ${f.big ? 30 : 14}px sans-serif`; cx.textAlign = 'center'; cx.shadowColor = 'rgba(0,0,0,.7)'; cx.shadowBlur = 8; cx.fillText(f.text, f.x, f.y); cx.shadowBlur = 0; } cx.globalAlpha = 1;
  cx.strokeStyle = `hsl(${hue},100%,60%)`; cx.lineWidth = 6; cx.shadowColor = cx.strokeStyle; cx.shadowBlur = 24; cx.strokeRect(0, 0, W, H); cx.shadowBlur = 0;
  // minimap
  cx.setTransform(dpr, 0, 0, dpr, 0, 0); const mw = small ? 110 : 170, mh = Math.round(mw * ROWS / COLS), mx = vw - mw - 10, my = vh - mh - (small ? 28 : 34); cx.fillStyle = 'rgba(20,6,48,.78)'; cx.fillRect(mx, my, mw, mh); cx.strokeStyle = 'rgba(0,229,255,.5)'; cx.lineWidth = 1; cx.strokeRect(mx, my, mw, mh);
  // The minimap is not viewport-culled, so it was the worse of the two: it walked the whole grid
  // and rebuilt an hsla() string for Canvas to re-parse on every owned cell. One fillStyle per
  // rider, one fillRect per run.
  const sx = mw / COLS, sy = mh / ROWS;
  for (const [s, arr] of ownerRuns(0, 0, COLS, ROWS, 2)){ const p = bySlot.get(s); if (!p) continue; cx.fillStyle = colorOf(p, .9); for (let i = 0; i < arr.length; i += 3) cx.fillRect(mx + arr[i] * sx, my + arr[i + 1] * sy, arr[i + 2] * sx, sy * 2); }
  for (const p of players.values()){ if (!p.alive) continue; cx.fillStyle = '#fff'; cx.fillRect(mx + p.x * sx - 2, my + p.y * sy - 2, 4, 4); }
}
// Reads "…" until a tick has been round-tripped, so it never shows a made-up zero. Colour is the
// same scale the dot uses: green under 100 ms, orange under 250, red past it.
function renderPing(){
  const el = $('hPing'); if (!el) return;
  if (!started || !net.ready || !ping.ms){ el.textContent = '…'; el.style.color = 'var(--muted)'; return; }
  const ms = Math.round(ping.ms);
  el.textContent = ms + 'ms';
  el.style.color = ms < 100 ? 'var(--green)' : ms < 250 ? 'var(--orange)' : 'var(--red)';
}
let hudT = 0; function renderHud(){ const rows = standings().slice(0, 8); $('hud').innerHTML = rows.map(p => `<div class="row${p === local ? ' me' : ''}${p.drone ? ' drone' : ''}" data-pk="${p.drone ? '' : p.pk}"><img src="${p.drone ? avatar(p.pk) : picOf(p.pk)}" alt=""><span>${esc(label(p))}${p.drone ? ' · ' + esc(droneClass(p.i).label) : ''}</span><span class="k">${p.kills}✂ ${p.deaths}☠</span><b>${pct(p)}</b></div>`).join(''); $('hRiders').textContent = [...players.values()].filter(p => !p.drone && (p === local ? started : now() - p.last < 8000)).length; renderPing(); if (!$('board').classList.contains('hidden')) $('boardNow').innerHTML = standings().slice(0, 12).map(rowHTML).join(''); }
function feed(msg, cls = ''){ const f = $('feed'); const el = document.createElement('div'); el.className = cls; el.textContent = msg; f.appendChild(el); while (f.children.length > 5) f.firstChild.remove(); setTimeout(() => el.remove(), 4200); }

// ---------- input ----------
function boost(){ if (!local.alive || now() < local.cd) return; local.boostUntil = now() + BOOST_MS; local.cd = now() + BOOST_CD; }
function steer(nd){ if (!local.alive || (nd + 2) % 4 === local.d) return; local.nd = nd; }
window.addEventListener('keydown', e => { if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return; const k = e.key.toLowerCase();
  if (k === 'escape'){ for (const id of ['board', 'styleBox', 'controls']) $(id).classList.add('hidden'); return; }
  if (k === 'b'){ setBots(botsWanted ? 0 : botsLast); return; } if (k === '['){ setBots(botsWanted - 1); return; } if (k === ']'){ setBots(botsWanted + 1); return; }
  if (k === 'c'){ $('controls').classList.toggle('hidden'); return; } if (k === 'l'){ $('board').classList.toggle('hidden'); if (!$('board').classList.contains('hidden')){ $('boardNow').innerHTML = standings().slice(0, 12).map(rowHTML).join(''); career(); } return; } if (k === 'i'){ share($('btnShare')); return; }
  if (!started) return; const map = { arrowright: 0, d: 0, arrowdown: 1, s: 1, arrowleft: 2, a: 2, arrowup: 3, w: 3 }; if (k in map){ e.preventDefault(); steer(map[k]); } if (k === ' '){ e.preventDefault(); boost(); } if (k === 'f'){ e.preventDefault(); fire(local); } });
let touch = null; cv.addEventListener('pointerdown', e => { touch = { x: e.clientX, y: e.clientY, t: now() }; });
cv.addEventListener('pointermove', e => { if (!touch || touch.done) return; const dx = e.clientX - touch.x, dy = e.clientY - touch.y; if (Math.hypot(dx, dy) > 22){ steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3)); touch.done = true; } });
cv.addEventListener('pointerup', e => { if (!touch) return; if (!touch.done && now() - touch.t < 350) boost(); touch = null; });

// ---------- loop ----------
let lastT = now();
function loop(){ const t = now(); let rem = Math.min(1.5, (t - lastT) / 1000); lastT = t; while (rem > 0){ const dt = Math.min(.05, rem); step(dt); rem -= dt; } draw(); tick(); if (t - hudT > 300){ hudT = t; renderHud(); $('boostBar').style.width = (local.cd > t ? Math.max(0, 1 - (local.cd - t) / BOOST_CD) * 100 : 100) + '%'; if (mode.combat) $('btnFire').style.opacity = local.fireCd > t ? .35 : 1; }
  if (document.hidden) setTimeout(loop, 40); else requestAnimationFrame(loop); }

// ---------- lobby & ui wiring ----------
const err = m => { $('lobbyErr').textContent = m; };
$('btnLounge').onclick = async () => { try { await loungeKey(); err(''); } catch (e) { err(e.message); } };
$('btnNip07').onclick = async () => { try { await loginNip07(); err(''); } catch (e) { err(e.message); } };
$('btnBunkerShow').onclick = () => { $('bunkerRow').classList.toggle('hidden'); $('bunkerIn').value = localStorage.getItem('br_bunker') || ''; $('bunkerIn').focus(); };
$('btnBunker').onclick = async () => { $('btnBunker').disabled = true; err('Connecting to your signer… approve it there.'); try { await loginBunker($('bunkerIn').value); err(''); } catch (e) { err(e.message); } finally { $('btnBunker').disabled = false; } };
$('btnGuest').onclick = () => { guest(); err(''); };
$('btnSwitch').onclick = () => { me.id = null; $('who').classList.add('hidden'); $('rideRow').classList.add('hidden'); $('loginRow').classList.remove('hidden'); };
$('btnRide').onclick = async () => { setRoom($('roomIn').value); $('lobby').classList.add('hidden'); started = true; spawn(local); await publishClaim(); sendLand(true); startBeacon(); clearInterval(liveT); };
$('roomIn').addEventListener('change', () => setRoom($('roomIn').value)); $('roomIn').addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); setRoom($('roomIn').value); } });
$('privToggle').onclick = () => setRoom(room.name, { listed: !room.listed });
$('modeClassic').onclick = () => setMode(false); $('modeCombat').onclick = () => setMode(true);
$('btnFire').addEventListener('pointerdown', e => { e.preventDefault(); fire(local); });
$('btnNewRoom').onclick = () => { const words = ['neon', 'sat', 'blake', 'hodl', 'grid', 'block', 'rider', 'tail', 'moon', 'pink', 'cyan', 'plot']; setRoom(words[Math.floor(Math.random() * words.length)] + '-' + Math.random().toString(36).slice(2, 6)); };
for (const [less, tog, more] of [['botsLess', 'botsLbl', 'botsMore'], ['botsLess2', 'botsLbl2', 'botsMore2']]){ $(less).onclick = () => setBots(botsWanted - 1); $(more).onclick = () => setBots(botsWanted + 1); $(tog).onclick = () => setBots(botsWanted ? 0 : botsLast); }
$('btnShare').onclick = () => share($('btnShare')); $('btnShare2').onclick = () => share($('btnShare2')); $('btnCopyInvite').onclick = () => share($('btnCopyInvite'));
$('btnControls').onclick = () => $('controls').classList.remove('hidden'); $('controlsClose').onclick = () => $('controls').classList.add('hidden'); $('btnControls2').onclick = () => $('controls').classList.remove('hidden');
$('btnLeave').onclick = () => { $('lobby').classList.remove('hidden'); renderLive(); liveT = setInterval(renderLive, 15000); };
$('liveRefresh').onclick = renderLive;
$('btnBoard').onclick = () => { $('board').classList.remove('hidden'); $('boardNow').innerHTML = standings().slice(0, 12).map(rowHTML).join(''); career(); };
$('boardClose').onclick = () => $('board').classList.add('hidden');
document.querySelectorAll('.tabs button').forEach(b => { b.onclick = () => { document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b)); $('boardNow').classList.toggle('hidden', b.dataset.tab !== 'now'); $('boardBlocks').classList.toggle('hidden', b.dataset.tab !== 'blocks'); $('boardCareer').classList.toggle('hidden', b.dataset.tab !== 'career'); if (b.dataset.tab === 'blocks') blockWall(); }; });
$('btnStyle').onclick = () => { $('styleBox').classList.remove('hidden'); syncStyleUI(); drawStylePreview(); };
$('styleClose').onclick = () => $('styleBox').classList.add('hidden');
$('hud').addEventListener('click', e => { const pk = e.target.closest('[data-pk]')?.dataset.pk; if (!pk) return; const href = npubLink(pk); if (href) window.open(href, '_blank'); });
bindStyle('hueIn', 'patterns'); bindStyle('hueIn2', 'patterns2'); syncStyleUI();
if ('serviceWorker' in navigator){ navigator.serviceWorker.getRegistrations().then(rs => { for (const r of rs) if (!(r.active || r.installing || r.waiting)?.scriptURL.endsWith('/sw-game.js')) r.unregister(); }).catch(() => {}); navigator.serviceWorker.register('/sw-game.js', { scope: '/game' }).catch(() => {}); }
window.hodland = { local, players, owner, steer, boost, celebrateWinner, COLS, ROWS, style, room, setRoom, setBots, setMode, inviteUrl, bolts, fire: () => fire(local), get combat(){ return mode.combat; }, get bots(){ return botsWanted; } };
syncRoomUI(); syncBotsUI(); syncModeUI(); pollChain(); setInterval(pollChain, 20000); subscribe(); lastPodium(); ensureDrones(); renderLive(); liveT = setInterval(renderLive, 15000); loop();
if (params.get('room')) feed(`invited to grid “${room.name}”`);
