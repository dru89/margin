/**
 * Image logic, offline half (UIMG-5/6, lesson 8): source resolution,
 * PNG dimensions from bytes, display sizing (Docs renders raw pixel
 * size unless objectSize is set), and a minimal-PNG generator so
 * tests need no binary fixtures.
 *
 * Local-file staging (the temp-docx contentUri trick for Workspace
 * accounts that block public sharing) is the deferred live half.
 */
import { deflateSync } from 'node:zlib';
import { PAGE_WIDTH_PT } from './widths.ts';

export const MAX_IMAGE_HEIGHT_PT = 600;
const BASE_DPI = 96; // px → pt at 96dpi: 1px = 0.75pt

export type ImageSource =
  | { kind: 'uri'; uri: string }
  | { kind: 'file'; path: string }
  | null;

/** UIMG-5: URLs and data URIs pass through; relative paths resolve against the markdown file's directory. */
export function resolveImageSource(src: string, mdDir: string): ImageSource {
  if (/^https?:\/\//i.test(src) || src.startsWith('data:')) return { kind: 'uri', uri: src };
  if (src.startsWith('/')) return { kind: 'file', path: src };
  if (src.trim() === '') return null;
  const joined = `${mdDir.replace(/\/$/, '')}/${src}`;
  // Normalize ./ and ../ segments without touching the filesystem.
  const parts: string[] = [];
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return { kind: 'file', path: `/${parts.join('/')}` };
}

/** UIMG-6: width/height from PNG bytes (IHDR), null for non-PNG. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !SIG.every((b, i) => bytes[i] === b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Display size in points: px at BASE_DPI, clamped to page width and a
 * max height, preserving aspect ratio (lesson 8: a 2x-DPI export must
 * not render at double size — callers pass dpi 192 for @2x assets).
 */
export function displaySize(
  pxWidth: number,
  pxHeight: number,
  dpi: number = BASE_DPI,
): { widthPt: number; heightPt: number } {
  let w = (pxWidth * 72) / dpi;
  let h = (pxHeight * 72) / dpi;
  if (w > PAGE_WIDTH_PT) {
    h = (h * PAGE_WIDTH_PT) / w;
    w = PAGE_WIDTH_PT;
  }
  if (h > MAX_IMAGE_HEIGHT_PT) {
    w = (w * MAX_IMAGE_HEIGHT_PT) / h;
    h = MAX_IMAGE_HEIGHT_PT;
  }
  return { widthPt: Math.round(w), heightPt: Math.round(h) };
}

/* ——— minimal PNG generator (harness design: no binary fixtures) ——— */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A valid solid-gray PNG of the given dimensions. */
export function minimalPng(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  // 10..12: compression, filter, interlace = 0
  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) raw.fill(0x80, y * (width + 1) + 1, (y + 1) * (width + 1));
  const idat = new Uint8Array(deflateSync(raw));
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Staged, insertable image: a URI Google can fetch plus display size. */
export interface StagedImage {
  uri: string;
  widthPt?: number;
  heightPt?: number;
}

/**
 * Best-effort staging for URL sources: fetch bytes to measure so
 * objectSize can be set (Docs renders raw pixel size otherwise).
 * Unmeasurable images still insert, unsized. Local files return null
 * until the temp-docx staging lands.
 */
export async function stageImage(source: ImageSource): Promise<StagedImage | null> {
  if (!source) return null;
  if (source.kind === 'file') return null; // deferred: temp-docx staging
  const staged: StagedImage = { uri: source.uri };
  try {
    const res = await fetch(source.uri);
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      const dims = pngDimensions(bytes);
      if (dims) {
        const size = displaySize(dims.width, dims.height);
        staged.widthPt = size.widthPt;
        staged.heightPt = size.heightPt;
      }
    }
  } catch {
    /* Google fetches server-side regardless; size stays unset */
  }
  return staged;
}
