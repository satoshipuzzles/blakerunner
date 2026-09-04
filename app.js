// BlakeRunner core: state, login, chat, wallet (QR, send, zap), routing. Explorer and game are separate modules.
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey, nip19, verifyEvent } from 'https://esm.sh/nostr-tools@2.10.4';
import * as btc from 'https://esm.sh/@scure/btc-signer@1.6.0';
import { secp256k1 } from 'https://esm.sh/@noble/curves@1.8.1/secp256k1';
import { sha256 } from 'https://esm.sh/@noble/hashes@1.7.1/sha256';
import { ripemd160 } from 'https://esm.sh/@noble/hashes@1.7.1/ripemd160';
import { bytesToHex, hexToBytes } from 'https://esm.sh/@noble/hashes@1.7.1/utils';
import { bech32, bech32m } from 'https://esm.sh/@scure/base@1.2.4';
import QRCode from 'https://esm.sh/qrcode@1.5.4/lib/browser';
import { BunkerSigner, parseBunkerInput } from 'https://esm.sh/nostr-tools@2.10.4/nip46';
import { initExplorer, loadBlocks, renderBlock, renderTx, renderAddress } from './explorer.js';

const RELAYS = ['wss://relay.damus.io','wss://nos.lol','wss://relay.nostr.band','wss://nostr.wine','wss://eden.nostr.land'];
const KIND_CHAT = 2110, KIND_ZAP = 2111, TAG = 'blake', MAX_BYTES = 80;
const MEMPOOL = '/mp'; // same-origin proxy to https://mempool.guide/api (vercel.json rewrite)
const DUST = 546n;
const enc = new TextEncoder();
const $ = id => document.getElementById(id);
const bytesOf = s => enc.encode(s).length;
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function j(u){ const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error((await r.text().catch(() => '')) || (u + ' ' + r.status)); return r.json(); }
const qr = text => QRCode.toDataURL(text, { margin: 1, width: 192, color: { dark: '#12042a', light: '#ffffff' } });

// ---------- addresses (nostronchain-compatible) ----------
const hash160 = b => ripemd160(sha256(b));
function addresses(pubHex){
  const x = hexToBytes(pubHex); const pub33 = new Uint8Array(33); pub33[0] = 2; pub33.set(x, 1);
  return { segwit: bech32.encode('bc', [0, ...bech32.toWords(hash160(pub33))], 1000), taproot: bech32m.encode('bc', [1, ...bech32m.toWords(x)], 1000), pub33 };
}
function evenKey(sk){
  const P = secp256k1.ProjectivePoint.fromPrivateKey(sk); if (P.toAffine().y % 2n === 0n) return sk;
  const n = secp256k1.CURVE.n, d = BigInt('0x' + bytesToHex(sk)); return hexToBytes((n - d).toString(16).padStart(64, '0'));
}

// ---------- state ----------
const S = { pubkey: null, npub: null, signer: null, sk: null, bunker: null, addrs: null, profiles: new Map(), msgs: new Map(), seen: new Map(), replyTo: null, zapTarget: null, view: 'home' };
const pool = new SimplePool();

// ---------- stats ----------
const fmtHash = h => { const u = ['H/s','kH/s','MH/s','GH/s','TH/s','PH/s','EH/s']; let i = 0; while (h >= 1000 && i < u.length-1){ h /= 1000; i++; } return h.toFixed(2) + ' ' + u[i]; };
async function loadStats(){
  try {
    const [height, da, hr, mp, fees] = await Promise.all([fetch(MEMPOOL + '/blocks/tip/height', { cache: 'no-store' }).then(r => r.text()), j(MEMPOOL + '/v1/difficulty-adjustment'), j(MEMPOOL + '/v1/mining/hashrate/3d'), j(MEMPOOL + '/mempool'), j(MEMPOOL + '/v1/fees/recommended')]);
    $('sHeight').textContent = Number(height).toLocaleString();
    $('sHash').textContent = fmtHash(hr.currentHashrate || (hr.hashrates?.at(-1)?.avgHashrate ?? 0));
    $('sEpoch').textContent = da.progressPercent.toFixed(1) + '%'; $('sEpochBar').style.width = Math.min(100, da.progressPercent) + '%';
    const days = da.remainingTime / 864e5; $('sRetarget').textContent = (da.difficultyChange >= 0 ? '+' : '') + da.difficultyChange.toFixed(0) + '% in ' + (days < 1 ? (da.remainingTime/36e5).toFixed(1) + 'h' : days.toFixed(1) + 'd');
    $('sMempool').textContent = mp.count.toLocaleString() + ' tx · ' + (mp.vsize/1e6).toFixed(1) + 'MvB';
    $('sFee').textContent = fees.fastestFee + ' sat/vB';
  } catch (e) { console.warn('stats', e); }
}

