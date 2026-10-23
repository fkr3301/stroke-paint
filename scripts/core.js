'use strict';
/*
 * stroke-paint core — the whole painting pipeline, platform-free.
 *
 * Input : an RGBA buffer (any size) + a few options.
 * Output: the stroke packet that the player consumes.
 *
 * No Node APIs, no DOM: scripts/paint.js runs it under Node, studio.html inlines it
 * in the browser, so both produce byte-identical strokes for the same pixels.
 */

// area-average downscale of an RGBA buffer
function resizeRGBA(src, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh * 4);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.min(sh, Math.floor((y + 1) * sy)));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.min(sw, Math.floor((x + 1) * sx)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        const rowBase = yy * sw * 4;
        for (let xx = x0; xx < x1; xx++) {
          const i = rowBase + xx * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
        }
      }
      const o = (y * dw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return out;
}

const LAYER_SPEED = [1500, 1200, 1000, 850, 650, 2000]; // px per second, per layer

/**
 * paintCore({ rgba, srcW, srcH, width, layers, seconds, names, log })
 *   rgba    Uint8Array RGBA at srcW x srcH
 *   width   analysis width in px (the source is never upscaled)
 *   layers  highest layer to build, 0..5
 *   seconds target timeline length at 1x
 *   names   optional "a|b|c|d|e|f"
 *   log     optional (msg) => void
 * returns { packet, meta, counts, skinFrac, focusFrac, skinPrimary }
 */
