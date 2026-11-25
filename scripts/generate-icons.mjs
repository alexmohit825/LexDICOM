import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const iconsDir = path.resolve(__dirname, '../public/icons');
fs.mkdirSync(iconsDir, { recursive: true });

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function generateIconPng(size) {
  // RGBA raw scanlines with filter byte 0 per row
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  const mid = size / 2;

  for (let y = 0; y < size; y++) {
    const rowOff = y * stride;
    raw[rowOff] = 0; // Filter type None
    for (let x = 0; x < size; x++) {
      const p = rowOff + 1 + x * 4;
      // Deep obsidian medical frame
      let r = 11, g = 15, b = 23;

      const borderDist = Math.min(x, y, size - 1 - x, size - 1 - y);
      if (borderDist < Math.max(4, Math.round(size * 0.04))) {
        r = 30; g = 58; b = 95;
      }

      // 2x2 RadiAnt viewport grid crosslines
      if (Math.abs(x - mid) <= Math.max(1, size * 0.008) || Math.abs(y - mid) <= Math.max(1, size * 0.008)) {
        r = 30; g = 58; b = 95;
      }

      // Stylized Sagittal Spine Lordotic Curve in Cyan (#38bdf8)
      const ny = (y - size * 0.18) / (size * 0.64);
      if (ny >= 0 && ny <= 1) {
        const curveX = size * 0.44 - Math.sin(ny * Math.PI * 1.6) * (size * 0.08);
        const dist = Math.abs(x - curveX);
        if (dist <= size * 0.045) {
          r = 56; g = 189; b = 248;
        }
      }

      // Gold Scout Reference Line (#facc15) across L4-L5
      if (Math.abs(y - size * 0.56) <= Math.max(2, size * 0.012) && x > size * 0.2 && x < size * 0.8) {
        if (Math.floor(x / Math.max(4, size * 0.03)) % 2 === 0) {
          r = 250; g = 204; b = 21;
        }
      }

      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // Bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const sz of [192, 512]) {
  const outPath = path.join(iconsDir, `icon-${sz}.png`);
  fs.writeFileSync(outPath, generateIconPng(sz));
  console.log(`[OK] Generated PWA icon: ${outPath}`);
}
