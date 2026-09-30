/**
 * Prepares desktop/dist:
 *   server.mjs  – the whole server bundled into one file (no node_modules needed at runtime)
 *   prompts/    – prompt templates
 *   web/        – built UI (run `pnpm --filter web build` first)
 * and generates build/icon.png if it's missing.
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { build } from 'esbuild';

const here = import.meta.dirname;
const root = path.resolve(here, '..');
const dist = path.join(here, 'dist');
const DISCS = [
  { cx: 0.39, cy: 0.5, r: 0.3, rgb: [0xd9, 0x77, 0x57], a: 1 },
  { cx: 0.61, cy: 0.5, r: 0.3, rgb: [0x10, 0xa3, 0x7f], a: 0.88 },
];
const SS = 4; // supersampling per axis

await rm(dist, { recursive: true, force: true });

await build({
  entryPoints: [path.join(root, 'server/src/app.ts')],
  outfile: path.join(dist, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Some deps still call require() internally.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'info',
});

await cp(path.join(root, 'server/src/prompts'), path.join(dist, 'prompts'), { recursive: true, filter: (src) => !src.endsWith('.ts') });

const webDist = path.join(root, 'web/dist');
if (!existsSync(path.join(webDist, 'index.html'))) throw new Error('web/dist is missing – run `pnpm --filter web build` first');
await cp(webDist, path.join(dist, 'web'), { recursive: true });

const icon = path.join(here, 'build/icon.png');
if (!existsSync(icon)) {
  await mkdir(path.dirname(icon), { recursive: true });
  await writeFile(icon, drawIcon(256));
  console.log('generated build/icon.png');
}
console.log('desktop/dist ready');

/** "Over" compositing of the discs at a point, bottom disc first. */
function sampleDiscs(px, py) {
  let cr = 0, cg = 0, cb = 0, ca = 0;
  for (const d of DISCS) {
    if ((px - d.cx) ** 2 + (py - d.cy) ** 2 > d.r ** 2) continue;
    const na = d.a + ca * (1 - d.a);
    cr = (d.rgb[0] * d.a + cr * ca * (1 - d.a)) / na;
    cg = (d.rgb[1] * d.a + cg * ca * (1 - d.a)) / na;
    cb = (d.rgb[2] * d.a + cb * ca * (1 - d.a)) / na;
    ca = na;
  }
  return [cr, cg, cb, ca];
}

/** Averages SS x SS samples inside one pixel; colour is alpha-weighted. */
function samplePixel(x, y, size) {
  let r = 0, g = 0, b = 0, a = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const [cr, cg, cb, ca] = sampleDiscs((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
      r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
    }
  }
  return [r, g, b, a];
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Two overlapping discs (Claude orange, Codex green), anti-aliased, as a PNG. */
function drawIcon(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = samplePixel(x, y, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
