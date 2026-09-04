// HODLAND service worker. Scope /game. Shell files network-first with cache fallback, so a deploy
// shows up on the next load and HTML/JS never mismatch; offline still gets the last good shell.
// Everything else (relays, /mp API, profile images) goes straight to the network.
const V = 'hodland-v3';
const SHELL = ['/game', '/game/race.js', '/styles.css', '/game/manifest.webmanifest', '/game/icon-192.png', '/game/icon-512.png', '/game/logo.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url); if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.startsWith('/mp/')) return;
  const isShell = SHELL.includes(u.pathname) || u.pathname === '/game/';
  if (!isShell) return;
  // Clone synchronously: the body can be read only once, and `caches.open` resolves after we have
  // already returned `r` to the page, so cloning inside that callback races the browser reading it.
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(V).then(c => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
