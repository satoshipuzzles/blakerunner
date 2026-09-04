// HODLAND: claim and hold land on the neon grid. Nostr relays are the netcode, a BLAKE2b block is a round.
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey, nip19, verifyEvent } from 'https://esm.sh/nostr-tools@2.10.4';
import { BunkerSigner, parseBunkerInput } from 'https://esm.sh/nostr-tools@2.10.4/nip46';

const GAME_RELAYS = ['wss://coolfeed.feeds.relay.tools', 'wss://relay.mostr.pub', 'wss://purplerelay.com', 'wss://nos.lol'];
const PROFILE_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band'];
const K_TICK = 21110, K_EVT = 21111, K_SCORE = 2112, K_CLAIM = 2113, K_PRESENCE = 30078, TAG = 'hodland';
// Rooms (Tank Arena pattern): a room is a string two people agreed on. Ticks/events carry the room tag so grids
// stay separate; presence is an addressable kind 30078 with NIP-40 expiry so the lobby can list live grids.
const PRESENCE_D = 'hodland/here', PRESENCE_TAG = 'hodland-live', BEACON_MS = 30000, PRESENCE_TTL_S = 120, SEATS = 8, MAX_BOTS = 7;
const cleanRoom = r => String(r || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'lobby';
const params = new URLSearchParams(location.search);
const room = { name: cleanRoom(params.get('room') || localStorage.getItem('br_room') || 'lobby'), listed: params.get('private') !== '1' && localStorage.getItem('br_room_private') !== '1' };
const roomTag = () => TAG + '-r-' + room.name;
const MEMPOOL = '/mp';
const COLS = 140, ROWS = 90, CELL = 22, W = COLS * CELL, H = ROWS * CELL;
const SPEED = 7.5, BOOST = 1.6, BOOST_MS = 800, BOOST_CD = 3500, TICK_HZ = 6, KEY_MS = 5000, RESPAWN_MS = 2500, MAX_TAIL = 500;
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
async function publishClaim(){ if (me.guest) return; try { pub(await signAsMe({ kind: K_CLAIM, tags: [['t', TAG], ['p', me.sessPub]], content: me.sessPub })); } catch (e) { feed('Could not sign the session claim: ' + e.message, 'kill'); } }

// ---------- style (land color + pattern) ----------
const style = Object.assign({ hue: parseInt(me.sessPub.slice(0, 4), 16) % 360, pat: 0 }, JSON.parse(localStorage.getItem('br_style') || '{}'));
const patCache = new Map();
function landFill(hue, pat, alpha = .45){
  const key = `${hue}|${pat}|${alpha}`; if (patCache.has(key)) return patCache.get(key);
  const c = document.createElement('canvas'); c.width = c.height = CELL; const x = c.getContext('2d');
  x.fillStyle = `hsla(${hue},95%,58%,${alpha})`; x.fillRect(0, 0, CELL, CELL);
  x.fillStyle = `hsla(${hue},100%,80%,${alpha * .9})`; x.strokeStyle = x.fillStyle; x.lineWidth = 2;
  const p = PATTERNS[pat] || 'solid';
  if (p === 'stripes'){ x.beginPath(); x.moveTo(0, CELL); x.lineTo(CELL, 0); x.moveTo(-CELL/2, CELL/2); x.lineTo(CELL/2, -CELL/2); x.moveTo(CELL/2, CELL * 1.5); x.lineTo(CELL * 1.5, CELL/2); x.stroke(); }
  else if (p === 'dots'){ x.beginPath(); x.arc(CELL/2, CELL/2, 3.5, 0, Math.PI * 2); x.fill(); }
  else if (p === 'checker'){ x.fillRect(0, 0, CELL/2, CELL/2); x.fillRect(CELL/2, CELL/2, CELL/2, CELL/2); }
  else if (p === 'grid'){ x.strokeRect(1, 1, CELL - 2, CELL - 2); }
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
function mkPlayer(pk, drone = false){ const p = { pk, slot: slot(pk), drone, x: 0, y: 0, d: 0, nd: 0, cell: -1, tail: [], tailSet: new Set(), alive: false, kills: 0, deaths: 0, land: 0, last: now(), cd: 0, boostUntil: 0, diedAt: 0, hue: parseInt(pk.slice(0, 4), 16) % 360, pat: 0 }; players.set(pk, p); return p; }
function clearLand(s){ for (let i = 0; i < owner.length; i++) if (owner[i] === s) owner[i] = 0; }
function spawn(p){
  clearLand(p.slot); p.tail = []; p.tailSet = new Set(); p.alive = true; p.boostUntil = 0;
  for (let tries = 0; tries < 300; tries++){ const cx = 5 + Math.floor(Math.random() * (COLS - 10)), cy = 5 + Math.floor(Math.random() * (ROWS - 10)); let free = true; for (let y = -4; y <= 4 && free; y++) for (let x = -4; x <= 4; x++) if (owner[idx(cx + x, cy + y)]){ free = false; break; }
    if (free || tries === 299){ for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) owner[idx(cx + x, cy + y)] = p.slot; p.x = cx + .5; p.y = cy + .5; p.cell = idx(cx, cy); p.d = p.nd = Math.floor(Math.random() * 4); p.inside = true; return; } }
}
const local = mkPlayer(me.sessPub); local.hue = style.hue; local.pat = style.pat;
let drones = [];
const DRONE_NAMES = ['Nakamoto', 'Finney', 'Szabo', 'Back', 'Dai', 'Todd', 'Wuille', 'Maxwell'];
function ensureDrones(){ const humans = [...players.values()].filter(p => !p.drone && (p === local ? started : now() - p.last < 6000)).length; const want = Math.max(0, botsWanted - Math.max(0, humans - 1)); while (drones.length < want){ const i = drones.length; const d = mkPlayer('drone' + i + '0000000000000000000000000000000000000000000000000000000000', true); d.name = DRONE_NAMES[i % DRONE_NAMES.length]; d.hue = (i * 67 + 200) % 360; d.pat = i % PATTERNS.length; d.plan = []; spawn(d); drones.push(d); } while (drones.length > want){ const d = drones.pop(); clearLand(d.slot); players.delete(d.pk); } }
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
  else if (gained > 120) feed(`${label(p)} claimed ${gained} cells`, 'claim');
}
function die(p, by, why){
  if (!p.alive) return; p.alive = false; p.deaths++; p.diedAt = now(); clearLand(p.slot); p.tail = []; p.tailSet = new Set();
  burst(p.x * CELL, p.y * CELL, colorOf(p, 1), 44);
  const killer = by && players.get(by); if (killer && killer !== p) killer.kills++;
  const who = label(p); const kn = killer ? label(killer) : null;
  feed(kn ? `${kn} wiped out ${who}` : `${who} ${why || 'wiped out'}`, p === local || by === me.sessPub ? 'kill me' : 'kill');
  if (p === local){ $('deadBy').textContent = kn ? 'cut off by ' + kn : why; $('deadMsg').classList.remove('hidden'); setTimeout(() => $('deadMsg').classList.add('hidden'), RESPAWN_MS); if (navigator.vibrate) navigator.vibrate(120); if (net.ready) pub(signAsSess({ kind: K_EVT, tags: [['t', roomTag()]], content: JSON.stringify({ t: 'die', by: by || null }) })); }
}
function enterCell(p, c){
  const cx = c % COLS, cy = (c - cx) / COLS;
  if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return die(p, null, 'hit the edge');
  if (p.tailSet.has(c)) return die(p, null, 'crossed their own tail');
  for (const q of players.values()){ if (q === p || !q.alive) continue; if (q.tailSet.has(c)){
      if (q === local) die(local, p.pk, '');
      else { die(q, p.pk, ''); if (p === local && !q.drone && net.ready) pub(signAsSess({ kind: K_EVT, tags: [['t', roomTag()], ['p', q.pk]], content: JSON.stringify({ t: 'kill', victim: q.pk }) })); } } }
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
    if (p !== local && !p.drone){ if (now() - p.last > 8000){ clearLand(p.slot); players.delete(p.pk); } continue; }
    if (p.drone) driveDrone(p);
    stepPlayer(p, dt);
  }
  for (const q of parts){ q.x += q.vx * dt; q.y += q.vy * dt; q.vy += 300 * dt; q.life -= dt * 1.4; } for (let i = parts.length - 1; i >= 0; i--) if (parts[i].life <= 0) parts.splice(i, 1);
  for (const r of rings){ r.r += (r.max - r.r) * dt * 4; r.life -= dt * 1.1; } for (let i = rings.length - 1; i >= 0; i--) if (rings[i].life <= 0) rings.splice(i, 1);
  ensureDrones();
}
function driveDrone(p){
  const cx = Math.floor(p.x), cy = Math.floor(p.y);
  const ahead = (d, n = 1) => { const [dx, dy] = DIRS[d]; return [cx + dx * n, cy + dy * n]; };
  const danger = d => { const [ax, ay] = ahead(d); if (ax < 1 || ay < 1 || ax >= COLS - 1 || ay >= ROWS - 1) return true; const c = idx(ax, ay); return p.tailSet.has(c); };
  if (p.inside && !p.plan.length){ const a = 3 + Math.floor(Math.random() * 8), b = 3 + Math.floor(Math.random() * 8), turnR = Math.random() < .5; let d0 = p.d; for (let i = 0; i < 4; i++){ const [ax, ay] = ahead(d0, a + 1); if (ax > 1 && ay > 1 && ax < COLS - 2 && ay < ROWS - 2) break; d0 = (d0 + 1) % 4; } const t = d => turnR ? (d + 1) % 4 : (d + 3) % 4; p.plan = [[d0, a], [t(d0), b], [t(t(d0)), a + 2], [t(t(t(d0))), 60]]; p.legLeft = p.plan[0][1]; p.nd = p.plan[0][0]; p.lastCell = -1; }
  if (p.cell !== p.lastCell){ p.lastCell = p.cell; if (p.plan.length){ p.legLeft--; if (p.legLeft <= 0){ p.plan.shift(); if (p.plan.length){ p.nd = p.plan[0][0]; p.legLeft = p.plan[0][1]; } } } }
  if (p.inside && p.plan.length && p.plan.length < 3) p.plan = [];
  if (danger(p.nd) || danger(p.d)){ const opts = [(p.d + 1) % 4, (p.d + 3) % 4].filter(d => !danger(d)); if (opts.length){ p.nd = opts[Math.floor(Math.random() * opts.length)]; p.plan = p.plan.length ? [[p.nd, 3], [(p.nd + (Math.random() < .5 ? 1 : 3)) % 4, 60]] : []; p.legLeft = 3; } }
  if (!p.inside && p.tail.length > 70){ let best = null, bd = 1e9; for (let i = 0; i < owner.length; i += 3) if (owner[i] === p.slot){ const ox = i % COLS, oy = (i - ox) / COLS; const d = Math.abs(ox - cx) + Math.abs(oy - cy); if (d < bd){ bd = d; best = [ox, oy]; } } if (best){ const pref = Math.abs(best[0] - cx) > Math.abs(best[1] - cy) ? (best[0] > cx ? 0 : 2) : (best[1] > cy ? 1 : 3); if (!danger(pref) && (pref + 2) % 4 !== p.d) p.nd = pref; } }
}

