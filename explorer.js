// Explorer views on top of the mempool.guide API (proxied at /mp).
let C = null; // context injected by app.js: { $, j, esc, go, toast, MEMPOOL, session(), addressesFor(pk) }
export function initExplorer(ctx){ C = ctx; }

const ago = ts => { const s = Math.max(0, Math.floor(Date.now()/1000 - ts)); if (s < 60) return s + 's ago'; if (s < 3600) return Math.floor(s/60) + 'm ago'; if (s < 86400) return Math.floor(s/3600) + 'h ' + Math.floor(s%3600/60) + 'm ago'; return Math.floor(s/86400) + 'd ago'; };
const kb = n => (n/1e6).toFixed(2) + ' MB';
const btcFmt = sats => (sats/1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '.0') + ' BTC';
const satsFmt = n => Number(n).toLocaleString() + ' sats';
const short = (h, n = 8) => h.slice(0, n) + '…' + h.slice(-n);
const OUR_TAG = 'blakerunner2026';

function minerOf(b){
  const e = b.extras || {}; const pool = e.pool?.name;
  const ascii = (e.coinbaseSignatureAscii || '').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();
  if (pool && pool !== 'Unknown') return { name: pool, tag: ascii, ours: ascii.includes(OUR_TAG) };
  const m = ascii.match(/[A-Za-z][A-Za-z0-9 .\-_/'@]{3,}/); return { name: m ? m[0].trim().slice(0, 22) : 'Unknown', tag: ascii, ours: ascii.includes(OUR_TAG) };
}

// ---------- blocks strip ----------
export async function loadBlocks(){
  try {
    const [blocks, proj] = await Promise.all([C.j(C.MEMPOOL + '/v1/blocks'), C.j(C.MEMPOOL + '/v1/fees/mempool-blocks')]);
    C.$('chainBlocks').innerHTML = blocks.map(b => { const m = minerOf(b); return `<div class="blk mined${m.ours ? ' blake' : ''}" data-block="${b.id}" title="${C.esc(m.tag || m.name)}">
      <div class="h">${b.height.toLocaleString()}</div><div class="m">${C.esc(m.name)}</div>
      <div class="s">${b.tx_count} tx · ${kb(b.size)}<br>${(b.extras?.medianFee ?? 0).toFixed(1)} sat/vB · ${satsFmt(b.extras?.totalFees ?? 0)}</div><div class="t">${ago(b.timestamp)}</div></div>`; }).join('');
    C.$('mempoolBlocks').innerHTML = proj.slice(0, 4).map((p, i) => `<div class="blk proj" title="projected next block ${i + 1}">
      <div class="h">+${i + 1}</div><div class="m">mempool</div><div class="s">${p.nTx} tx · ${kb(p.blockSize)}<br>~${p.medianFee.toFixed(2)} sat/vB · ${satsFmt(p.totalFees)}</div><div class="t">${p.feeRange[0].toFixed(2)}–${p.feeRange.at(-1).toFixed(2)} sat/vB</div></div>`).join('');
    C.$('blocksState').classList.add('on');
  } catch (e) { console.warn('blocks', e); C.$('blocksState').classList.remove('on'); }
}

// ---------- block page ----------
export async function renderBlock(id){
  const out = C.$('blockOut'); out.innerHTML = '<div class="sys">Loading block…</div>';
  try {
    const hash = /^\d+$/.test(id) ? await fetch(C.MEMPOOL + '/block-height/' + id).then(r => { if (!r.ok) throw new Error('No block at height ' + id); return r.text(); }) : id;
    const b = await C.j(C.MEMPOOL + '/v1/block/' + hash).catch(() => C.j(C.MEMPOOL + '/block/' + hash));
    const m = minerOf(b); const e = b.extras || {};
    out.innerHTML = `<h2>Block ${b.height.toLocaleString()} ${m.ours ? '<span class="badge ok">mined by this runner</span>' : ''}</h2>
      <div class="mono small muted">${b.id}</div>
      <div class="kv">
        <div class="addr"><small>miner</small><b>${C.esc(m.name)}</b></div>
        <div class="addr"><small>time</small><b>${new Date(b.timestamp*1000).toLocaleString()}</b><span class="small muted">${ago(b.timestamp)}</span></div>
        <div class="addr"><small>transactions</small><b>${b.tx_count.toLocaleString()}</b></div>
        <div class="addr"><small>size / weight</small><b>${kb(b.size)} · ${(b.weight/1e6).toFixed(2)} MWU</b></div>
        <div class="addr"><small>reward</small><b>${e.reward != null ? btcFmt(e.reward) : '—'}</b></div>
        <div class="addr"><small>total fees</small><b>${e.totalFees != null ? satsFmt(e.totalFees) : '—'}</b></div>
        <div class="addr"><small>median fee</small><b>${e.medianFee != null ? e.medianFee.toFixed(2) + ' sat/vB' : '—'}</b></div>
        <div class="addr"><small>difficulty</small><b>${Number(b.difficulty).toLocaleString(undefined, { maximumFractionDigits: 0 })}</b></div>
        <div class="addr"><small>nonce</small><b>${b.nonce}</b></div>
        <div class="addr"><small>bits</small><b>${b.bits.toString(16)}</b></div>
      </div>
      <div class="addr"><small>coinbase tag</small><div class="coinbase">${C.esc(m.tag || '(none)')}</div></div>
      <div class="row" style="margin-top:10px"><a class="btn ghost" href="/block/${b.height - 1}">← ${b.height - 1}</a><a class="btn ghost" href="/block/${b.height + 1}">${b.height + 1} →</a><a class="btn ghost" href="https://mempool.guide/block/${b.id}" target="_blank" rel="noopener">mempool.guide ↗</a></div>
      <h3>Transactions</h3><div id="blockTxs"><div class="sys">Loading…</div></div>`;
    const txs = await C.j(`${C.MEMPOOL}/block/${b.id}/txs`);
    C.$('blockTxs').innerHTML = txTable(txs) + (b.tx_count > 25 ? `<div class="more muted small">Showing 25 of ${b.tx_count}. <a href="https://mempool.guide/block/${b.id}" target="_blank" rel="noopener">All on mempool.guide ↗</a></div>` : '');
  } catch (err) { out.innerHTML = `<div class="err">${C.esc(err.message)}</div>`; }
}
const txTable = txs => `<table class="tx"><thead><tr><th>txid</th><th class="r">in → out</th><th class="r">amount</th><th class="r">fee</th><th class="r">vB</th></tr></thead><tbody>` +
  txs.map(t => { const cb = t.vin[0]?.is_coinbase; const amt = t.vout.reduce((a, o) => a + o.value, 0); const vb = Math.ceil(t.weight/4);
    return `<tr><td><a href="/tx/${t.txid}" class="mono">${short(t.txid, 10)}</a>${cb ? ' <span class="badge ok">coinbase</span>' : ''}</td><td class="r">${t.vin.length} → ${t.vout.length}</td><td class="r">${satsFmt(amt)}</td><td class="r">${cb ? '—' : (t.fee/vb).toFixed(2) + ' sat/vB'}</td><td class="r">${vb}</td></tr>`; }).join('') + '</tbody></table>';

// ---------- tx page ----------
export async function renderTx(txid){
  const out = C.$('txOut'); out.innerHTML = '<div class="sys">Loading transaction…</div>';
  try {
    const t = await C.j(C.MEMPOOL + '/tx/' + txid); const st = t.status || {};
    const cb = t.vin[0]?.is_coinbase; const vb = Math.ceil(t.weight/4);
    const tip = Number(C.$('sHeight').textContent.replace(/\D/g, '')) || 0; const conf = st.confirmed ? tip - st.block_height + 1 : 0;
    const side = (items, isIn) => items.map(x => { const a = isIn ? (x.is_coinbase ? null : x.prevout?.scriptpubkey_address) : x.scriptpubkey_address; const v = isIn ? x.prevout?.value : x.value;
      return `<div class="addr">${a ? `<a href="/address/${a}"><code>${a}</code></a>` : `<code class="muted">${isIn ? 'coinbase (new coins)' : C.esc(x.scriptpubkey_type || 'script')}</code>`}<b>${v != null ? satsFmt(v) : ''}</b></div>`; }).join('');
    out.innerHTML = `<h2>Transaction ${st.confirmed ? `<span class="badge ok">${conf} confirmation${conf === 1 ? '' : 's'}</span>` : '<span class="badge warn">unconfirmed</span>'}</h2>
      <div class="mono small muted" style="word-break:break-all">${t.txid}</div>
      <div class="kv">
        <div class="addr"><small>block</small><b>${st.confirmed ? `<a href="/block/${st.block_hash}">${st.block_height.toLocaleString()}</a>` : 'mempool'}</b></div>
        <div class="addr"><small>time</small><b>${st.block_time ? ago(st.block_time) : '—'}</b></div>
        <div class="addr"><small>fee</small><b>${cb ? 'coinbase' : satsFmt(t.fee) + ' · ' + (t.fee/vb).toFixed(2) + ' sat/vB'}</b></div>
        <div class="addr"><small>size</small><b>${t.size} B · ${vb} vB</b></div>
        <div class="addr"><small>version / locktime</small><b>${t.version} / ${t.locktime}</b></div>
      </div>
      <div class="io"><div class="side"><h3>Inputs (${t.vin.length})</h3>${side(t.vin, true)}</div><div class="arrow">→</div><div class="side"><h3>Outputs (${t.vout.length})</h3>${side(t.vout, false)}</div></div>
      <a class="btn ghost" href="https://mempool.guide/tx/${t.txid}" target="_blank" rel="noopener">mempool.guide ↗</a>`;
  } catch (err) { out.innerHTML = `<div class="err">${C.esc(err.message)}</div>`; }
}

// ---------- address page ----------
export async function renderAddress(addr){
  const out = C.$('addressOut'); out.innerHTML = '<div class="sys">Loading address…</div>';
  try {
    const [a, txs, qr] = await Promise.all([C.j(C.MEMPOOL + '/address/' + addr), C.j(`${C.MEMPOOL}/address/${addr}/txs`), C.qr(addr)]);
    const bal = a.chain_stats.funded_txo_sum - a.chain_stats.spent_txo_sum; const pend = a.mempool_stats.funded_txo_sum - a.mempool_stats.spent_txo_sum;
    const me = C.session(); const canSend = me?.sk && me.addrs.segwit !== addr;
    out.innerHTML = `<h2>Address</h2>
      <div class="qrWrap"><img src="${qr}" alt="QR"><div class="addr"><small>address</small><code>${C.esc(addr)}</code></div></div>
      <div class="kv">
        <div class="addr"><small>balance</small><b>${satsFmt(bal)}</b>${pend ? `<span class="small muted">${pend > 0 ? '+' : ''}${pend.toLocaleString()} unconfirmed</span>` : ''}</div>
        <div class="addr"><small>received</small><b>${satsFmt(a.chain_stats.funded_txo_sum)}</b></div>
        <div class="addr"><small>sent</small><b>${satsFmt(a.chain_stats.spent_txo_sum)}</b></div>
        <div class="addr"><small>transactions</small><b>${a.chain_stats.tx_count + a.mempool_stats.tx_count}</b></div>
      </div>
      <div class="row">${canSend ? `<button class="btn alt" data-sendto="${C.esc(addr)}">Send sats here</button>` : ''}<a class="btn ghost" href="https://mempool.guide/address/${addr}" target="_blank" rel="noopener">mempool.guide ↗</a></div>
      <h3>Transactions</h3>${txs.length ? txTable(txs) : '<div class="sys">No transactions yet.</div>'}`;
  } catch (err) { out.innerHTML = `<div class="err">${C.esc(err.message)}</div>`; }
}