// ---------- profiles ----------
const pending = new Set(); let profTimer = null;
function wantProfile(pk){ if (S.profiles.has(pk) || pending.has(pk)) return; pending.add(pk); clearTimeout(profTimer); profTimer = setTimeout(flushProfiles, 250); }
async function flushProfiles(){
  const authors = [...pending]; pending.clear(); if (!authors.length) return;
  const evs = await pool.querySync(RELAYS, { kinds: [0], authors }, { maxWait: 4000 }).catch(() => []);
  const best = new Map(); for (const e of evs) if (!best.has(e.pubkey) || best.get(e.pubkey).created_at < e.created_at) best.set(e.pubkey, e);
  for (const pk of authors){ let p = {}; const e = best.get(pk); if (e){ try { p = JSON.parse(e.content); } catch {} } S.profiles.set(pk, p); }
  renderAll();
}
const nameOf = pk => { const p = S.profiles.get(pk) || {}; return p.display_name || p.name || (pk === S.pubkey ? 'you' : nip19.npubEncode(pk).slice(0, 12) + '…'); };
const avatar = pk => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='32' fill='#${pk.slice(0,6)}'/><text x='32' y='42' font-size='28' font-family='Arial' font-weight='700' text-anchor='middle' fill='#fff'>${pk.slice(0,1).toUpperCase()}</text></svg>`)}`;
const picOf = pk => { const p = S.profiles.get(pk) || {}; return (p.picture && /^https?:\/\//.test(p.picture)) ? p.picture : avatar(pk); };

// ---------- chat ----------
function acceptEvent(e){
  if (!verifyEvent(e) || !e.tags.some(t => t[0] === 't' && t[1] === TAG)) return;
  if (e.kind === KIND_CHAT && (bytesOf(e.content) > MAX_BYTES || /<[a-z!/]/i.test(e.content) || /\n/.test(e.content))) return;
  if (e.kind === KIND_ZAP && !e.tags.some(t => t[0] === 'txid')) return;
  if (S.msgs.has(e.id)) return;
  S.msgs.set(e.id, e); S.seen.set(e.pubkey, Math.max(S.seen.get(e.pubkey) || 0, e.created_at));
  wantProfile(e.pubkey); for (const t of e.tags) if (t[0] === 'p' && /^[0-9a-f]{64}$/.test(t[1])) wantProfile(t[1]);
  scheduleRender();
}
let renderTimer = null; const scheduleRender = () => { clearTimeout(renderTimer); renderTimer = setTimeout(renderAll, 80); };
const tfmt = ts => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function lineHTML(e){
  const me = e.pubkey === S.pubkey; const who = nameOf(e.pubkey);
  const p = e.tags.find(t => t[0] === 'p'); const to = p ? ` <span class="muted">→ ${esc(nameOf(p[1]))}</span>` : '';
  if (e.kind === KIND_ZAP){ const amt = e.tags.find(t => t[0] === 'amount')?.[1] || '?'; const txid = e.tags.find(t => t[0] === 'txid')?.[1] || '';
    return `<div class="msg zap"><img class="pic" src="${picOf(e.pubkey)}" alt=""><span class="who${me?' me':''}" data-pk="${e.pubkey}">${esc(who)}</span><span class="txt">⚡ zapped ${Number(amt).toLocaleString()} sats${to}${e.content ? ' · ' + esc(e.content) : ''} <a class="small" href="/tx/${esc(txid)}">tx</a></span><span class="t">${tfmt(e.created_at)}</span></div>`; }
  return `<div class="msg"><img class="pic" src="${picOf(e.pubkey)}" alt=""><span class="who${me?' me':''}" data-pk="${e.pubkey}">${esc(who)}</span><span class="txt">${esc(e.content)}${to}</span><button class="re" data-re="${e.pubkey}" title="reply">↩</button><span class="t">${tfmt(e.created_at)}</span></div>`;
}
function renderAll(){
  const evs = [...S.msgs.values()].sort((a, b) => a.created_at - b.created_at);
  const log = $('chatLog'); const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  log.innerHTML = evs.length ? evs.slice(-300).map(lineHTML).join('') : '<div class="sys">Nothing here yet. Say hi.</div>';
  if (atBottom) log.scrollTop = log.scrollHeight;
  const buddies = [...S.seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
  $('buddyList').innerHTML = buddies.map(([pk]) => `<li data-pk="${pk}"><img src="${picOf(pk)}" alt=""><span>${esc(nameOf(pk))}</span></li>`).join('');
  $('buddyCount').textContent = buddies.length ? `(${buddies.length})` : '';
  if (S.profileView) renderProfile(S.profileView);
  if (S.pubkey){ $('chipName').textContent = nameOf(S.pubkey); $('chipPic').src = picOf(S.pubkey); }
}
function subscribe(){
  pool.subscribeMany(RELAYS, [{ kinds: [KIND_CHAT, KIND_ZAP], '#t': [TAG], since: Math.floor(Date.now()/1000) - 7*86400, limit: 300 }], {
    onevent: acceptEvent, oneose: () => { $('relayState').classList.add('on'); if (!S.msgs.size) $('chatLog').innerHTML = '<div class="sys">Nothing in the lounge this week. Say hi.</div>'; } });
}
async function signEvent(evt){ evt.created_at = Math.floor(Date.now()/1000); if (S.signer === 'bunker') return S.bunker.signEvent(evt); return S.signer === 'nip07' ? window.nostr.signEvent(evt) : finalizeEvent(evt, S.sk); }
async function publish(evt){
  const signed = await signEvent(evt); acceptEvent(signed);
  const res = await Promise.allSettled(pool.publish(RELAYS, signed));
  if (!res.some(r => r.status === 'fulfilled')) throw new Error('No relay accepted the event'); return signed;
}
async function postText(text, extraTags = []){
  if (bytesOf(text) > MAX_BYTES) throw new Error(`Too long: ${bytesOf(text)} bytes, cap is ${MAX_BYTES}`);
  return publish({ kind: KIND_CHAT, tags: [['t', TAG], ['client', 'blakerunner'], ...extraTags], content: text });
}
async function sendChat(){
  const text = $('chatInput').value.trim(); if (!text) return;
  $('sendBtn').disabled = true;
  try { await postText(text, S.replyTo ? [['p', S.replyTo]] : []); $('chatInput').value = ''; setReply(null); updateCount(); }
  catch (e) { toast(e.message); } finally { $('sendBtn').disabled = !S.pubkey; }
}
function setReply(pk){ S.replyTo = pk; const el = $('replyTo'); if (pk){ el.textContent = '↩ replying to ' + nameOf(pk) + ' (click to cancel)'; el.classList.remove('hidden'); } else el.classList.add('hidden'); }
function updateCount(){ const n = bytesOf($('chatInput').value); const c = $('byteCount'); c.textContent = `${n}/${MAX_BYTES}`; c.classList.toggle('over', n > MAX_BYTES); }

// ---------- balances / wallet ----------
async function balanceOf(addr){ try { const a = await j(`${MEMPOOL}/address/${addr}`); return (a.chain_stats.funded_txo_sum - a.chain_stats.spent_txo_sum) + (a.mempool_stats.funded_txo_sum - a.mempool_stats.spent_txo_sum); } catch { return 0; } }
async function totalBalance(pk){ const a = addresses(pk); const [s, t] = await Promise.all([balanceOf(a.segwit), balanceOf(a.taproot)]); return s + t; }
const sats = n => n.toLocaleString() + ' sats';
async function renderWallet(){
  if (!S.pubkey){ $('walletOut').classList.remove('hidden'); $('walletIn').classList.add('hidden'); return; }
  $('walletOut').classList.add('hidden'); $('walletIn').classList.remove('hidden');
  $('wSegwit').textContent = S.addrs.segwit; $('wTaproot').textContent = S.addrs.taproot; $('wAddrLink').href = '/address/' + S.addrs.segwit;
  $('wQr').src = await qr(S.addrs.segwit);
  $('sendOpenBtn').disabled = !S.sk;
  $('keyState').innerHTML = (S.signer === 'nip07' ? 'Signed in with an extension. Zaps and sends need a key stored in this browser: log out and log in with an nsec.' : S.signer === 'bunker' ? 'Signed in through your remote signer. Chat works; zaps and sends need a key stored in this browser.' : 'Key stored in this browser. You can chat, zap and send.')
    + (S.newNsec ? `<div class="addr" style="margin:8px 0 0"><small>new key · back this up now</small><code>${S.newNsec}</code></div>` : '');
  $('wBalance').textContent = '…'; $('wBalance').textContent = sats(await totalBalance(S.pubkey));
}

// ---------- transactions (P2WPKH spend) ----------
function validAddress(a){ try { btc.Address().decode(a); return true; } catch { return false; } }
async function planTx(dest, amt){
  if (!S.sk) throw new Error('You need a key stored in this browser to send.');
  if (!validAddress(dest)) throw new Error('That is not a valid Bitcoin address.');
  if (amt < DUST) throw new Error(`Minimum is ${DUST} sats.`);
  const utxos = (await j(`${MEMPOOL}/address/${S.addrs.segwit}/utxo`)).sort((a, b) => b.value - a.value);
  const fees = await j(MEMPOOL + '/v1/fees/recommended'); const rate = BigInt(Math.max(1, fees.fastestFee));
  const picked = []; let inSum = 0n, fee = 0n;
  for (const u of utxos){ picked.push(u); inSum += BigInt(u.value); fee = (11n + 68n * BigInt(picked.length) + 31n * 2n) * rate; if (inSum >= amt + fee) break; }
  if (inSum < amt + fee) throw new Error(`Not enough BLAKE2b sats in your segwit address (have ${inSum}, need ${amt + fee}).`);
  return { picked, amt, fee, rate, change: inSum - amt - fee, dest };
}
async function broadcast(plan){
  const sk = evenKey(S.sk); const spend = btc.p2wpkh(S.addrs.pub33); const tx = new btc.Transaction();
  for (const u of plan.picked) tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: spend.script, amount: BigInt(u.value) } });
  tx.addOutputAddress(plan.dest, plan.amt); if (plan.change >= DUST) tx.addOutputAddress(S.addrs.segwit, plan.change);
  tx.sign(sk); tx.finalize();
  const r = await fetch(MEMPOOL + '/tx', { method: 'POST', body: bytesToHex(tx.extract()) }); const txid = await r.text();
  if (!r.ok) throw new Error('Broadcast rejected: ' + txid); return txid.trim();
}
const quoteLine = p => `${p.picked.length} input${p.picked.length > 1 ? 's' : ''} · fee ${p.fee} sats @ ${p.rate} sat/vB · change ${p.change} sats`;
async function quoteZap(){
  const q = $('zapQuote'); q.textContent = '…';
  try { const p = await planTx(addresses(S.zapTarget).segwit, BigInt(Math.max(0, Math.floor(Number($('zapAmount').value) || 0)))); q.textContent = quoteLine(p); return p; } catch (e) { q.textContent = e.message; return null; }
}
async function sendZap(){
  const plan = await quoteZap(); if (!plan) return; const err = $('zapErr'); err.textContent = ''; $('zapSend').disabled = true;
  try { const txid = await broadcast(plan); const note = $('zapNote').value.trim();
    await publish({ kind: KIND_ZAP, tags: [['t', TAG], ['p', S.zapTarget], ['amount', String(plan.amt)], ['txid', txid], ['client', 'blakerunner']], content: note.slice(0, 60) });
    $('zapModal').classList.add('hidden'); toast(`⚡ Zapped ${plan.amt} sats · ${txid.slice(0, 10)}…`); afterSpend();
  } catch (e) { err.textContent = e.message; } finally { $('zapSend').disabled = false; }
}
async function quoteSend(){
  const q = $('sendQuote'); q.textContent = '…';
  try { const p = await planTx($('sendTo').value.trim(), BigInt(Math.max(0, Math.floor(Number($('sendAmount').value) || 0)))); q.textContent = quoteLine(p); return p; } catch (e) { q.textContent = e.message; return null; }
}
async function doSend(){
  const plan = await quoteSend(); if (!plan) return; const err = $('sendErr'); err.textContent = ''; $('sendGo').disabled = true;
  try { const txid = await broadcast(plan); $('sendModal').classList.add('hidden'); toast(`Sent ${plan.amt} sats · ${txid.slice(0, 10)}…`); afterSpend(); go('/tx/' + txid); }
  catch (e) { err.textContent = e.message; } finally { $('sendGo').disabled = false; }
}
function afterSpend(){ renderWallet(); S.balanceFor = null; if (S.profileView) renderProfile(S.profileView); }
function openSend(to = ''){ if (!S.pubkey) return $('loginModal').classList.remove('hidden'); if (!S.sk) return toast('Sends need a key stored in this browser.'); $('sendTo').value = to; $('sendErr').textContent = ''; $('sendQuote').textContent = ''; $('sendModal').classList.remove('hidden'); if (to) quoteSend(); }