// ---------- land sync ----------
function rleMine(s){ const runs = []; let cur = 0, n = 0; for (let i = 0; i < owner.length; i++){ const v = owner[i] === s ? 1 : 0; if (v === cur) n++; else { runs.push(n); cur = v; n = 1; } } runs.push(n); return runs.join(','); }
function applyRle(s, str){ clearLand(s); let i = 0, v = 0; for (const part of str.split(',')){ const n = Number(part) | 0; if (v) for (let k = 0; k < n && i + k < owner.length; k++) owner[i + k] = s; i += n; v ^= 1; } }
let lastKey = 0;
function sendLand(force){ if (!started || !net.ready) return; if (!force && now() - lastKey < KEY_MS) return; lastKey = now(); pub(signAsSess({ kind: K_EVT, tags: [['t', roomTag()]], content: JSON.stringify({ t: 'land', rle: rleMine(local.slot) }) })); }

// ---------- netcode ----------
const net = { ready: false, lastTick: 0, sub: null };
function subscribe(){
  if (net.sub) { try { net.sub.close(); } catch {} } net.ready = false; $('hRelay').classList.remove('on');
  net.sub = pool.subscribeMany(GAME_RELAYS, [{ kinds: [K_TICK, K_EVT], '#t': [roomTag()], since: Math.floor(Date.now()/1000) - 8 }, { kinds: [K_CLAIM], '#t': [TAG], since: Math.floor(Date.now()/1000) - 86400 }], {
    onevent: e => { if (!verifyEvent(e)) return;
      if (e.kind === K_CLAIM){ const sp = e.tags.find(t => t[0] === 'p')?.[1]; if (sp && /^[0-9a-f]{64}$/.test(sp) && sp !== me.sessPub){ claims.set(sp, e.pubkey); wantProfile(e.pubkey); } return; }
      if (e.pubkey === me.sessPub) return; let c; try { c = JSON.parse(e.content); } catch { return; }
      const fresh = !players.has(e.pubkey); const p = players.get(e.pubkey) || mkPlayer(e.pubkey); if (!claims.has(e.pubkey)) wantProfile(e.pubkey);
      if (fresh){ feed(`${nameOf(e.pubkey)} joined the grid`); sendLand(true); }
      if (e.kind === K_TICK){ if (typeof c.x !== 'number') return; p.x = c.x; p.y = c.y; p.d = c.d & 3; p.alive = !!c.a; p.kills = c.k | 0; p.deaths = c.dd | 0; p.boostUntil = c.b ? now() + 300 : 0; p.last = now();
        if (Array.isArray(c.st)){ p.hue = (c.st[0] | 0) % 360; p.pat = Math.min(PATTERNS.length - 1, c.st[1] | 0); }
        if (Array.isArray(c.tl)){ p.tail = c.tl.filter(n => Number.isInteger(n) && n >= 0 && n < owner.length).slice(-MAX_TAIL); p.tailSet = new Set(p.tail); }
        if (p.alive && local.alive){ const hc = idx(Math.floor(p.x), Math.floor(p.y)); if (local.tailSet.has(hc)) die(local, p.pk, ''); } }
      else if (e.kind === K_EVT){ p.last = now();
        if (c.t === 'land' && typeof c.rle === 'string' && c.rle.length < 30000) applyRle(p.slot, c.rle);
        else if (c.t === 'die'){ if (p.alive){ p.alive = false; burst(p.x * CELL, p.y * CELL, colorOf(p, 1), 30); const kn = c.by && players.get(c.by) ? label(players.get(c.by)) : c.by === me.sessPub ? nameOf(me.sessPub) : null; feed(kn ? `${kn} wiped out ${nameOf(p.pk)}` : `${nameOf(p.pk)} wiped out`, c.by === me.sessPub ? 'kill me' : 'kill'); } p.diedAt = now(); clearLand(p.slot); p.tail = []; p.tailSet = new Set(); if (c.by === me.sessPub) local.kills++; }
        else if (c.t === 'kill' && c.victim === me.sessPub) die(local, e.pubkey, ''); } },
    oneose: () => { net.ready = true; $('hRelay').classList.add('on'); } });
}
function tick(){ if (!started || !net.ready) return; if (now() - net.lastTick < 1000 / TICK_HZ) return; net.lastTick = now();
  pub(signAsSess({ kind: K_TICK, tags: [['t', roomTag()], ['h', String(chain.height)]], content: JSON.stringify({ x: +local.x.toFixed(2), y: +local.y.toFixed(2), d: local.d, a: local.alive ? 1 : 0, k: local.kills, dd: local.deaths, b: local.boostUntil > now() ? 1 : 0, st: [style.hue, style.pat], tl: local.tail.slice(-MAX_TAIL) }) }));
  sendLand(false); }

