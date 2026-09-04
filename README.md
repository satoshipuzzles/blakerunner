# BlakeRunner (forever21.lol)

Synthwave block explorer + Nostr lounge for the BIP-110 / BLAKE2b Bitcoin chain.
Static site, no backend, deployed to the Vercel project `blakerunner`
(`vercel --prod --yes` from this dir). Live at https://forever21.lol.

## What it does
- **Explorer**: chain strip (projected mempool blocks + last 15 mined blocks with miner
  name from mempool.guide pool detection or the coinbase ASCII tag; blocks carrying
  `blakerunner2026` glow green), `/block/<hash|height>`, `/tx/<txid>`,
  `/address/<addr>` with QR and "Send sats here", and a header search that routes
  heights, hashes, txids, addresses and npubs.
- **Game** at `/game`: canvas endless runner. Logged-in players can post their score
  to the lounge as a kind 2110 message.
- **Wallet**: QR for the segwit address, balance, and a Send modal (any address).
- **Stats bar**: height, hashrate, difficulty epoch, next retarget, mempool, fees from
  mempool.guide. Requests go through the same-origin proxy `/mp/*` (a `vercel.json`
  rewrite) because mempool.guide's esplora routes lack CORS headers.
- **Login**: NIP-07 extension, or an nsec kept in the browser (AES-GCM with a PBKDF2
  passphrase, or plain localStorage if no passphrase). A fresh key can be generated.
- **Chat**: one room. Nostr **kind 2110**, tag `["t","blake"]`, text only, hard 80-byte
  UTF-8 cap enforced on send and on display. Replies add a `p` tag. Kind 0 profiles
  are fetched in batches for names and pictures. Click a name → `/p/<npub>`.
- **Profiles**: kind 0 info, nostronchain-compatible addresses, live BLAKE2b balance,
  recent lounge lines, Zap button.
- **Zaps**: on-chain. Spends the sender's P2WPKH UTXOs to the recipient's P2WPKH
  address, signed in-browser with @scure/btc-signer, broadcast via mempool.guide,
  then a **kind 2111** receipt (`p`, `amount`, `txid` tags) is published so the room
  shows it. Requires a browser-held key; NIP-07 alone cannot sign Bitcoin.
- Relays: damus, nos.lol, relay.nostr.band, nostr.wine, eden.nostr.land. No Primal.

## Address derivation (matches nostronchain)
- segwit: `bech32('bc', v0, hash160(0x02 || x))`. Spending key is `d` if the real
  point has even Y, else `n - d`.
- taproot: `bech32m('bc', v1, x)`. Note nostronchain itself encodes this with plain
  bech32, which is invalid for witness v1, so its taproot string will not match.

## Files
`index.html` app shell · `styles.css` pure-CSS synthwave scene + theme · `app.js` core
(state, login, chat, wallet, tx building, routing) · `explorer.js` chain strip and
explorer pages · `game.js` runner game. Deps from esm.sh; no build step.


## HODLAND (`/game`)
`game/index.html` + `game/race.js`, PWA files (`manifest.webmanifest`, icons, `logo.svg`) and the
service worker at `/sw-game.js` (scope `/game`). Splix-style territory game; architecture patterns
from nostr-tank-arena (npub identity, session key for tick traffic, relays as netcode, rounds =
blocks, signed scores). Everything except the block clock is a Nostr event.
- **Play**: 140×90 grid. Start on a 3×3 plot; leaving draws a tail; re-entering your land claims
  the tail plus everything enclosed (border flood fill). Crossing a tail wipes its owner out.
  Edge or own tail wipes you out. Boost 0.8 s / 3.5 s cooldown. Standings by land %, kills break
  ties. Local drones fill the grid (see Grids and Drones below).