// ---------- profile page ----------
async function renderProfile(pk){
  const p = S.profiles.get(pk) || {}; wantProfile(pk);
  $('pName').textContent = nameOf(pk); $('pPic').src = picOf(pk); $('pNip05').textContent = p.nip05 || ''; $('pNpub').textContent = nip19.npubEncode(pk); $('pAbout').textContent = p.about || '';
  const a = addresses(pk); $('pSegwit').textContent = a.segwit; $('pTaproot').textContent = a.taproot; $('pSegwitLink').href = '/address/' + a.segwit;
  const mine = [...S.msgs.values()].filter(e => e.pubkey === pk).sort((x, y) => x.created_at - y.created_at).slice(-40);
  $('pLog').innerHTML = mine.length ? mine.map(lineHTML).join('') : '<div class="sys">No lounge messages from this npub this week.</div>';
  $('zapBtn').disabled = pk === S.pubkey;
  if (S.balanceFor !== pk){ S.balanceFor = pk; $('pBalance').textContent = '…'; $('pQr').src = await qr(a.segwit); const b = await totalBalance(pk); if (S.balanceFor === pk) $('pBalance').textContent = sats(b); }
}

// ---------- routing ----------
const VIEWS = ['home', 'profile', 'block', 'tx', 'address'];
function show(v){ S.view = v; for (const x of VIEWS) $('view-' + x).classList.toggle('hidden', x !== v); window.scrollTo({ top: 0 }); }
function route(){
  const p = location.pathname; let m;
  S.profileView = null;
  if ((m = p.match(/^\/p\/(npub1[0-9a-z]+)/))){ try { const d = nip19.decode(m[1]); if (d.type === 'npub'){ S.profileView = d.data; show('profile'); renderProfile(d.data); return; } } catch {} }
  if ((m = p.match(/^\/block\/([0-9a-f]{64}|\d+)$/))){ show('block'); renderBlock(m[1]); return; }
  if ((m = p.match(/^\/tx\/([0-9a-f]{64})$/))){ show('tx'); renderTx(m[1]); return; }
  if ((m = p.match(/^\/address\/([a-zA-Z0-9]{26,90})$/))){ show('address'); renderAddress(m[1]); return; }
  show('home'); if (location.hash === '#lounge') $('lounge').scrollIntoView({ behavior: 'smooth' });
}
function go(path){ history.pushState({}, '', path); route(); }
function search(qs){
  const q = qs.trim(); if (!q) return;
  if (/^\d+$/.test(q)) return go('/block/' + q);
  if (/^npub1[0-9a-z]+$/.test(q)) return go('/p/' + q);
  if (/^[0-9a-f]{64}$/i.test(q)){ const h = q.toLowerCase(); return fetch(MEMPOOL + '/tx/' + h + '/status').then(r => go(r.ok ? '/tx/' + h : '/block/' + h)).catch(() => go('/block/' + h)); }
  if (validAddress(q)) return go('/address/' + q);
  toast('Not a height, block hash, txid, address or npub.');
}

