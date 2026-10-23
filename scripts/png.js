'use strict';
// Minimal dependency-free PNG decoder -> { width, height, data: Uint8Array(RGBA) }
// Supports: colour types 0/2/3/4/6, bit depths 1/2/4/8/16, non-interlaced, tRNS.
// Adam7 interlacing is rejected with a clear message (almost no photos use it).

const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPNG(buf) {
  return buf.length > 8 && buf.compare(SIG, 0, 8, 0, 8) === 0;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePNG(buf) {
  if (!isPNG(buf)) throw new Error('not a PNG (bad signature)');

  let pos = 8;
  let ihdr = null;
  let plte = null;
  let trns = null;
  const idat = [];

  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const start = pos + 8;
    const end = start + len;
    if (end > buf.length) throw new Error('truncated PNG chunk ' + type);
    if (type === 'IHDR') {
      ihdr = {
        w: buf.readUInt32BE(start),
        h: buf.readUInt32BE(start + 4),
        depth: buf[start + 8],
        color: buf[start + 9],
        interlace: buf[start + 12],
      };
    } else if (type === 'PLTE') {
      plte = buf.subarray(start, end);
    } else if (type === 'tRNS') {
      trns = buf.subarray(start, end);
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    pos = end + 4; // skip CRC
  }

  if (!ihdr) throw new Error('PNG has no IHDR');
  const { w, h, depth, color } = ihdr;
  const channels = CHANNELS[color];
  if (!channels) throw new Error('unsupported PNG colour type ' + color);
  if (ihdr.interlace !== 0) {
    throw new Error('interlaced (Adam7) PNG is not supported — re-save without interlacing');
  }
  if (color === 3 && !plte) throw new Error('palette PNG without PLTE');
  if (![1, 2, 4, 8, 16].includes(depth)) throw new Error('unsupported PNG bit depth ' + depth);
  if (color === 3 && depth === 16) throw new Error('invalid PNG palette bit depth 16');

  const raw = zlib.inflateSync(Buffer.concat(idat));

  const bpp = Math.max(1, Math.ceil((channels * depth) / 8)); // filter unit
  const rowBytes = Math.ceil((w * channels * depth) / 8);
  const need = rowBytes * h;
  if (raw.length < need) throw new Error('PNG pixel data truncated');

  const unfiltered = Buffer.alloc(need);
  const zero = Buffer.alloc(rowBytes);
  let p = 0;

  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const row = unfiltered.subarray(y * rowBytes, (y + 1) * rowBytes);
    raw.copy(row, 0, p, p + rowBytes);
    p += rowBytes;
    const prev = y > 0 ? unfiltered.subarray((y - 1) * rowBytes, y * rowBytes) : zero;

    switch (ft) {
      case 0:
        break;
      case 1:
        for (let i = bpp; i < rowBytes; i++) row[i] = (row[i] + row[i - bpp]) & 0xff;
        break;
      case 2:
        for (let i = 0; i < rowBytes; i++) row[i] = (row[i] + prev[i]) & 0xff;
        break;
      case 3:
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= bpp ? row[i - bpp] : 0;
          row[i] = (row[i] + ((a + prev[i]) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= bpp ? row[i - bpp] : 0;
          const c = i >= bpp ? prev[i - bpp] : 0;
          row[i] = (row[i] + paeth(a, prev[i], c)) & 0xff;
        }
        break;
      default:
        throw new Error('bad PNG filter type ' + ft + ' on row ' + y);
    }
  }

  // ---- expand samples to RGBA ----
  const data = new Uint8Array(w * h * 4);
  const maxv = (1 << depth) - 1;
  const sub = depth < 8 ? 8 / depth : 1; // samples packed per byte

  function sample(row, index) {
    if (depth === 8) return row[index];
    if (depth === 16) return row[index * 2]; // high byte = 8-bit value
    const byte = row[(index / sub) | 0];
    const shift = 8 - depth * ((index % sub) + 1);
    return (byte >> shift) & maxv;
  }
  const scale = depth < 8 ? 255 / maxv : 1;

  for (let y = 0; y < h; y++) {
    const row = unfiltered.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (color === 3) {
        const idx = depth === 8 ? row[x] : sample(row, x);
        const pi = idx * 3;
        if (pi + 2 >= plte.length) throw new Error('PNG palette index out of range');
        data[o] = plte[pi];
        data[o + 1] = plte[pi + 1];
        data[o + 2] = plte[pi + 2];
        data[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (color === 0 || color === 4) {
        const g = Math.round(sample(row, x * channels) * scale);
        data[o] = data[o + 1] = data[o + 2] = g;
        data[o + 3] = color === 4 ? sample(row, x * channels + 1) : 255;
      } else if (color === 2) {
        data[o] = sample(row, x * 3);
        data[o + 1] = sample(row, x * 3 + 1);
        data[o + 2] = sample(row, x * 3 + 2);
        data[o + 3] = 255;
      } else {
        data[o] = sample(row, x * 4);
        data[o + 1] = sample(row, x * 4 + 1);
        data[o + 2] = sample(row, x * 4 + 2);
        data[o + 3] = sample(row, x * 4 + 3);
      }
    }
  }

  return { width: w, height: h, data };
}

module.exports = { decodePNG, isPNG };
