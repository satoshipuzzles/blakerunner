# perf probes

Not part of `npm test` — these measure rather than assert, and two of them need a browser.
The behaviour they justify is pinned by `test/land-runs.test.mjs`, which does run in CI.

| script | needs | what it answers |
| --- | --- | --- |
| `draw-bench.mjs` | playwright | How much frame time do the land layer and minimap cost, as a function of how much territory is owned? Before vs after run-coalescing. |
| `draw-pixels.mjs` | playwright, a git checkout | Did coalescing change what the game looks like? Lifts the real draw statements out of `HEAD` and out of `$BASE_REF` (default `buzz/main`) and diffs the rendered pixels. |
| `land-payload.mjs` | node only | Does the `land` keyframe grow with territory? Grows a territory with the real `capture()` flood fill and measures the RLE. |
| `capture-rate.mjs` | node only | Does a bigger territory make you capture — and therefore publish — more often? |

```sh
node test/perf/land-payload.mjs
node test/perf/capture-rate.mjs

npm i -D playwright && npx playwright install chromium
node test/perf/draw-bench.mjs
node test/perf/draw-pixels.mjs
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