// ---------- login / keys ----------
async function kdf(pass, salt){ const km = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']); return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
const b64 = b => btoa(String.fromCharCode(...b)); const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function storeKey(sk, pass){
  if (!pass){ localStorage.setItem('br_key', JSON.stringify({ plain: bytesToHex(sk) })); return; }
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await kdf(pass, salt), sk));
  localStorage.setItem('br_key', JSON.stringify({ salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
}
async function loadKey(pass){
  const rec = JSON.parse(localStorage.getItem('br_key') || 'null'); if (!rec) return null; if (rec.plain) return hexToBytes(rec.plain);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv) }, await kdf(pass, unb64(rec.salt)), unb64(rec.ct)));
}
function session(pubkey, signer, sk){
  S.pubkey = pubkey; S.npub = nip19.npubEncode(pubkey); S.signer = signer; S.sk = sk || null; S.addrs = addresses(pubkey);
  localStorage.setItem('br_session', JSON.stringify({ pubkey, signer }));
  $('loginBtn').classList.add('hidden'); $('userChip').classList.remove('hidden'); $('chatInput').disabled = false; $('sendBtn').disabled = false;
  wantProfile(pubkey); renderWallet(); renderAll();
}
function logout(){ S.pubkey = S.npub = S.signer = S.sk = S.addrs = S.newNsec = S.bunker = null; localStorage.removeItem('br_session'); localStorage.removeItem('br_bunker'); localStorage.removeItem('br_bunker_sk'); $('loginBtn').classList.remove('hidden'); $('userChip').classList.add('hidden'); $('chatInput').disabled = true; $('sendBtn').disabled = true; renderWallet(); renderAll(); }
async function loginBunker(str){
  const bp = await parseBunkerInput(str.trim()); if (!bp) throw new Error('That is not a bunker:// URL or a nostrconnect name.');
  let csk = localStorage.getItem('br_bunker_sk'); csk = csk ? hexToBytes(csk) : generateSecretKey();
  const signer = new BunkerSigner(csk, bp, { pool });
  await Promise.race([signer.connect(), new Promise((_, r) => setTimeout(() => r(new Error('The bunker did not answer in 20 s. Approve the connection in your signer app and try again.')), 20000))]);
  const pk = await signer.getPublicKey(); localStorage.setItem('br_bunker', str.trim()); localStorage.setItem('br_bunker_sk', bytesToHex(csk)); S.bunker = signer; session(pk, 'bunker');
}
async function loginNip07(){ if (!window.nostr) throw new Error('No NIP-07 extension found (Alby, nos2x, …)'); session(await window.nostr.getPublicKey(), 'nip07'); }
async function loginLocal(nsec, pass){
  let sk; if (nsec){ const d = nip19.decode(nsec.trim()); if (d.type !== 'nsec') throw new Error('That is not an nsec'); sk = d.data; }
  else { sk = generateSecretKey(); S.newNsec = nip19.nsecEncode(sk); toast('New key created. Back it up: it lives only in this browser.'); }
  await storeKey(sk, pass); session(getPublicKey(sk), 'local', sk);
}
async function restore(){
  const s = JSON.parse(localStorage.getItem('br_session') || 'null'); if (!s) return;
  if (s.signer === 'nip07'){ if (window.nostr){ try { session(await window.nostr.getPublicKey(), 'nip07'); } catch {} } return; }
  if (s.signer === 'bunker'){ const b = localStorage.getItem('br_bunker'); if (b){ try { await loginBunker(b); } catch (e) { toast('Bunker reconnect failed: ' + e.message); } } return; }
  const rec = JSON.parse(localStorage.getItem('br_key') || 'null'); if (!rec) return;
  if (rec.plain){ const sk = hexToBytes(rec.plain); session(getPublicKey(sk), 'local', sk); return; }
  $('unlockModal').classList.remove('hidden');
}

