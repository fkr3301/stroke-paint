---
name: stroke-paint
description: Turn any picture into a stroke-by-stroke painting animation - one self-contained HTML player that replays the picture being painted brush by brush, with a scrubber, per-layer legend and a live brush log. Use when someone wants the "painting process" of an image (绘画过程 / 作画过程 / 一笔一画), a replay of how a picture is drawn, an SVG brush-stroke rendition of a photo or illustration, or a drawing-process animation to show/share.
license: MIT
---

# stroke-paint

Give it an image, get a self-contained HTML page that paints that image in front of
you, one brush at a time — thousands of SVG paths on a strictly serial timeline, plus
a brush log that scrolls like source code.

Everything runs locally: no network, no API key, no canvas, no headless browser needed
to build. A 640px-wide image takes about **2 seconds**. Deterministic: the same image
and options always produce the same painting.

**Zero install:** `studio.html` in the skill root is the whole pipeline compiled into
one page. Double-click it, drag a picture in, watch it paint, download the player. Point
the user at this when they want to do it themselves or have no Node. It is generated —
edit `scripts/studio.shell.html`, `scripts/core.js` or `templates/player.html`, then run
`node scripts/build-studio.js` to rebuild it.

## Run it

```bash
node "<skill>/scripts/paint.js" <image> --out <dir>
```

`<skill>` is this skill's directory (`~/.dsh/skills/stroke-paint`). Windows example:

```powershell
node "C:\Users\<you>\.dsh\skills\stroke-paint\scripts\paint.js" `
  "C:\path\to\photo.jpg" --out ".\paint\photo"
```

Then open `<dir>/paint.html`. Nothing else is required — the player embeds the stroke
data and a thumbnail of the original, so the one file can be copied, emailed or
uploaded on its own.

Do not hand-edit `paint.html`; change options and re-run instead. Style changes belong
in `templates/player.html`.

## Outputs

| File | What it is |
| --- | --- |
| `paint.html` | The deliverable. Single self-contained player (~0.5–2 MB). |
| `preview.html` | Original beside the painting with a button per layer, for judging a build. |
| `strokes.json` | `{w,h,total,names,strokes}`; each stroke is `[path, colour, width, opacity, start, duration, layer]`. |
| `meta.json` | Source, analysis grid, stroke/layer counts, timeline seconds, build time. |

Deep links into `paint.html` (handy for screenshots, docs and sharing a moment):

- `paint.html#t=52.4` — open paused at 52.4 s
- `paint.html#layer=3` — open at the frame where layer 3 finished
- `paint.html?play=1` — autoplay from the start

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `--out DIR` | `./stroke-paint-out` | Created if missing. |
| `--preset` | `normal` | `quick` (440px, 4 layers) · `normal` (640px, 6 layers) · `fine` (820px, 6 layers). |
| `--width N` | from preset | Analysis width. 640 is the sweet spot; 820+ for hair, lace, foliage. |
| `--layers N` | from preset | Highest layer, 0–5. `3` drops the detail + highlight layers and reads as a loose study. |
| `--seconds N` | `100` | Timeline length at 1×. 60 for short clips, 150+ for a slow meditative pace. |
| `--title TEXT` | `一笔一画` | Header wordmark. |
| `--sub TEXT` | `STROKE STUDY` | Monospace subtitle next to it. |
| `--names "a\|b\|c\|d\|e\|f"` | auto | Rename the six layers; missing entries keep their defaults. |
| `--no-preview` | off | Skip `preview.html`. |
| `--quiet` | off | Print only the `paint.html` path. |

Report back the stroke count, layer split, timeline seconds and file size from
`meta.json` — that is what tells the user how heavy the page is.

## Picking settings

- **Portraits / characters** — `normal` is designed for this. The skin mask drives a
  dense "face and hands" layer, so eyes, lashes, lips and fingers come out crisp.
- **Landscape, still life, product shots** — `normal`; focus becomes detail-led
  instead of face-led, putting the dense layer on edges, texture and highlights.
- **Line art, manga, UI, text-heavy images** — `--preset fine` and
  `--layers 5`; contours and short detail strokes do the work, big colour blocks stay
  sparse.
- **Loose / sketchy look** — `--layers 3`, `--seconds 45`.
- **Heavy pages** — anything past ~20 k strokes starts to feel sluggish to scrub and
  grows past 2 MB. `--width 520` or `--preset quick` brings it down.

Sources below ~600 px wide work but look blocky; upscaling the source first does not
add detail. Very high-contrast logos and flat vector art look best with `--layers 3`.

## Other image formats

JPEG and PNG (including transparency, palette, greyscale, 16-bit) are decoded
natively. For WebP, HEIC, TIFF, BMP, GIF or AVIF, convert first — the helper uses
Pillow, which the bundled DSH Python already has:

```bash
python "<skill>/scripts/convert.py" photo.webp photo.png
node "<skill>/scripts/paint.js" photo.png --out out/photo
```

AVIF, HEIC and animated GIFs often need extra Pillow plugins; if that import fails,
ask the user for a PNG or JPEG rather than trying to install codecs.

## Verify before handing over

Open the page or screenshot it, then look at the painting, not just the build log.
Edge or Chrome headless is enough (Windows path shown):

```powershell
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"   # or chrome.exe
& $edge --headless=new --disable-gpu --hide-scrollbars --window-size=1600,1000 `
  --user-data-dir="$env:TEMP\paint-shot" --virtual-time-budget=9000 `
  --screenshot="$PWD\shot.png" "file:///C:/path/to/paint.html#t=100"
```

Then read `shot.png` with the image tool. Check:

1. The painting is recognisable — the subject's silhouette, colours and key values read
   correctly at a glance.
2. Faces/eyes and the subject's edges are crisp, not smeared. Smearing means the focus
   layer is too sparse: raise `--width` or `--seconds`, not `--layers`.
3. The header shows the intended title (a literal `__BRAND__` means the template token
   was not substituted).
4. `#t=100` shows a complete painting, not a half-finished one.

Also screenshot `#layer=0` and `#layer=2` to confirm the first layers look like bold
underpainting rather than a washed-out blur. A reference render of what "good" looks
like is `examples/finished-sample.jpg` (9,693 strokes from `examples/sample.jpg`).

## How it works

Six brush layers, coarse to fine, each stroke coloured from the image itself and
oriented along local structure:

| Layer | Content |
| --- | --- |
| L0 | 24px broad strokes, big flat shapes |
| L1 | 8.5px mid-tone modelling |
| L2 | 4.2px texture |
| L3 | 1–2px contour lines traced along detail ridges |
| L4 | 2–3px dense short strokes over the focus mask (faces, eyes, edges) |
| L5 | specular dots and stars |

Strokes are ordered in a serpentine top-to-bottom sweep and laid on one strictly
serial timeline, so at any moment exactly one brush is moving. Details, knobs and
failure modes: [references/how-it-works.md](references/how-it-works.md).

## Troubleshooting

- **`unsupported image format`** — decode with `scripts/convert.py` first (see above).
- **`no strokes were generated`** — blank or single-colour image; nothing to paint.
- **`analysis grid too large`** — lower `--width`.
- **Painting too muddy** — the source is probably too pale/low-contrast, or a portrait
  was rendered with `--layers 3`. Try `--preset fine`.
- **Page feels heavy** — reduce `--width` or `--layers`; check `meta.json` stroke count.
- **Text in the painting is unreadable** — expected at 640 px; use `--width 1000` or a
  crop of the text area.
