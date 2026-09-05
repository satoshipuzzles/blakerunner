# perf probes

Not part of `npm test` — these measure rather than assert, and two of them need a browser.
The behaviour they justify is pinned by `test/land-runs.test.mjs`, which does run in CI.

| script | needs | what it answers |
| --- | --- | --- |
| `draw-bench.mjs` | playwright | How much frame time do the land layer and minimap cost, as a function of how much territory is owned? Before vs after run-coalescing. |
| `draw-pixels.mjs` | playwright, a git checkout | Did coalescing change what the game looks like? Lifts the real draw statements out of `HEAD` and out of `$BASE_REF` (default `buzz/main`) and diffs the rendered pixels. |
| `land-payload.mjs` | node only | Does the `land` keyframe grow with territory? Grows a territory with the real `capture()` flood fill and measures the RLE. |
| `capture-rate.mjs` | node only | Does a bigger territory make you capture — and therefore publish — more often? |
| `wire-latency.mjs` | node only, network | Publish→delivery round trip on the game relays, from the publishing socket and from a second one, plus schnorr sign/verify cost. |
| `crypto-cost.mjs` | playwright, network | The same schnorr numbers in the browser, loading nostr-tools the way `race.js` does. Node's JIT is not the game's. |
| `ping-live.mjs` | playwright, network | Rides a guest on the real page and reads `#hPing` out of the live DOM. Exits non-zero if the ping never resolves. |
| `drone-brains.mjs` | node only | Do the three drone classes actually play differently? Runs the real brain and the real movement/capture/kill code for six simulated minutes and scores each class. |

```sh
node test/perf/land-payload.mjs
node test/perf/capture-rate.mjs
node test/perf/drone-brains.mjs                    # ROUNDS=20 MINUTES=10 for a tighter read
node test/perf/wire-latency.mjs                    # RELAYS=wss://... to probe others

npm i -D playwright && npx playwright install chromium
node test/perf/draw-bench.mjs
node test/perf/draw-pixels.mjs
node test/perf/crypto-cost.mjs
node test/perf/ping-live.mjs                       # or URL=http://127.0.0.1:8731/game/
```

## What they said on 2026-09-05, against `buzz/main` c8b0b50

`draw-bench` — 1440×900, 3648 cells in the cull window, 4 riders, median of 25 round-robin
samples × 10 draws; two independent runs agreed within 3%:

```
owned  visible   land_now  land_fast    mini_now  mini_nostyle  mini_fast   total_now  total_fast
   0%        0       0.00       0.01         0.00          0.01       0.01        0.00        0.02
  50%     1824       1.86       0.24         1.25          0.86       0.06        3.11        0.30
 100%     3648       2.01       0.24         2.40          1.64       0.11        4.41        0.35
```

Frame cost went from ~0 on an empty grid to 4.41 ms on a full one — that is the "it gets laggy
once people own land" report, and it is 26% of a 60 fps budget before anything else in `draw()`.

`land-payload` and `capture-rate` are here because they ruled out the two obvious *network*
explanations before the renderer was touched: real flood-fill territories stay compact (68.8% of
the grid encodes to 882 bytes, so the forced `sendLand(true)` on every capture is not the
problem), and capture rate does not rise as territory grows.

`draw-pixels` — see its header comment. Not pixel-identical, and the reasons are understood and
checked by eye.

## Wire latency, 2026-09-05, one relay (coolfeed)

`wire-latency` — 40 ticks at 10 Hz, distinct content per event so nothing dedupes:

```
publisher socket (what a self-echo ping reads)   40/40   min 59.3  p50 65.5  p90 69.3  max 71.7 ms
second socket (what another rider waits)         40/40   min 57.4  p50 63.4  p90 67.5  max 69.9 ms
```

Two things fall out of that. The relay **does** echo an ephemeral back to the socket that
published it, which is the whole basis of the on-screen ping. And the publisher's own echo tracks
what a second socket waits to within about 2 ms, so a self-echo ping is honest rather than
flattering — it needs no peer's clock, which matters because a skewed peer clock is the same
trapdoor that made `since` filters black out the grid.

**Ephemeral does not mean fast.** Ephemeral means the relay never stores it. The ~65 ms is
transit and relay handling, and no client-side change touches it. The only levers on that number
are a closer relay and fewer hops.

`crypto-cost` in Chromium, nostr-tools 2.10.4 off esm.sh: **sign 1.00 ms, verify 0.70 ms** per
event. Verification is memoised on the event *object*, so re-verifying one object measures a
property read — every rep here gets a fresh object, which is what arrives off a websocket. At
10 Hz that is 5.9% of one core at 8 riders, and a worst case of 4.9 ms of verification in a
single frame out of a 16.7 ms budget. On a phone, several times that.

## Drone classes, 2026-09-05

`drone-brains` — 12 rounds × 6 simulated minutes, 7 drones, no human rider. Per drone, averaged
over the round; range across rounds in brackets:

```
  class   label     claimed cells        kills           deaths
  dumb    drifter    1085 [308–2191   ]   9.6 [6–13   ]   21.9 [19–25]
  medium  steady     2767 [2101–3216  ]   7.8 [5–14   ]    9.1 [5–17]
  smart   sharp      3680 [2925–4410  ]  26.0 [22–31  ]   10.6 [7–13]

  reasons given, share of frames alive:
  dumb    claiming 85%, roaming 8%, heading home 6%, dodging 2%
  medium  claiming 51%, roaming 37%, heading home 7%, guarding its tail 5%, dodging 1%
  smart   claiming 38%, roaming 21%, hunting 18%, heading home 12%, guarding its tail 10%, dodging 1%
```

Kills and deaths separate with **non-overlapping ranges** — the sharp class out-kills every
drifter round 22–31 to 6–13, and the drifter dies 19–25 times against everyone else's 5–17. Land
claimed overlaps at the edges, which is what a `slip` of .25 buys: a drifter round can go well.

Two results worth keeping rather than tuning away:

- **The sharp class dies slightly MORE than the steady one** (10.6 vs 9.1). Hunting means leaving
  your own land to go stand in someone else's neighbourhood, and it costs. That is a real trade,
  not a bug — a class that were better at everything would just be the only class worth having.
- **`guarding its tail` is 0% for the drifter** and 5%/10% for the two above it. That is the dial
  doing the work the classes are built on: entering another rider's tail kills *them*, so the only
  way a drone loses ground is leaving a long trail out while somebody walks up it. The drifter
  never looks back, which is what makes its territory worth taking.

The mechanism behind these numbers is pinned by `test/drone-classes.test.mjs`, which does run in
CI. The numbers themselves are statistical and would be a flaky gate, which is why they live here.
