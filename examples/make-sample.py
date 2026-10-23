#!/usr/bin/env python3
"""Generate examples/sample.jpg — a synthetic painterly landscape used by studio.html
as the "try the demo image" sample. Everything here is procedurally drawn, so the file
is original and safe to ship in the repo.

    python examples/make-sample.py
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

W, H = 1000, 640
OUT = Path(__file__).with_name("sample.jpg")
rng = np.random.default_rng(7)

# ---- sky: vertical gradient with a warm horizon ----
y = np.linspace(0, 1, H)[:, None]
sky_top = np.array([28, 38, 74], float)
sky_mid = np.array([124, 96, 132], float)
sky_low = np.array([240, 178, 132], float)
t = np.repeat(y, W, axis=1)
img = np.zeros((H, W, 3), float)
band1 = np.clip(t / 0.55, 0, 1)[..., None]
band2 = np.clip((t - 0.55) / 0.45, 0, 1)[..., None]
img = sky_top * (1 - band1) + sky_mid * band1
img = img * (1 - band2) + sky_low * band2

# ---- sun + glow ----
sun = Image.new("L", (W, H), 0)
d = ImageDraw.Draw(sun)
cx, cy, rad = W * 0.36, H * 0.26, 78
d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=255)
glow = sun.filter(ImageFilter.GaussianBlur(46))
sun_soft = sun.filter(ImageFilter.GaussianBlur(9))
g = np.asarray(glow, float)[..., None] / 255
s = np.asarray(sun_soft, float)[..., None] / 255
img = img * (1 - 0.80 * g) + np.array([255, 208, 140]) * 0.80 * g
img = img * (1 - s) + np.array([255, 246, 220]) * s

# ---- mountain ranges, far to near ----
ranges = [
    (0.42, (74, 74, 104), 0.55),
    (0.52, (52, 56, 84), 0.72),
    (0.62, (34, 38, 58), 0.88),
]
for (base, color, alpha) in ranges:
    mask = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(mask)
    pts = [(0.0, float(H))]
    x = -40.0
    while x < W + 60:
        h = base - 0.10 * np.sin(x * 0.004 + rng.uniform(-0.4, 0.4)) - rng.uniform(0, 0.06)
        pts.append((float(x), float(H * h)))
        x += float(rng.uniform(38, 90))
    pts.append((float(W + 60), float(H)))
    md.polygon(pts, fill=255)
    m = np.asarray(mask, float)[..., None] / 255 * alpha
    img = img * (1 - m) + np.array(color) * m

# ---- water: vertically smoothed mirror of the sky, plus a sun glitter path ----
water_y = int(H * 0.66)
refl = img[water_y:][::-1][: H - water_y]
k = 9  # calm water = a vertical average, not a per-pixel roll (that banded badly)
pad = np.pad(refl, ((k // 2, k // 2), (0, 0), (0, 0)), mode="edge")
sm = np.zeros_like(refl)
for i in range(k):
    sm += pad[i : i + refl.shape[0]]
sm /= k
fade = np.linspace(0.88, 0.42, H - water_y)[:, None, None]
img[water_y:] = sm * fade + np.array([24, 32, 48]) * (1 - fade)
# soft sun reflection column on the water (smooth, no hard ripple bars)
col = np.exp(-((np.arange(W) - cx) ** 2) / (2 * 130.0 ** 2))[None, :, None]
depthw = np.linspace(1.0, 0.2, H - water_y)[:, None, None]
img[water_y:] += np.array([78, 60, 36]) * col * depthw
img[water_y - 1 : water_y + 1] *= 0.55  # shoreline


# ---- dark foreground silhouette (bank + reeds) ----
fg = Image.new("L", (W, H), 0)
fd = ImageDraw.Draw(fg)
fd.polygon([(0, H), (0, H * 0.90), (W * 0.22, H * 0.93), (W * 0.46, H), (W, H), (W, H * 0.95), (W * 0.6, H * 0.97)], fill=255)
for _ in range(70):
    x = rng.uniform(0, W)
    top = rng.uniform(H * 0.80, H * 0.95)
    fd.line([(x, H), (x + rng.uniform(-14, 14), top)], fill=255, width=int(rng.uniform(1, 3)))
f = np.asarray(fg, float)[..., None] / 255
img = img * (1 - f) + np.array([16, 18, 26]) * f

# ---- grain + vignette ----
img += rng.normal(0, 4.6, img.shape)
vx = np.linspace(-1, 1, W)[None, :]
vy = np.linspace(-1, 1, H)[:, None]
vig = 1 - 0.22 * np.clip((vx ** 2 + vy ** 2) - 0.35, 0, None)
img *= vig[..., None]

img = np.clip(img, 0, 255).astype(np.uint8)
Image.fromarray(img).filter(ImageFilter.GaussianBlur(0.4)).save(OUT, "JPEG", quality=88, optimize=True)
print(f"{OUT}  {W}x{H}  {OUT.stat().st_size // 1024} KB")
