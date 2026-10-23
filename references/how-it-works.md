# How stroke-paint works, and how to steer it

Everything below is implemented in `scripts/paint.js`; `scripts/png.js` is the PNG
decoder and `vendor/jpeg-js` the JPEG decoder.

## 1. Decode and normalise

The file is sniffed by magic bytes (JPEG `FF D8`, PNG signature). Anything else is
refused with a message pointing at `scripts/convert.py`. Transparency is composited
onto white, since the player's paper is white.

The image is area-averaged down to the analysis grid (`--width`, default 640). This is
the single most important number: every stroke's position, colour and length comes
from this grid, and the SVG `viewBox` is exactly this size. Strokes are drawn in grid
units, so the page stays crisp at any zoom.

## 2. Measurements the brushwork is built from

| Map | How it is made | Used for |
| --- | --- | --- |
| `L` | Rec.709 luminance | tone, contour ink |
| `S`, `V` | HSV saturation/value | region-based stroke length |
| `gx`, `gy` | Sobel on `L` | edges, direction field |
| `D` | box blur (r=2) of gradient magnitude | "how much detail lives here" — the master control |
| structure tensor | box blur (r=3) of `gx²`, `gy²`, `gx·gy` | coherence + along-edge angle |
| flow field | box blur (r=12) of `gx`, `gy` | a believable stroke grain in flat areas |
| skin mask | warm-light colour test, hole fill, speck removal | portrait detection, focus mask, layer naming |

`D` is turned into percentiles (50/65/72/88/90/93/99) and those percentiles are the
thresholds for the layers. That is why the same code adapts to a dark nebula and a
pale beach without per-image tuning.

## 3. Stroke direction

For each pixel: if local coherence is high and `D` says there is a real edge, strokes
run **along** the edge (`edgeA`); otherwise they follow the smoothed flow field; in
truly flat regions a pair of low-frequency sine terms gives a gentle diagonal grain.
The result is the "brush follows the form" look; without the flow field, flat skies
fill with random scribbles.

`walk()` then walks the direction field forwards and backwards from a seed point,
which is why strokes curve instead of being straight segments. Points are dropped
where direction changes by less than ~0.18 rad, keeping the path data small —
roughly 0.1 KB per stroke.

## 4. Layers

| Layer | Spacing / width | Gate | Count driver |
| --- | --- | --- | --- |
| L0 大色块铺底 | 16 px grid, 24 px wide, 30–44 px long | every cell | image area |
| L1 中间调塑形 | 10 px grid, 8.5 px wide | `D > P65` | mid detail |
| L2 细部肌理 | 6 px grid, 4.2 px wide | `D > P88` | fine detail |
| L3 线稿轮廓 | traced arms up to 40 px | seed `D > P93`, keep `D > P88` | edge length |
| L4 focus | 2.6 px then 2.2 px grid, 2.9/1.7 px wide | focus mask, second pass `D > P72` | focus area |
| L5 高光星点 | one dot per bright component | `L > 0.52` under `blur(L,4) < 0.32` | specular hits |

L0–L2 are "painterly grids": jittered seed points, length modulated per tone×saturation
region so flat areas get longer strokes and busy areas get shorter ones.

L3 traces the ridges of `D`: it walks both ways along the local edge angle while the
contrast stays above `P88`, then takes its colour from the darker side of the ridge,
which is what gives believable ink lines rather than outlined halos.

L4 is the detail layer. Its mask is `skin ∪ (D > P95)`; on a portrait the skin part
dominates, otherwise it is detail-led. Because it is the densest layer, its stroke
count is capped (`L4_CAP = 18000`): if the design spacing would exceed that, the
spacing is coarsened by `sqrt(count/cap)` instead of dropping coverage. Dropping
coverage is what makes faces look smudged.

## 5. Timeline

Strokes are ordered layer by layer, then in a serpentine sweep: rows of 96 px, left to
right on even rows, right to left on odd ones. Each stroke's duration comes from
`length / LAYER_SPEED[layer]` (fast broad strokes, slow detail), then all durations are
scaled so the sum matches `--seconds`. A floor of 1.5 ms keeps individual strokes
visible; the scale factor is re-solved after the floor so the total does not inflate.

Times are stored in integer 0.1 ms ticks, so `start[i] === start[i-1] + dur[i-1]` holds
exactly and the timeline is strictly serial by construction. The player relies on this:
it binary-searches for the current stroke and only ever animates the one in progress,
which is why 20 k paths still scrub smoothly.

## 6. Player

`templates/player.html` is a template with four tokens — `__PACKET__`, `__ORIGINAL__`,
`__BRAND__`, `__SUB__` — substituted by simple string replace (not `.replace`, which
would only hit the first occurrence of a token that appears twice). Each path gets
`pathLength=1`, `stroke-dasharray=1` and an animated `stroke-dashoffset`, so a stroke
"grows" from its start point without any per-frame path rebuilding.

The brush log is a virtualised window (40 lines back, 8 ahead) rendered as
`brush(#colour, width, opacity, 'M…')`; it is decoration that happens to be a true log.

## Knobs, and what they actually change

| Want | Change |
| --- | --- |
| More detail everywhere | `--width 820` (rises with the square of the width — watch the stroke count) |
| Calmer, more impressionistic | `--layers 3`, `--seconds 45` |
| Slower, more meditative | `--seconds 180` |
| Fewer strokes, smaller file | `--preset quick`, or `--width 520` |
| Crisper faces | raise `--width`, not `--layers`; the focus layer scales with the grid |
| Looser brushwork | in `paint.js`, raise the L0/L1 `lenMax` values |
| Longer, more calligraphic contours | raise the `40` iteration cap in the L3 block |
| Different paper colour | `body{--bg}` and the `<rect fill>` in `templates/player.html` |
| Different wordmark/fonts | `--title`, `--sub`, then `.brand` CSS in the template |

## Failure modes worth knowing

- **Everything at 1.5 ms** — the image has more strokes than `--seconds` can show
  comfortably; the log says so. Fewer layers, smaller width, or a longer `--seconds`.
- **Washed-out result** — a pale, low-contrast source leaves `D` small, so L2/L3
  thresholds collapse toward zero and coverage becomes noise. `--width` up and
  `--layers 3` usually reads better than fighting it.
- **"Skin" that is not skin** — pale warm anime backgrounds trigger the skin mask.
  That is why the mask only drives the focus layer and the layer *name*, never the
  palette; `--names` can override the label.
- **Interlaced (Adam7) PNG** — rejected explicitly; re-save without interlacing.