// ---------- rooms: presence beacons and the live-grid list ----------
let beaconT = null;
async function beacon(){
  if (!started || !me.id) return;
  const at = Math.floor(Date.now()/1000); landCounts();
  const payload = { room: room.name, name: (me.guest ? 'guest-' + me.sessPub.slice(0, 4) : nameOf(me.sessPub)).slice(0, 16), hue: style.hue, role: 'seat', at, block: chain.height || undefined, bots: botsWanted, land: +(local.land / (COLS * ROWS) * 100).toFixed(1) };
  const tags = [['d', PRESENCE_D], ...(room.listed ? [['t', PRESENCE_TAG]] : []), ['t', roomTag()], ['expiration', String(at + PRESENCE_TTL_S)]];
  try { const ev = me.guest ? signAsSess({ kind: K_PRESENCE, tags, content: JSON.stringify(payload) }) : await signAsMe({ kind: K_PRESENCE, tags, content: JSON.stringify(payload) }); pub(ev); } catch {}
}
function startBeacon(){ clearInterval(beaconT); beacon(); beaconT = setInterval(beacon, BEACON_MS); }
function groupRooms(evs){
  const rooms = new Map(); const cutoff = Math.floor(Date.now()/1000) - PRESENCE_TTL_S * 3;
  for (const e of evs){ let p; try { p = JSON.parse(e.content); } catch { continue; } if (!p || typeof p.room !== 'string' || e.created_at < cutoff) continue; const r = cleanRoom(p.room); let occ = rooms.get(r); if (!occ) rooms.set(r, occ = new Map()); const prev = occ.get(e.pubkey); if (!prev || prev.at < e.created_at) occ.set(e.pubkey, { pk: e.pubkey, name: String(p.name || '').slice(0, 16), hue: p.hue | 0, at: e.created_at, block: p.block, bots: p.bots, land: p.land }); }
  const out = [...rooms].map(([name, occ]) => { const riders = [...occ.values()].sort((a, b) => b.at - a.at); const bots = riders.find(r => typeof r.bots === 'number')?.bots; return { name, riders, open: Math.max(0, SEATS - riders.length), block: riders[0]?.block, bots, freshest: riders[0]?.at || 0 }; });
  if (!out.some(r => r.name === 'lobby')) out.push({ name: 'lobby', riders: [], open: SEATS, standing: true, freshest: 0 });
  return out.sort((a, b) => b.riders.length - a.riders.length || b.freshest - a.freshest);
}
async function fetchLiveRooms(){ const evs = await pool.querySync(GAME_RELAYS, { kinds: [K_PRESENCE], '#t': [PRESENCE_TAG], limit: 300 }, { maxWait: 3500 }).catch(() => []); return groupRooms(evs.filter(e => verifyEvent(e))); }
let liveT = null;
async function renderLive(){
  const list = await fetchLiveRooms(); const box = $('liveRooms'); if (!box) return;
  for (const r of list) for (const o of r.riders) wantProfile(o.pk);
  box.innerHTML = list.slice(0, 8).map(r => { const dots = r.riders.slice(0, SEATS).map(o => `<i title="${esc(o.name || nameOf(o.pk))}" style="background:hsl(${o.hue},95%,60%)"></i>`).join(''); const bits = []; if (r.block) bits.push('block ' + Number(r.block).toLocaleString()); if (typeof r.bots === 'number') bits.push(r.bots + ' drone' + (r.bots === 1 ? '' : 's')); if (r.standing) bits.push('the standing grid · always open'); const here = r.name === room.name;
    return `<div class="lr${here ? ' here' : ''}"><div class="lrt"><b>${esc(r.name)}</b><span class="seats ${r.open ? 'open' : 'full'}">${r.riders.length}/${SEATS}</span></div><div class="dots">${dots || '<span class="muted small">nobody riding</span>'}</div><div class="small muted">${bits.join(' · ')}</div><button class="btn ghost tiny" data-join="${esc(r.name)}">${here ? 'this grid' : r.open ? 'Join' : 'Squeeze in'}</button></div>`; }).join('');
  box.querySelectorAll('[data-join]').forEach(b => { b.onclick = () => { setRoom(b.dataset.join); }; });
}
function setRoom(name, opts = {}){
  const n = cleanRoom(name); const changed = n !== room.name; room.name = n; if (opts.listed !== undefined) room.listed = !!opts.listed;
  localStorage.setItem('br_room', n); localStorage.setItem('br_room_private', room.listed ? '0' : '1');
  syncRoomUI(); if (changed){ for (const p of [...players.values()]) if (p !== local && !p.drone){ clearLand(p.slot); players.delete(p.pk); } subscribe(); if (started){ feed(`moved to grid “${n}”`); sendLand(true); startBeacon(); } }
  history.replaceState(null, '', inviteUrl().replace(location.origin, ''));
}
function inviteUrl(){ const u = new URL(location.origin + '/game'); if (room.name !== 'lobby') u.searchParams.set('room', room.name); if (botsWanted !== 5) u.searchParams.set('bots', String(botsWanted)); if (!room.listed) u.searchParams.set('private', '1'); return u.toString(); }
function syncRoomUI(){ $('roomIn').value = room.name; $('hRoom').textContent = room.name; $('privToggle').classList.toggle('on', !room.listed); $('privToggle').textContent = room.listed ? 'Listed' : 'Private'; $('inviteUrl').textContent = inviteUrl().replace(/^https?:\/\//, ''); }
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
function standings(){ landCounts(); return [...players.values()].filter(p => p.drone || p === local || now() - p.last < 8000).sort((a, b) => b.land - a.land || b.kills - a.kills); }
const rowHTML = (p, i) => { const href = p.drone ? null : npubLink(p.pk); return `<${href ? `a href="${href}" target="_blank" rel="noopener"` : 'div'} class="p"><span class="mono muted">${i + 1}</span><img src="${p.drone ? avatar(p.pk) : picOf(p.pk)}" alt=""><span>${esc(label(p))}${p.drone ? ' <span class="sub">drone</span>' : ''}</span><b>${pct(p)} · ${p.kills}✂</b></${href ? 'a' : 'div'}>`; };
async function roundOver(prevHeight){
  const rows = standings(); $('podBlock').textContent = prevHeight.toLocaleString(); $('podList').innerHTML = rows.slice(0, 8).map(rowHTML).join('') || '<div class="sys">Nobody rode this block.</div>'; $('podium').classList.remove('hidden');
  if (rows[0]) feed(`block ${prevHeight.toLocaleString()} goes to ${label(rows[0])} with ${pct(rows[0])}`, 'claim');
  if (started && me.id){ try { const ev = await signAsMe({ kind: K_SCORE, tags: [['t', TAG], ['t', `${TAG}-${prevHeight}`], ['d', String(prevHeight)], ['client', 'blakerunner']], content: JSON.stringify({ height: prevHeight, land: local.land, cells: COLS * ROWS, kills: local.kills, deaths: local.deaths, chain: 'blake2b' }) }); await Promise.any(pool.publish(GAME_RELAYS, ev)); $('podNote').textContent = 'Your result is signed by your npub and on the relays.'; } catch (e) { $('podNote').textContent = 'Could not publish your score: ' + e.message; } }
  setTimeout(() => { $('podium').classList.add('hidden'); owner.fill(0); for (const p of players.values()){ p.kills = 0; p.deaths = 0; if (p === local ? started : true) spawn(p); } }, 7000);
}
async function fetchScores(limit = 500){ const evs = await pool.querySync(GAME_RELAYS, { kinds: [K_SCORE], '#t': [TAG], limit }, { maxWait: 4000 }).catch(() => []); const rows = []; const seen = new Set(); for (const e of evs){ const h = Number(e.tags.find(t => t[0] === 'd')?.[1]); if (!h || seen.has(e.pubkey + h)) continue; seen.add(e.pubkey + h); let c = {}; try { c = JSON.parse(e.content); } catch {} rows.push({ pk: e.pubkey, h, land: c.land | 0, cells: c.cells || COLS * ROWS, kills: c.kills | 0 }); } return rows; }
async function lastPodium(){ const rows = await fetchScores(80); if (!rows.length) return; const top = Math.max(...rows.map(r => r.h)); const rr = rows.filter(r => r.h === top).sort((a, b) => b.land - a.land); for (const r of rr) wantProfile(r.pk); $('lastPodium').innerHTML = `<div class="muted small" style="text-align:center">Last signed round · block ${top.toLocaleString()}</div>` + rr.slice(0, 5).map((r, i) => `<a class="p" href="/p/${nip19.npubEncode(r.pk)}" target="_blank" rel="noopener"><span class="mono muted">${i + 1}</span><img src="${picOf(r.pk)}" alt=""><span>${esc(nameOf(r.pk))}</span><b>${(r.land / r.cells * 100).toFixed(1)}%</b></a>`).join(''); }
async function career(){
  const rows = await fetchScores(500); if (!rows.length){ $('boardCareer').innerHTML = '<div class="sys">No signed rounds on the relays yet. Be the first.</div>'; return; }
  const byH = new Map(); for (const r of rows){ if (!byH.has(r.h) || byH.get(r.h).land < r.land) byH.set(r.h, r); }
  const agg = new Map(); for (const r of rows){ const a = agg.get(r.pk) || { pk: r.pk, rounds: 0, wins: 0, kills: 0, best: 0 }; a.rounds++; a.kills += r.kills; a.best = Math.max(a.best, r.land / r.cells * 100); agg.set(r.pk, a); } for (const w of byH.values()) agg.get(w.pk).wins++;
  const list = [...agg.values()].sort((a, b) => b.wins - a.wins || b.best - a.best).slice(0, 25); for (const a of list) wantProfile(a.pk);
  $('boardCareer').innerHTML = list.map((a, i) => `<a class="p" href="/p/${nip19.npubEncode(a.pk)}" target="_blank" rel="noopener"><span class="mono muted">${i + 1}</span><img src="${picOf(a.pk)}" alt=""><span>${esc(nameOf(a.pk))}<br><span class="sub">${a.rounds} round${a.rounds === 1 ? '' : 's'} · ${a.kills}✂</span></span><b>${a.wins} block${a.wins === 1 ? '' : 's'} · best ${a.best.toFixed(1)}%</b></a>`).join('');
}

// ---------- render ----------
const cv = $('cv'), cx = cv.getContext('2d'); let vw = 0, vh = 0, dpr = 1;
function resize(){ dpr = Math.min(2, window.devicePixelRatio || 1); vw = cv.clientWidth; vh = cv.clientHeight; cv.width = vw * dpr; cv.height = vh * dpr; }
window.addEventListener('resize', resize); resize();
const cam = { x: W/2, y: H/2 }; const parts = [], rings = [];
const colorOf = (p, a) => `hsla(${p.hue},95%,60%,${a})`;
function burst(x, y, color, n){ for (let i = 0; i < n; i++){ const a = Math.random() * Math.PI * 2, s = 80 + Math.random() * 260; parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 80, life: .8 + Math.random() * .5, color, sz: 3 + Math.random() * 5 }); } }
function draw(){
  const small = vw < 760; const zoom = Math.max(small ? .7 : .55, Math.min(vw / (small ? 900 : 1500), vh / (small ? 700 : 1000), 1)); const tx = started ? local.x * CELL : W/2, ty = started ? local.y * CELL : H/2;
  cam.x += (tx - cam.x) * .12; cam.y += (ty - cam.y) * .12; cam.x = Math.max(vw/2/zoom, Math.min(W - vw/2/zoom, cam.x)); cam.y = Math.max(vh/2/zoom, Math.min(H - vh/2/zoom, cam.y));
  cx.setTransform(dpr, 0, 0, dpr, 0, 0); cx.clearRect(0, 0, vw, vh);
  const g = cx.createLinearGradient(0, 0, 0, vh); g.addColorStop(0, '#1a0640'); g.addColorStop(1, '#0b0220'); cx.fillStyle = g; cx.fillRect(0, 0, vw, vh);
  cx.translate(vw/2 - cam.x * zoom, vh/2 - cam.y * zoom); cx.scale(zoom, zoom);
  const x0 = Math.max(0, Math.floor((cam.x - vw/2/zoom) / CELL) - 1), x1 = Math.min(COLS, Math.ceil((cam.x + vw/2/zoom) / CELL) + 1), y0 = Math.max(0, Math.floor((cam.y - vh/2/zoom) / CELL) - 1), y1 = Math.min(ROWS, Math.ceil((cam.y + vh/2/zoom) / CELL) + 1);
  const bySlot = new Map(); for (const p of players.values()) bySlot.set(p.slot, p);
  // land: batch cells per player so each fillStyle (pattern) is set once
  const runs = new Map(); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++){ const s = owner[idx(x, y)]; if (!s) continue; let arr = runs.get(s); if (!arr){ arr = []; runs.set(s, arr); } arr.push(x, y); }
  for (const [s, arr] of runs){ const p = bySlot.get(s); if (!p) continue; cx.fillStyle = landFill(p.hue, p.pat, p.alive ? .5 : .2); cx.beginPath(); for (let i = 0; i < arr.length; i += 2) cx.rect(arr[i] * CELL + .5, arr[i + 1] * CELL + .5, CELL - 1, CELL - 1); cx.fill(); }
  const hue = chain.seed % 360; cx.lineWidth = 1; cx.strokeStyle = `hsla(${(hue + 180) % 360},100%,70%,.10)`; cx.beginPath(); for (let x = x0; x <= x1; x++){ cx.moveTo(x * CELL, y0 * CELL); cx.lineTo(x * CELL, y1 * CELL); } for (let y = y0; y <= y1; y++){ cx.moveTo(x0 * CELL, y * CELL); cx.lineTo(x1 * CELL, y * CELL); } cx.stroke();
  for (const p of players.values()){ if (!p.alive || !p.tail.length) continue; cx.fillStyle = colorOf(p, .9); cx.shadowColor = colorOf(p, 1); cx.shadowBlur = 10; cx.beginPath(); for (const c of p.tail){ const tx2 = c % COLS, ty2 = (c - tx2) / COLS; if (tx2 < x0 || tx2 > x1 || ty2 < y0 || ty2 > y1) continue; cx.rect(tx2 * CELL + 3, ty2 * CELL + 3, CELL - 6, CELL - 6); } cx.fill(); cx.shadowBlur = 0; }
  for (const r of rings){ cx.strokeStyle = r.color; cx.globalAlpha = Math.max(0, r.life) * .9; cx.lineWidth = 4; cx.beginPath(); cx.arc(r.x, r.y, r.r, 0, Math.PI * 2); cx.stroke(); cx.globalAlpha = 1; }
  for (const p of players.values()){ if (!p.alive) continue; const px = p.x * CELL, py = p.y * CELL, R = CELL * .62;
    cx.shadowColor = colorOf(p, 1); cx.shadowBlur = p.boostUntil > now() ? 34 : 16; cx.fillStyle = colorOf(p, 1); cx.beginPath(); cx.arc(px, py, R + 3, 0, Math.PI * 2); cx.fill(); cx.shadowBlur = 0;
    const img = p.drone ? null : imgOf(p.pk); cx.save(); cx.beginPath(); cx.arc(px, py, R, 0, Math.PI * 2); cx.clip();
    if (img && img.complete && img.naturalWidth) cx.drawImage(img, px - R, py - R, R * 2, R * 2); else { cx.fillStyle = '#fff'; cx.fillRect(px - R, py - R, R * 2, R * 2); cx.fillStyle = colorOf(p, 1); cx.fillRect(px - R * .4, py - R * .4, R * .8, R * .8); }
    cx.restore();
    const [dx, dy] = DIRS[p.d]; cx.fillStyle = '#fff'; cx.beginPath(); cx.arc(px + dx * (R + 5), py + dy * (R + 5), 3, 0, Math.PI * 2); cx.fill();
    cx.fillStyle = 'rgba(255,255,255,.92)'; cx.font = '700 12px sans-serif'; cx.textAlign = 'center'; cx.fillText(label(p), px, py - R - 8); }
  for (const q of parts){ cx.globalAlpha = Math.max(0, Math.min(1, q.life)); cx.fillStyle = q.color; cx.fillRect(q.x - q.sz/2, q.y - q.sz/2, q.sz, q.sz); } cx.globalAlpha = 1;
  cx.strokeStyle = `hsl(${hue},100%,60%)`; cx.lineWidth = 6; cx.shadowColor = cx.strokeStyle; cx.shadowBlur = 24; cx.strokeRect(0, 0, W, H); cx.shadowBlur = 0;
  // minimap
  cx.setTransform(dpr, 0, 0, dpr, 0, 0); const mw = small ? 110 : 170, mh = Math.round(mw * ROWS / COLS), mx = vw - mw - 10, my = vh - mh - (small ? 28 : 34); cx.fillStyle = 'rgba(20,6,48,.78)'; cx.fillRect(mx, my, mw, mh); cx.strokeStyle = 'rgba(0,229,255,.5)'; cx.lineWidth = 1; cx.strokeRect(mx, my, mw, mh);
  const sx = mw / COLS, sy = mh / ROWS; for (let y = 0; y < ROWS; y += 2) for (let x = 0; x < COLS; x += 2){ const s = owner[idx(x, y)]; if (!s) continue; const p = bySlot.get(s); if (!p) continue; cx.fillStyle = colorOf(p, .9); cx.fillRect(mx + x * sx, my + y * sy, sx * 2, sy * 2); }
  for (const p of players.values()){ if (!p.alive) continue; cx.fillStyle = '#fff'; cx.fillRect(mx + p.x * sx - 2, my + p.y * sy - 2, 4, 4); }
}
let hudT = 0; function renderHud(){ const rows = standings().slice(0, 8); $('hud').innerHTML = rows.map(p => `<div class="row${p === local ? ' me' : ''}${p.drone ? ' drone' : ''}" data-pk="${p.drone ? '' : p.pk}"><img src="${p.drone ? avatar(p.pk) : picOf(p.pk)}" alt=""><span>${esc(label(p))}</span><span class="k">${p.kills}✂</span><b>${pct(p)}</b></div>`).join(''); $('hRiders').textContent = [...players.values()].filter(p => !p.drone && (p === local ? started : now() - p.last < 8000)).length; if (!$('board').classList.contains('hidden')) $('boardNow').innerHTML = standings().slice(0, 12).map(rowHTML).join(''); }
function feed(msg, cls = ''){ const f = $('feed'); const el = document.createElement('div'); el.className = cls; el.textContent = msg; f.appendChild(el); while (f.children.length > 5) f.firstChild.remove(); setTimeout(() => el.remove(), 4200); }

