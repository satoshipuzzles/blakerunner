// HODLAND service worker. Scope /game. Shell files cache-first with background refresh;
// everything else (relays, /mp API, profile images) goes straight to the network.
const V = 'hodland-v1';
const SHELL = ['/game', '/game/race.js', '/styles.css', '/game/manifest.webmanifest', '/game/icon-192.png', '/game/icon-512.png', '/game/logo.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url); if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.startsWith('/mp/')) return;
  const isShell = SHELL.includes(u.pathname) || u.pathname === '/game/';
  if (!isShell) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => {
    const net = fetch(e.request).then(r => { if (r.ok) caches.open(V).then(c => c.put(e.request, r.clone())); return r; }).catch(() => hit);
    return hit || net;
  }));
});
