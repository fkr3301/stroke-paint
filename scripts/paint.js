#!/usr/bin/env node
'use strict';
/*
 * stroke-paint CLI — decode an image, run the core pipeline, write the player.
 *
 *   node scripts/paint.js <image> [options]
 *
 * The painting itself lives in scripts/core.js (shared with studio.html).
 * This file only does the Node-specific parts: file decoding, thumbnail
 * re-encoding, template substitution and writing the output files.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const jpeg = require(path.join(ROOT, 'vendor', 'jpeg-js'));
const { decodePNG, isPNG } = require(path.join(__dirname, 'png.js'));
const { paintCore, resizeRGBA } = require(path.join(__dirname, 'core.js'));

const PRESETS = {
  quick: { width: 440, layers: 3 },
  normal: { width: 640, layers: 5 },
  fine: { width: 820, layers: 5 },
};

// ---------------------------------------------------------------- arguments
function usage() {
  return `stroke-paint — 把任意图片变成一笔一笔画出来的过程动画（单文件 HTML）

用法:
  node scripts/paint.js <图片> [选项]

选项:
  --out DIR         输出目录（默认 ./stroke-paint-out）
  --preset NAME     quick | normal | fine（预设宽度与图层上限，默认 normal）
  --width N         分析宽度像素，越大越细腻也越慢（默认 640）
  --layers N        最高图层 0..5，越少越快（默认 5）
  --seconds N       1x 播放总时长秒数（默认 100）
  --title TEXT      播放器标题（默认 一笔一画）
  --sub TEXT        标题后的小字（默认 STROKE STUDY）
  --names "a|b|..." 自定义 6 个图层名，用 | 分隔
  --no-preview      不生成 preview.html
  --quiet           只输出结果路径
  -h, --help        显示本帮助

支持的输入: JPEG(.jpg/.jpeg) 与 PNG(.png，含透明通道)
其他格式请先用 scripts/convert.py 转成 PNG（需要 Pillow）。
想不装 Node 直接用，就在浏览器里打开 studio.html。`;
}

function parseArgs(argv) {
  const o = {
    image: null, out: 'stroke-paint-out', preset: 'normal', width: null, layers: null,
    seconds: 100, title: '一笔一画', sub: 'STROKE STUDY', names: null,
    preview: true, quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error('missing value for ' + a);
      return argv[++i];
    };
    switch (a) {
      case '-h': case '--help': console.log(usage()); process.exit(0); break;
      case '--out': o.out = next(); break;
      case '--preset': o.preset = next(); break;
      case '--width': o.width = parseInt(next(), 10); break;
      case '--layers': o.layers = parseInt(next(), 10); break;
      case '--seconds': o.seconds = parseFloat(next()); break;
      case '--title': o.title = next(); break;
      case '--sub': o.sub = next(); break;
      case '--names': o.names = next(); break;
      case '--no-preview': o.preview = false; break;
      case '--quiet': o.quiet = true; break;
      default:
        if (a.startsWith('--')) throw new Error('unknown option ' + a);
        if (o.image) throw new Error('multiple input images given');
        o.image = a;
    }
  }
  if (!o.image) throw new Error('no input image — run with --help');
  if (!PRESETS[o.preset]) throw new Error('unknown preset ' + o.preset + ' (quick|normal|fine)');
  const pre = PRESETS[o.preset];
  if (o.width == null) o.width = pre.width;
  if (o.layers == null) o.layers = pre.layers;
  o.layers = Math.max(0, Math.min(5, o.layers));
  o.width = Math.max(160, Math.min(1400, o.width));
  if (!(o.seconds > 0)) throw new Error('--seconds must be > 0');
  return o;
}

const log = (o, ...a) => { if (!o.quiet) console.log('[stroke-paint]', ...a); };

// ---------------------------------------------------------------- decoding
function decodeImage(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 4) throw new Error('file is too small to be an image');
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let img;
    try {
      img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 8192 });
    } catch (e) {
      throw new Error('JPEG decode failed (' + e.message + '). Try: python scripts/convert.py "' + file + '" out.png');
    }
    return { width: img.width, height: img.height, data: img.data, format: 'jpeg' };
  }
  if (isPNG(buf)) {
    const img = decodePNG(buf);
    return { width: img.width, height: img.height, data: img.data, format: 'png' };
  }
  const sig = buf.subarray(0, 12).toString('hex');
  throw new Error(
    'unsupported image format (magic ' + sig + '). Supported: JPEG, PNG.\n' +
    'Convert first, e.g.:  python "' + path.join(__dirname, 'convert.py') + '" "' + file + '" "' + file + '.png"'
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------------------------------------------------------- player html
function readTpl(name) {
  return fs.readFileSync(path.join(ROOT, 'templates', name), 'utf8');
}

// replaceAll via split/join: the same token appears in <title> and the header
function fill(tpl, map) {
  return Object.entries(map).reduce((s, [ky, v]) => s.split(ky).join(v), tpl);
}

function buildPlayerHtml(packet, img64, title, sub) {
  return fill(readTpl('player.html'), {
    '__PACKET__': JSON.stringify(packet),
    '__ORIGINAL__': 'data:image/jpeg;base64,' + img64,
    '__BRAND__': escapeHtml(title),
    '__SUB__': escapeHtml(sub),
  });
}

// ---------------------------------------------------------------- main
function paint(opts) {
  const t0 = Date.now();
  if (!fs.existsSync(opts.image)) throw new Error('no such file: ' + opts.image);
  const img = decodeImage(opts.image);

  let transparent = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 250) transparent++;
  const hasAlpha = transparent > img.width * img.height * 0.01;
  const SW = img.width, SH = img.height;
  if (SW < 240 || SH < 240) log(opts, `note: source is only ${SW}x${SH} — strokes will be chunky; 600px+ gives the painterly detail.`);
  log(opts, `${path.basename(opts.image)} ${SW}x${SH} (${img.format})` + (hasAlpha ? ' · alpha composited on white' : ''));

  const t1 = Date.now();
  const res = paintCore({
    rgba: img.data, srcW: SW, srcH: SH,
    width: opts.width, layers: opts.layers, seconds: opts.seconds, names: opts.names,
    log: msg => log(opts, msg),
  });
  const { packet, meta } = res;
  log(opts, `analysis ${Date.now() - t1}ms`);
  log(opts, 'layers ' + meta.layers.map((c, i) => meta.names[i].slice(3) + '=' + c).join(' · '));
  log(opts, `${meta.strokes} strokes · ${meta.seconds}s @1x`);

  // ---- output ----
  const outDir = path.resolve(opts.out);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'strokes.json'), JSON.stringify(packet));

  // small JPEG for the comparison card, so the HTML stays light with big sources
  const thumbH = Math.min(520, SH);
  const thumbW = Math.max(1, Math.round((SW * thumbH) / SH));
  const thumbRaw = resizeRGBA(img.data, SW, SH, thumbW, thumbH);
  const thumb = jpeg.encode({ data: thumbRaw, width: thumbW, height: thumbH }, 82);
  const img64 = Buffer.from(thumb.data).toString('base64');

  fs.writeFileSync(path.join(outDir, 'paint.html'), buildPlayerHtml(packet, img64, opts.title, opts.sub));

  if (opts.preview) {
    fs.writeFileSync(path.join(outDir, 'preview.html'), fill(readTpl('preview.html'), {
      '__PACKET__': JSON.stringify(packet),
      '__ORIGINAL__': 'data:image/jpeg;base64,' + img64,
      '__MAXLAYER__': String(meta.maxLayer),
    }));
  }

  const outMeta = {
    source: path.resolve(opts.image), sourceSize: [SW, SH], format: img.format,
    analysis: meta.analysis, strokes: meta.strokes, seconds: meta.seconds, layers: meta.layers,
    names: meta.names, preset: opts.preset, width: meta.width, maxLayer: meta.maxLayer,
    builtAt: new Date().toISOString(), ms: Date.now() - t0,
  };
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(outMeta, null, 2));

  return {
    outDir,
    files: {
      html: path.join(outDir, 'paint.html'),
      preview: path.join(outDir, 'preview.html'),
      json: path.join(outDir, 'strokes.json'),
      meta: path.join(outDir, 'meta.json'),
    },
    meta: outMeta,
  };
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const res = paint(opts);
    if (opts.quiet) console.log(res.files.html);
    else {
      const kb = Math.round(fs.statSync(res.files.html).size / 1024);
      console.log('[stroke-paint] wrote ' + path.relative(process.cwd(), res.files.html) + ' (' + kb + ' KB)');
      console.log('[stroke-paint] open it, or deep-link a frame: paint.html#t=52  ·  paint.html#layer=3');
      console.log('[stroke-paint] done in ' + res.meta.ms + 'ms');
    }
  } catch (e) {
    console.error('[stroke-paint] error: ' + e.message);
    process.exit(1);
  }
}

module.exports = { paint, parseArgs, buildPlayerHtml, fill, readTpl };