// ---------- input ----------
function boost(){ if (!local.alive || now() < local.cd) return; local.boostUntil = now() + BOOST_MS; local.cd = now() + BOOST_CD; }
function steer(nd){ if (!local.alive || (nd + 2) % 4 === local.d) return; local.nd = nd; }
window.addEventListener('keydown', e => { if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return; const k = e.key.toLowerCase();
  if (k === 'escape'){ for (const id of ['board', 'styleBox', 'controls']) $(id).classList.add('hidden'); return; }
  if (k === 'b'){ setBots(botsWanted ? 0 : botsLast); return; } if (k === '['){ setBots(botsWanted - 1); return; } if (k === ']'){ setBots(botsWanted + 1); return; }
  if (k === 'c'){ $('controls').classList.toggle('hidden'); return; } if (k === 'l'){ $('board').classList.toggle('hidden'); if (!$('board').classList.contains('hidden')){ $('boardNow').innerHTML = standings().slice(0, 12).map(rowHTML).join(''); career(); } return; } if (k === 'i'){ share($('btnShare')); return; }
  if (!started) return; const map = { arrowright: 0, d: 0, arrowdown: 1, s: 1, arrowleft: 2, a: 2, arrowup: 3, w: 3 }; if (k in map){ e.preventDefault(); steer(map[k]); } if (k === ' '){ e.preventDefault(); boost(); } });