// ---------- ui wiring ----------
let toastT; function toast(m){ const t = $('toast'); t.textContent = m; t.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 4200); }
document.addEventListener('click', e => {
  const pk = e.target.closest('[data-pk]')?.dataset.pk; if (pk){ go('/p/' + nip19.npubEncode(pk)); return; }
  const re = e.target.closest('[data-re]')?.dataset.re; if (re){ setReply(re); $('chatInput').focus(); return; }
  const blk = e.target.closest('[data-block]')?.dataset.block; if (blk){ go('/block/' + blk); return; }
  const to = e.target.closest('[data-sendto]')?.dataset.sendto; if (to){ openSend(to); return; }
  const c = e.target.closest('[data-close]'); if (c) $(c.dataset.close).classList.add('hidden');
  const a = e.target.closest('a[href^="/"]'); if (a && !a.target && !a.getAttribute('href').startsWith('/game')){ e.preventDefault(); if (a.getAttribute('href') === '/#lounge'){ history.pushState({}, '', '/#lounge'); route(); } else go(a.getAttribute('href')); }
});
$('replyTo').onclick = () => setReply(null);
$('loginBtn').onclick = () => { $('loginErr').textContent = ''; $('loginModal').classList.remove('hidden'); };
$('logoutBtn').onclick = logout;
$('bunkerBtn').onclick = async () => { $('bunkerBtn').disabled = true; $('loginErr').textContent = 'Connecting… approve it in your signer app.'; try { await loginBunker($('bunkerInput').value); $('loginErr').textContent = ''; $('loginModal').classList.add('hidden'); } catch (e) { $('loginErr').textContent = e.message; } finally { $('bunkerBtn').disabled = false; } };
$('nip07Btn').onclick = async () => { try { await loginNip07(); $('loginModal').classList.add('hidden'); } catch (e) { $('loginErr').textContent = e.message; } };
$('localKeyBtn').onclick = async () => { try { await loginLocal($('nsecInput').value, $('passInput').value); $('nsecInput').value = $('passInput').value = ''; $('loginModal').classList.add('hidden'); } catch (e) { $('loginErr').textContent = e.message; } };
$('unlockBtn').onclick = async () => { try { const sk = await loadKey($('unlockPass').value); session(getPublicKey(sk), 'local', sk); $('unlockModal').classList.add('hidden'); } catch { $('unlockErr').textContent = 'Wrong passphrase'; } };
$('forgetBtn').onclick = () => { localStorage.removeItem('br_key'); localStorage.removeItem('br_session'); $('unlockModal').classList.add('hidden'); };
$('chatForm').onsubmit = e => { e.preventDefault(); sendChat(); };
$('chatInput').oninput = updateCount;
$('searchForm').onsubmit = e => { e.preventDefault(); search($('searchInput').value); $('searchInput').value = ''; };
$('zapBtn').onclick = () => { if (!S.pubkey) return $('loginModal').classList.remove('hidden'); S.zapTarget = S.profileView; $('zapName').textContent = nameOf(S.zapTarget); $('zapErr').textContent = ''; $('zapModal').classList.remove('hidden'); quoteZap(); };
$('zapAmount').oninput = () => { clearTimeout(S.qT); S.qT = setTimeout(quoteZap, 400); };
$('zapSend').onclick = sendZap;
$('sendOpenBtn').onclick = () => openSend();
$('sendTo').oninput = $('sendAmount').oninput = () => { clearTimeout(S.sT); S.sT = setTimeout(quoteSend, 400); };
$('sendGo').onclick = doSend;
window.addEventListener('popstate', route);

// ---------- boot ----------
initExplorer({ $, j, esc, go, toast, MEMPOOL, qr, session: () => S.pubkey ? S : null });
route(); loadStats(); loadBlocks(); setInterval(() => { loadStats(); loadBlocks(); }, 30000); subscribe(); restore(); renderWallet();