function paintCore(opts) {
  const say = typeof opts.log === 'function' ? opts.log : () => {};
  const rgba = opts.rgba;
  const SW = opts.srcW, SH = opts.srcH;
  const MAXL = Math.max(0, Math.min(5, opts.layers == null ? 5 : opts.layers));
  const seconds = opts.seconds > 0 ? opts.seconds : 100;

  const AW = Math.max(16, Math.min(opts.width || 640, SW));
  const W = AW, H = Math.max(2, Math.round(SH * (AW / SW)));
  const N = W * H;
  if (N > 4.2e6) throw new Error(`analysis grid too large (${W}x${H}), lower the width`);

  // ---- flat RGB at analysis size, alpha flattened onto white paper ----
  const px = resizeRGBA(rgba, SW, SH, W, H);
  const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const k = px[i * 4 + 3] / 255;
    R[i] = (px[i * 4] * k + 255 * (1 - k)) / 255;
    G[i] = (px[i * 4 + 1] * k + 255 * (1 - k)) / 255;
    B[i] = (px[i * 4 + 2] * k + 255 * (1 - k)) / 255;
  }

  // ---- colour spaces ----
  const L = new Float32Array(N), S = new Float32Array(N), V = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    L[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
    const mx = Math.max(R[i], G[i], B[i]), mn = Math.min(R[i], G[i], B[i]);
    V[i] = mx; S[i] = mx > 1e-6 ? (mx - mn) / mx : 0;
  }

  // ---- separable box blur ----
  function box(src, r) {
    const t = new Float32Array(N), o = new Float32Array(N);
    for (let y = 0; y < H; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[y * W + Math.min(W - 1, Math.max(0, x))];
      for (let x = 0; x < W; x++) {
        o[y * W + x] = acc / (2 * r + 1);
        acc += src[y * W + Math.min(W - 1, x + r + 1)] - src[y * W + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += o[Math.min(H - 1, Math.max(0, y)) * W + x];
      for (let y = 0; y < H; y++) {
        t[y * W + x] = acc / (2 * r + 1);
        acc += o[Math.min(H - 1, y + r + 1) * W + x] - o[Math.max(0, y - r) * W + x];
      }
    }
    return t;
  }

  // ---- gradients / local contrast ----
  const gx = new Float32Array(N), gy = new Float32Array(N);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    gx[i] = (L[i - W + 1] + 2 * L[i + 1] + L[i + W + 1]) - (L[i - W - 1] + 2 * L[i - 1] + L[i + W - 1]);
    gy[i] = (L[i + W - 1] + 2 * L[i + W] + L[i + W + 1]) - (L[i - W - 1] + 2 * L[i - W] + L[i - W + 1]);
  }
  const mag = new Float32Array(N);
  for (let i = 0; i < N; i++) mag[i] = Math.hypot(gx[i], gy[i]);
  const D = box(mag, 2); // smoothed local contrast = "how much detail lives here"

  // ---- structure tensor -> stroke direction (along edges) ----
  const Jxx = box(Float32Array.from(gx, v => v * v), 3);
  const Jyy = box(Float32Array.from(gy, v => v * v), 3);
  const Jxy = box(Float32Array.from(gx, (v, i) => v * gy[i]), 3);
  const coh = new Float32Array(N), edgeA = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const tr = (Jxx[i] + Jyy[i]) / 2, dd = Math.hypot((Jxx[i] - Jyy[i]) / 2, Jxy[i]);
    const l1 = tr + dd, l2 = Math.max(0, tr - dd);
    coh[i] = l1 / (l1 + l2 + 1e-7);
    edgeA[i] = 0.5 * Math.atan2(2 * Jxy[i], Jxx[i] - Jyy[i]) + Math.PI / 2; // along-edge
  }
  // smooth flow field so flat regions still get a believable stroke grain
  const fgx = box(gx, 12), fgy = box(gy, 12);
  let dirx = new Float32Array(N), diry = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const fm = Math.hypot(fgx[i], fgy[i]);
    let a;
    if (coh[i] > 0.3 && D[i] > 0.02) a = edgeA[i];
    else if (fm > 0.004) a = Math.atan2(fgy[i], fgx[i]) + Math.PI / 2;
    else a = -0.6 + 0.25 * Math.sin((i % W) * 0.011) + 0.2 * Math.sin(Math.floor(i / W) * 0.013);
    dirx[i] = Math.cos(a); diry[i] = Math.sin(a);
  }
  dirx = box(dirx, 2); diry = box(diry, 2);
  function dirAt(x, y) {
    const xi = Math.min(W - 1, Math.max(0, Math.round(x))), yi = Math.min(H - 1, Math.max(0, Math.round(y)));
    return Math.atan2(diry[yi * W + xi], dirx[yi * W + xi]);
  }

  // ---- tone x saturation cells -> stroke length modulation ----
  const regionLen = new Float32Array(12);
  {
    const sum = new Float32Array(12), cnt = new Float32Array(12);
    for (let i = 0; i < N; i++) {
      const lab = Math.min(3, (L[i] * 4) | 0) * 3 + Math.min(2, (S[i] * 3) | 0);
      sum[lab] += D[i]; cnt[lab]++;
    }
    const mean = Array.from(sum, (s, i) => (cnt[i] ? s / cnt[i] : 0));
    const avg = mean.reduce((a, b) => a + b, 0) / 12;
    for (let i = 0; i < 12; i++) regionLen[i] = mean[i] < avg * 0.6 ? 1.25 : mean[i] > avg * 1.4 ? 0.8 : 1.0;
  }
  function regionScale(x, y) {
    const i = (y | 0) * W + (x | 0);
    return regionLen[Math.min(3, (L[i] * 4) | 0) * 3 + Math.min(2, (S[i] * 3) | 0)];
  }

  // ---- detail percentiles ----
  const sorted = Float64Array.from(D).sort();
  const pct = p => sorted[Math.min(N - 1, Math.max(0, (p * N) | 0))];
  const P = { 50: pct(0.5), 65: pct(0.65), 72: pct(0.72), 88: pct(0.88), 90: pct(0.90), 93: pct(0.93), 99: pct(0.99) };
  if (P[99] < 0.004) say('warning: the picture is almost flat (no local contrast) — the strokes will look like plain colour fills.');

  // ---- sampling helpers ----
  const sampleRGB = (x, y) => {
    const i = Math.min(H - 1, Math.max(0, y | 0)) * W + Math.min(W - 1, Math.max(0, x | 0));
    return [R[i], G[i], B[i]];
  };
  function discRGB(x, y, r) {
    let r0 = 0, g0 = 0, b0 = 0, n = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const c = sampleRGB(x + dx, y + dy); r0 += c[0]; g0 += c[1]; b0 += c[2]; n++;
    }
    return [r0 / n, g0 / n, b0 / n];
  }
  function pathRGB(pts) {
    let r0 = 0, g0 = 0, b0 = 0;
    for (const p of pts) { const c = sampleRGB(p[0], p[1]); r0 += c[0]; g0 += c[1]; b0 += c[2]; }
    return [r0 / pts.length, g0 / pts.length, b0 / pts.length];
  }
  const hex = c => '#' + c.map(v => Math.round(Math.min(255, Math.max(0, v * 255))).toString(16).padStart(2, '0')).join('');

  // ---- walking strokes along the direction field ----
  function walk(x, y, len, ds = 3) {
    const pts = [], back = [];
    let cx = x, cy = y;
    for (let s = 0; s < len / 2; s += ds) {
      const a = dirAt(cx, cy); cx -= Math.cos(a) * ds; cy -= Math.sin(a) * ds;
      if (cx < 1 || cy < 1 || cx > W - 2 || cy > H - 2) break;
      back.push([cx, cy]);
    }
    for (let i = back.length - 1; i >= 0; i--) pts.push(back[i]);
    pts.push([x, y]);
    cx = x; cy = y;
    for (let s = 0; s < len / 2; s += ds) {
      const a = dirAt(cx, cy); cx += Math.cos(a) * ds; cy += Math.sin(a) * ds;
      if (cx < 1 || cy < 1 || cx > W - 2 || cy > H - 2) break;
      pts.push([cx, cy]);
    }
    return pts;
  }
  function toPath(pts) {
    const keep = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = keep[keep.length - 1], b = pts[i], c = pts[i + 1];
      const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]), a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
      let da = Math.abs(a1 - a2); if (da > Math.PI) da = 2 * Math.PI - da;
      if (da > 0.18) keep.push(b);
    }
    keep.push(pts[pts.length - 1]);
    const f = v => Math.round(v * 10) / 10;
    return 'M' + keep.map(p => f(p[0]) + ' ' + f(p[1])).join('L');
  }
  function polyLen(pts) {
    let l = 0;
    for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return Math.max(1, l);
  }

  const layers = [[], [], [], [], [], []];
  const rnd = (a => () => (a = (a * 1664525 + 1013904223) >>> 0) / 4294967296)(42);

  // ---- L0..L2: painterly grids, coarse to fine ----
  function painterLayer(li, step, width, lenMin, lenMax, thr, cr) {
    const out = layers[li];
    for (let gy0 = step / 2; gy0 < H; gy0 += step) {
      for (let gx0 = step / 2; gx0 < W; gx0 += step) {
        const x = gx0 + (rnd() - 0.5) * step * 0.7, y = gy0 + (rnd() - 0.5) * step * 0.7;
        const xi = x | 0, yi = y | 0;
        if (xi < 1 || yi < 1 || xi >= W - 1 || yi >= H - 1) continue;
        if (D[yi * W + xi] < thr) continue;
        const rs = regionScale(xi, yi);
        const len = (lenMin + rnd() * (lenMax - lenMin)) * rs;
        const pts = walk(x, y, len);
        if (pts.length < 2) continue;
        const col = li === 0 ? discRGB(x, y, cr) : pathRGB(pts);
        out.push({ d: toPath(pts), c: hex(col), w: width * (0.85 + rnd() * 0.3), o: 1, len: polyLen(pts), x, y });
      }
    }
  }
  painterLayer(0, 16, 24, 30, 44, 0, 7);
  painterLayer(1, 10, 8.5, 11, 18, P[65], 4);
  painterLayer(2, 6, 4.2, 6, 12, P[88], 2.5);

  // ---- L3: contour lines traced along ridges of local contrast ----
  {
    const vis = new Uint8Array(N);
    const out = layers[3];
    const tSeed = P[93], tKeep = P[88];
    for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
      const i = y * W + x;
      if (vis[i] || D[i] < tSeed) continue;
      const pts = [];
      for (const sgn of [-1, 1]) {
        let cx = x, cy = y; const arm = [];
        for (let s = 0; s < 40; s += 1.5) {
          const ci = (cy | 0) * W + (cx | 0);
          if (D[ci] < tKeep) break;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            vis[Math.min(N - 1, Math.max(0, ci + dy * W + dx))] = 1;
          }
          const a = edgeA[ci];
          cx += Math.cos(a) * 1.5 * sgn; cy += Math.sin(a) * 1.5 * sgn;
          if (cx < 2 || cy < 2 || cx > W - 3 || cy > H - 3) break;
          arm.push([cx, cy]);
        }
        if (sgn === -1) { arm.reverse(); pts.push(...arm); } else pts.push(...arm);
      }
      if (polyLen(pts) < 7) continue;
      // sample the darker side of the ridge -> ink colour
      const cols = [];
      for (const p of pts) {
        const i2 = (p[1] | 0) * W + (p[0] | 0);
        const a = edgeA[i2] + Math.PI / 2, nx = Math.cos(a) * 1.4, ny = Math.sin(a) * 1.4;
        const c1 = sampleRGB(p[0] + nx, p[1] + ny), c2 = sampleRGB(p[0] - nx, p[1] - ny);
        const l1 = 0.2126 * c1[0] + 0.7152 * c1[1] + 0.0722 * c1[2];
        const l2 = 0.2126 * c2[0] + 0.7152 * c2[1] + 0.0722 * c2[2];
        cols.push(l1 < l2 ? c1 : c2);
      }
      const col = cols.reduce((a, c) => [a[0] + c[0] / cols.length, a[1] + c[1] / cols.length, a[2] + c[2] / cols.length], [0, 0, 0]);
      const w = 1.2 + Math.min(1.6, (D[i] - tSeed) / Math.max(1e-6, P[99] - tSeed) * 1.6);
      out.push({ d: toPath(pts), c: hex(col), w, o: 0.95, len: polyLen(pts), x, y });
    }
  }

  // ---- skin mask (portrait detection) ----
  function binBlur(m, r, thr) {
    const f = box(Float32Array.from(m), r), o = new Uint8Array(N);
    for (let i = 0; i < N; i++) o[i] = f[i] > thr ? 1 : 0;
    return o;
  }
  let skin = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    skin[i] = (R[i] > 0.5 && (R[i] - G[i]) > 0.05 && (R[i] - B[i]) > 0.04 && S[i] > 0.06 && S[i] < 0.5 && V[i] > 0.5) ? 1 : 0;
  }
  skin = binBlur(skin, 2, 0.35);
  skin = binBlur(skin, 2, 0.5);
  { // fill holes: flood the background in from the border
    const bg = new Uint8Array(N), st = [];
    for (let x = 0; x < W; x++) { if (!skin[x]) { bg[x] = 1; st.push(x); } const i = (H - 1) * W + x; if (!skin[i]) { bg[i] = 1; st.push(i); } }
    for (let y = 0; y < H; y++) {
      const a = y * W, b = y * W + W - 1;
      if (!skin[a]) { bg[a] = 1; st.push(a); }
      if (!skin[b]) { bg[b] = 1; st.push(b); }
    }
    while (st.length) {
      const i = st.pop(), x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (!skin[j] && !bg[j]) { bg[j] = 1; st.push(j); }
      }
    }
    for (let i = 0; i < N; i++) if (!skin[i] && !bg[i]) skin[i] = 1;
  }
  { // drop specks smaller than 150px, then soften edges
    const seen = new Uint8Array(N);
    for (let s = 0; s < N; s++) {
      if (!skin[s] || seen[s]) continue;
      const comp = [s]; seen[s] = 1;
      for (let k = 0; k < comp.length; k++) {
        const i = comp[k], x = i % W, y = (i / W) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (skin[j] && !seen[j]) { seen[j] = 1; comp.push(j); }
        }
      }
      if (comp.length < 150) for (const i of comp) skin[i] = 0;
    }
    skin = binBlur(skin, 2, 0.25);
  }
  const skinCount = skin.reduce((a, b) => a + b, 0);
  const skinFrac = skinCount / N;

  // ---- focus mask: faces/hands when present, plus the busiest detail areas ----
  // A portrait's focal area is the skin mask; for everything else it is where the
  // detail actually lives. The layer's stroke count is bounded separately (see
  // L4_CAP below), so this mask can afford to be generous.
  const skinPrimary = skinFrac > 0.004 && skinFrac <= 0.08;
  let focus = new Uint8Array(N), focusFrac = 0;
  {
    const thr = pct(0.95);
    let c = 0;
    for (let i = 0; i < N; i++) {
      const v = skin[i] || D[i] > thr ? 1 : 0;
      focus[i] = v; c += v;
    }
    focusFrac = c / N;
  }
  focus = binBlur(focus, 1, 0.3);

  // ---- L4: dense short strokes over the focus mask ----
  // 2.6px / 2.2px spacing is the design density that makes eyes and edges crisp.
  // If that density would produce an unwieldy page, coarsen the spacing instead of
  // dropping coverage (dropping it just makes faces look smudged).
  const L4_CAP = 18000;
  function buildFocusStrokes(sCoarse, sFine) {
    const out = [];
    for (let gy0 = sCoarse * 0.6; gy0 < H; gy0 += sCoarse) {
      for (let gx0 = sCoarse * 0.6; gx0 < W; gx0 += sCoarse) {
        const x = gx0 + (rnd() - 0.5) * 2, y = gy0 + (rnd() - 0.5) * 2;
        const xi = x | 0, yi = y | 0;
        if (xi < 1 || yi < 1 || xi >= W - 1 || yi >= H - 1 || !focus[yi * W + xi]) continue;
        const pts = walk(x, y, 4 + rnd() * 3, 2);
        if (pts.length < 2) continue;
        out.push({ d: toPath(pts), c: hex(pathRGB(pts)), w: 2.9 * (0.85 + rnd() * 0.3), o: 1, len: polyLen(pts), x, y });
      }
    }
    for (let gy0 = sFine * 0.45; gy0 < H; gy0 += sFine) {
      for (let gx0 = sFine * 0.45; gx0 < W; gx0 += sFine) {
        const x = gx0 + (rnd() - 0.5) * 1.5, y = gy0 + (rnd() - 0.5) * 1.5;
        const xi = x | 0, yi = y | 0;
        if (xi < 1 || yi < 1 || xi >= W - 1 || yi >= H - 1 || !focus[yi * W + xi]) continue;
        if (D[yi * W + xi] < P[72]) continue; // second pass only on real edges
        const pts = walk(x, y, 3 + rnd() * 2, 1.5);
        if (pts.length < 2) continue;
        out.push({ d: toPath(pts), c: hex(pathRGB(pts)), w: 1.7, o: 1, len: polyLen(pts), x, y });
      }
    }
    return out;
  }
  {
    let sCoarse = 2.6, sFine = 2.2;
    let l4 = buildFocusStrokes(sCoarse, sFine);
    if (l4.length > L4_CAP) {
      const f = Math.sqrt(l4.length / L4_CAP);
      sCoarse *= f; sFine *= f;
      say(`focus layer would be ${l4.length} strokes — coarsening spacing to ${sCoarse.toFixed(1)}px`);
      l4 = buildFocusStrokes(sCoarse, sFine);
    }
    layers[4] = l4;
  }

  // ---- L5: specular points / stars ----
  {
    const out = layers[5];
    const cand = new Uint8Array(N);
    const Lm = box(L, 4);
    for (let i = 0; i < N; i++) if (L[i] > 0.52 && Lm[i] < 0.32) cand[i] = 1;
    const seen = new Uint8Array(N);
    for (let s = 0; s < N; s++) {
      if (!cand[s] || seen[s]) continue;
      const comp = [s]; seen[s] = 1;
      for (let k = 0; k < comp.length; k++) {
        const i = comp[k], x = i % W, y = (i / W) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (cand[j] && !seen[j]) { seen[j] = 1; comp.push(j); }
        }
      }
      let cx = 0, cy = 0;
      for (const i of comp) { cx += i % W; cy += (i / W) | 0; }
      cx /= comp.length; cy /= comp.length;
      const a = rnd() * Math.PI;
      const pts = [[cx - Math.cos(a), cy - Math.sin(a)], [cx + Math.cos(a), cy + Math.sin(a)]];
      out.push({ d: toPath(pts), c: hex(discRGB(cx, cy, 1)), w: Math.min(3.5, 1.2 + comp.length * 0.35), o: 1, len: 2, x: cx, y: cy });
    }
  }
  say(`analysis · skin ${(skinFrac * 100).toFixed(1)}% · focus ${(focusFrac * 100).toFixed(1)}% (${skinPrimary ? 'face-led' : 'detail-led'})`);

  // ---- layer names ----
  const DEFAULT_NAMES = [
    'L0 大色块铺底', 'L1 中间调塑形', 'L2 细部肌理', 'L3 线稿轮廓',
    skinPrimary && skinFrac > 0.02 ? 'L4 五官与手' : 'L4 焦点密集笔', 'L5 高光星点',
  ];
  let names = DEFAULT_NAMES;
  if (opts.names) {
    const given = String(opts.names).split('|').map(s => s.trim());
    names = DEFAULT_NAMES.map((d, i) => {
      if (!given[i]) return d;
      return /^L\d/.test(given[i]) ? given[i] : 'L' + i + ' ' + given[i];
    });
  }

  // ---- order + strictly serial timeline ----
  const strokes = [];
  for (let li = 0; li <= MAXL; li++) {
    const arr = layers[li];
    arr.sort((a, b) => {
      const ba = (a.y / 96) | 0, bb = (b.y / 96) | 0;
      if (ba !== bb) return ba - bb;
      return ba % 2 ? b.x - a.x : a.x - b.x; // serpentine sweep, like a real brush hand
    });
    for (const s of arr) strokes.push({ ...s, li });
  }
  if (!strokes.length) throw new Error('no strokes were generated — is the image blank?');

  // Scale stroke durations to the requested length. A floor keeps single strokes
  // visible (a 0ms path reads as a jump), and the scale factor is re-solved so the
  // floors never inflate the total past the request.
  const base = s => Math.max(0.02, s.len / LAYER_SPEED[s.li]);
  const MIN_DUR = 0.0015;
  let raw = 0;
  for (const s of strokes) raw += base(s);
  let k = seconds / raw;
  for (let iter = 0; iter < 12; iter++) {
    let sum = 0;
    for (const s of strokes) sum += Math.max(MIN_DUR, base(s) * k);
    const nk = seconds / sum;
    if (Math.abs(nk - k) < 1e-7) break;
    k = nk;
  }
  let atFloor = 0;
  // integer ticks (0.1 ms) so the serial timeline carries no float drift
  const TICK = 1e4;
  let tick = 0;
  const data = strokes.map(s => {
    const dur = Math.max(MIN_DUR, base(s) * k);
    if (dur === MIN_DUR) atFloor++;
    const dt = Math.max(1, Math.round(dur * TICK));
    const rec = [s.d, s.c, +s.w.toFixed(2), s.o, tick / TICK, dt / TICK, s.li];
    tick += dt;
    return rec;
  });
  const TOTAL = tick / TICK;
  if (atFloor > data.length * 0.5) {
    say(`${atFloor} of ${data.length} strokes sit at the minimum visible length — fewer layers or a smaller width gives a calmer pace.`);
  }
  for (let i = 1; i < data.length; i++) {
    if (Math.abs(data[i][4] - (data[i - 1][4] + data[i - 1][5])) > 1e-9) throw new Error('timeline overlap at ' + i);
  }
  const counts = layers.slice(0, MAXL + 1).map(a => a.length);

  return {
    packet: { w: W, h: H, total: TOTAL, names, strokes: data },
    meta: {
      analysis: [W, H], strokes: data.length, seconds: TOTAL, layers: counts,
      names, maxLayer: MAXL, width: opts.width || 640,
    },
    counts, skinFrac, focusFrac, skinPrimary,
  };
}

if (typeof module === 'object' && module.exports) module.exports = { paintCore, resizeRGBA, LAYER_SPEED };
