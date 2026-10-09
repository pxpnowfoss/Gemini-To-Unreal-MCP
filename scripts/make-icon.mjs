/**
 * Generates build/icon.ico — the app, installer and shortcut icon.
 *
 * Written by hand rather than pulled from a dependency: the artwork is a few
 * geometric shapes, and an .ico is just a small header wrapped around PNGs, so
 * a generator is cheaper than another package in the tree. PNG encoding uses
 * node's own zlib.
 *
 *   npm run icon
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [256, 128, 64, 48, 32, 16];

// ---------------------------------------------------------------- drawing

const lerp = (a, b, t) => a + (b - a) * t;

/** Rounded-square mask with a little antialiasing at the edge. */
function roundedCoverage(x, y, size, radius) {
  const inset = 0;
  const lo = inset;
  const hi = size - inset;
  const cx = Math.min(Math.max(x, lo + radius), hi - radius);
  const cy = Math.min(Math.max(y, lo + radius), hi - radius);
  const d = Math.hypot(x - cx, y - cy);
  if (x < lo || x > hi || y < lo || y > hi) return 0;
  return Math.min(Math.max(radius - d + 0.5, 0), 1);
}

/** Signed distance to a thick arrow pointing right, in 0..1 space. */
function arrowAlpha(u, v, size) {
  const t = 0.085; // half-thickness of the strokes
  let a = 0;

  // Shaft
  if (u > 0.24 && u < 0.66 && Math.abs(v - 0.5) < t) a = 1;

  // Head: two diagonals meeting at the tip
  const tipX = 0.72;
  const tipY = 0.5;
  for (const dir of [-1, 1]) {
    // Parametric distance to the segment from (tipX,tipY) back to the barb.
    const bx = tipX - 0.2;
    const by = tipY + dir * 0.2;
    const dx = tipX - bx;
    const dy = tipY - by;
    const len2 = dx * dx + dy * dy;
    let s = ((u - bx) * dx + (v - by) * dy) / len2;
    s = Math.min(Math.max(s, 0), 1);
    const px = bx + s * dx;
    const py = by + s * dy;
    if (Math.hypot(u - px, v - py) < t) a = 1;
  }

  // Soften the edge relative to pixel size so small icons do not alias badly.
  if (a === 0) {
    const soft = 1 / size;
    if (u > 0.24 - soft && u < 0.66 + soft && Math.abs(v - 0.5) < t + soft) a = 0.4;
  }
  return a;
}

function renderRGBA(size) {
  const px = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;

      // Diagonal gradient, matching the mark used in the app header.
      const t = Math.min(Math.max((u + v) / 2, 0), 1);
      let r = lerp(0x3b, 0x7a, t);
      let g = lerp(0x6f, 0x4a, t);
      let b = lerp(0xd4, 0xd1, t);

      const arrow = arrowAlpha(u, v, size);
      if (arrow > 0) {
        r = lerp(r, 255, arrow);
        g = lerp(g, 255, arrow);
        b = lerp(b, 255, arrow);
      }

      const cover = roundedCoverage(x + 0.5, y + 0.5, size, radius);
      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(255 * cover);
    }
  }
  return px;
}

// ------------------------------------------------------------ PNG encoding

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 10..12 stay zero: deflate, no filter, no interlace

  // One filter byte (0 = none) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------ ICO container

function buildICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;

  images.forEach((img, i) => {
    const o = i * 16;
    dir[o] = img.size >= 256 ? 0 : img.size; // 0 means 256
    dir[o + 1] = img.size >= 256 ? 0 : img.size;
    dir[o + 2] = 0; // palette
    dir[o + 3] = 0; // reserved
    dir.writeUInt16LE(1, o + 4); // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32BE(0, o + 8);
    dir.writeUInt32LE(img.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += img.png.length;
  });

  return Buffer.concat([header, dir, ...images.map((i) => i.png)]);
}

// ---------------------------------------------------------------------- run

const images = SIZES.map((size) => ({ size, png: encodePNG(size, renderRGBA(size)) }));
const ico = buildICO(images);

mkdirSync(join(root, 'build'), { recursive: true });
const out = join(root, 'build', 'icon.ico');
writeFileSync(out, ico);

// A 256px PNG is handy for READMEs and non-Windows packaging.
writeFileSync(join(root, 'build', 'icon.png'), images[0].png);

console.log('wrote ' + out + '  (' + SIZES.join(', ') + 'px, ' + ico.length + ' bytes)');