let touch = null; cv.addEventListener('pointerdown', e => { touch = { x: e.clientX, y: e.clientY, t: now() }; });
cv.addEventListener('pointermove', e => { if (!touch || touch.done) return; const dx = e.clientX - touch.x, dy = e.clientY - touch.y; if (Math.hypot(dx, dy) > 22){ steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3)); touch.done = true; } });
cv.addEventListener('pointerup', e => { if (!touch) return; if (!touch.done && now() - touch.t < 350) boost(); touch = null; });

// ---------- loop ----------
let lastT = now();
function loop(){ const t = now(); let rem = Math.min(1.5, (t - lastT) / 1000); lastT = t; while (rem > 0){ const dt = Math.min(.05, rem); step(dt); rem -= dt; } draw(); tick(); if (t - hudT > 300){ hudT = t; renderHud(); $('boostBar').style.width = (local.cd > t ? Math.max(0, 1 - (local.cd - t) / BOOST_CD) * 100 : 100) + '%'; }
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
$('btnNewRoom').onclick = () => { const words = ['neon', 'sat', 'blake', 'hodl', 'grid', 'block', 'rider', 'tail', 'moon', 'pink', 'cyan', 'plot']; setRoom(words[Math.floor(Math.random() * words.length)] + '-' + Math.random().toString(36).slice(2, 6)); };
for (const [less, tog, more] of [['botsLess', 'botsLbl', 'botsMore'], ['botsLess2', 'botsLbl2', 'botsMore2']]){ $(less).onclick = () => setBots(botsWanted - 1); $(more).onclick = () => setBots(botsWanted + 1); $(tog).onclick = () => setBots(botsWanted ? 0 : botsLast); }
$('btnShare').onclick = () => share($('btnShare')); $('btnShare2').onclick = () => share($('btnShare2')); $('btnCopyInvite').onclick = () => share($('btnCopyInvite'));
$('btnControls').onclick = () => $('controls').classList.remove('hidden'); $('controlsClose').onclick = () => $('controls').classList.add('hidden'); $('btnControls2').onclick = () => $('controls').classList.remove('hidden');
$('btnLeave').onclick = () => { $('lobby').classList.remove('hidden'); renderLive(); liveT = setInterval(renderLive, 15000); };
$('liveRefresh').onclick = renderLive;
$('btnBoard').onclick = () => { $('board').classList.remove('hidden'); $('boardNow').innerHTML = standings().slice(0, 12).map(rowHTML).join(''); career(); };
$('boardClose').onclick = () => $('board').classList.add('hidden');
document.querySelectorAll('.tabs button').forEach(b => { b.onclick = () => { document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b)); $('boardNow').classList.toggle('hidden', b.dataset.tab !== 'now'); $('boardCareer').classList.toggle('hidden', b.dataset.tab !== 'career'); }; });
$('btnStyle').onclick = () => { $('styleBox').classList.remove('hidden'); syncStyleUI(); drawStylePreview(); };
$('styleClose').onclick = () => $('styleBox').classList.add('hidden');
$('hud').addEventListener('click', e => { const pk = e.target.closest('[data-pk]')?.dataset.pk; if (!pk) return; const href = npubLink(pk); if (href) window.open(href, '_blank'); });
bindStyle('hueIn', 'patterns'); bindStyle('hueIn2', 'patterns2'); syncStyleUI();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw-game.js', { scope: '/game' }).catch(() => {});
window.hodland = { local, players, owner, steer, boost, COLS, ROWS, style, room, setRoom, setBots, inviteUrl, get bots(){ return botsWanted; } };
syncRoomUI(); syncBotsUI(); pollChain(); setInterval(pollChain, 20000); subscribe(); lastPodium(); ensureDrones(); renderLive(); liveT = setInterval(renderLive, 15000); loop();
if (params.get('room')) feed(`invited to grid “${room.name}”`);