- **Riders**: kind 0 picture drawn as the head inside a colored ring; land color (hue) and pattern
  (solid / stripes / dots / checker / grid) chosen in "My colors", saved in localStorage, sent in
  every tick. Wipe-outs burst particles; claims ripple a ring; a notification feed announces kills,
  big claims, joins and block winners. Vibration on death where supported.
- **Rounds**: one BLAKE2b block (mempool.guide via `/mp`). New tip → podium 7 s → grid wiped.
- **Nostr**: relays coolfeed, mostr, purplerelay, nos.lol (no Primal). Kinds: 21110 tick (6 Hz,
  session key: pos, dir, tail cells, style), 21111 event (`land` RLE every 5 s and on capture,
  `die`, `kill`), 2113 session claim (session pub → npub), 2112 signed round score
  (`#t hodland-<height>`, `d` = height, content land/cells/kills/deaths). Leaderboard "This block"
  is live standings; "All time" aggregates kind 2112 events (block wins, rounds, best %, kills,
  deaths, K/D ratio).
  Rows link to `/p/<npub>` where the rider's BLAKE2b wallet is shown.
- **Grids (rooms)**: a room is a string two riders agreed on (Tank Arena pattern). Ticks and events
  carry `#t hodland-r-<room>` so grids stay separate; session claims and signed scores stay global.
  Every rider publishes a presence beacon (kind 30078, `d` = `hodland/here`, `#t hodland-live`,
  NIP-40 `expiration` 120 s, republished every 30 s, signed by the npub or the guest session key)
  and the lobby lists **Live grids** with riders, block, drone count and a Join button. "Private"
  keeps the beacon off the live index; the room name is the secret. Eight seats is a courtesy.
- **Drones (bots)**: 0–7 local practice riders, stepper in the lobby and in-game, `B` toggles,
  `[` / `]` step. They leave one at a time as real riders arrive. Saved in localStorage.
- **Share**: invite link `/game?room=<name>&bots=<n>&private=1` (only non-default parts are
  written). "Share grid" uses the native share sheet on phones, the clipboard elsewhere; `I` copies.
- **Controls panel** (`C`): keyboard, phone, grid hotkeys and the rules. `L` leaderboard, `Esc` closes.
- **Login**: lounge login carried over (local key, NIP-07 or bunker), NIP-07, NIP-46 bunker
  (`bunker://` or `name@nsec.app`, client key kept in localStorage), or guest.
- **Mobile**: swipe to steer, tap to boost, compact HUD, installable PWA (standalone, icons).
- Hidden tabs keep simulating on a timer with sub-stepping, so alt-tabbed riders stay live.
- Debug handle: `window.hodland` (`room`, `setRoom`, `setBots`, `inviteUrl`).

The lounge (`app.js`) also accepts NIP-46 bunker login; bunker and NIP-07 users can chat and see
their derived BLAKE2b wallet, but zaps/sends need a browser-held key.

## Tests

No build step — Vercel serves these files as they are, so a parse error ships straight to
production and the game silently fails to load. `npm test` is the gate.

```sh
npm install
npm test            # parse check + netcode invariants. no network, runs on every PR
npm run test:relays # live: do the relays in GAME_RELAYS actually carry this game's kinds?
```

`test/netcode.test.mjs` encodes bugs that already shipped once, so a refactor can only
reintroduce them on purpose: a subscription filter derived from the client clock (a rider whose
clock ran fast saw an empty grid), replayed history reaching the kill/death counters, and a
dropped subscription never recovering. Each one fails against the pre-fix `race.js`.

`test/relay-contract.test.mjs` publishes with throwaway guest keys and checks both that
each relay accepts the game's kinds and that a second guest actually receives them — an
`OK` is a receipt, not a delivery. It is off the PR gate because it talks to third-party
relays and does flake. Run it before changing a kind constant or the relay list: a new kind is
gated by default on a WoT relay, so it will look fine locally and drop every guest's events in
production.

Constants are read out of `game/race.js` at test time rather than restated, so the tests
cannot drift from the source they guard.
