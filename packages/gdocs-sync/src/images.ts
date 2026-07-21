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
import { withQuotaRetry } from './util.ts';

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

/* ——— local-file staging: the temp-docx contentUri trick (issue #18,
   lesson 8). insertInlineImage needs a URI Google's servers can fetch;
   on accounts that block public sharing, the workaround is: build a
   .docx containing ALL the push's local images, upload it with
   convert-to-Google-Doc (works under drive.file), read the temp doc's
   inlineObjects back to harvest each image's Google-internal
   contentUri (~30-minute validity — stage immediately before use),
   and delete the temp doc. ——— */

/** JPEG dimensions from bytes (SOF marker scan); null for non-JPEG. */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
    }
    at += 2 + view.getUint16(at + 2);
  }
  return null;
}

export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  return pngDimensions(bytes) ?? jpegDimensions(bytes);
}

/* Minimal stored-entry ZIP (no compression — images are already compressed). */
function zipStore(entries: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();
  const u16 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
  const cat = (...parts: Uint8Array[]) => {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let a = 0;
    for (const p of parts) { out.set(p, a); a += p.length; }
    return out;
  };
  for (const { name, bytes } of entries) {
    const nameBytes = enc.encode(name);
    const crc = crc32ForZip(bytes);
    const local = cat(
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(bytes.length), u32(bytes.length),
      u16(nameBytes.length), u16(0), nameBytes, bytes,
    );
    central.push(cat(
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(bytes.length), u32(bytes.length),
      u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes,
    ));
    chunks.push(local);
    offset += local.length;
  }
  const centralBytes = cat(...central);
  const end = cat(
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBytes.length), u32(offset), u16(0),
  );
  return cat(...chunks, centralBytes, end);
}

function crc32ForZip(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const OOXML_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** A .docx whose body is one inline image per paragraph, in order. */
export function buildImagesDocx(images: { bytes: Uint8Array; ext: 'png' | 'jpeg' }[]): Uint8Array {
  const EMU_PER_PX = 9525;
  const paragraphs = images
    .map((img, i) => {
      const dims = imageDimensions(img.bytes) ?? { width: 100, height: 100 };
      const cx = dims.width * EMU_PER_PX;
      const cy = dims.height * EMU_PER_PX;
      const id = i + 1;
      return (
        `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
        `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="img${id}"/>` +
        `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
        `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="img${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
        `<pic:blipFill><a:blip r:embed="rIdImg${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
        `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
        `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
      );
    })
    .join('');
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document ${OOXML_NS}><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`;
  const relsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    images
      .map(
        (img, i) =>
          `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/img${i + 1}.${img.ext}"/>`,
      )
      .join('') +
    `</Relationships>`;
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="png" ContentType="image/png"/>` +
    `<Default Extension="jpeg" ContentType="image/jpeg"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`;
  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;
  const enc = new TextEncoder();
  return zipStore([
    { name: '[Content_Types].xml', bytes: enc.encode(contentTypes) },
    { name: '_rels/.rels', bytes: enc.encode(rootRels) },
    { name: 'word/document.xml', bytes: enc.encode(documentXml) },
    { name: 'word/_rels/document.xml.rels', bytes: enc.encode(relsXml) },
    ...images.map((img, i) => ({ name: `word/media/img${i + 1}.${img.ext}`, bytes: img.bytes })),
  ]);
}

export type LocalImageStager = (paths: string[]) => Promise<Map<string, StagedImage>>;

/**
 * Batch-stage local files through ONE temp doc: read + measure, build
 * the docx, upload with convert, harvest contentUris in document
 * order, delete the temp doc.
 */
export function makeDocxStager(token: () => Promise<string>): LocalImageStager {
  return async (paths) => {
    const { readFile } = await import('node:fs/promises');
    const out = new Map<string, StagedImage>();
    const loaded: { path: string; bytes: Uint8Array; ext: 'png' | 'jpeg' }[] = [];
    for (const p of paths) {
      try {
        const bytes = new Uint8Array(await readFile(p));
        const ext = pngDimensions(bytes) ? 'png' : jpegDimensions(bytes) ? 'jpeg' : null;
        if (ext) loaded.push({ path: p, bytes, ext });
      } catch {
        /* missing file → stays unstaged (UIMG-4 degradation) */
      }
    }
    if (loaded.length === 0) return out;

    const t = await token();
    const docx = buildImagesDocx(loaded);
    const boundary = 'gdocs-sync-stage';
    const meta = JSON.stringify({ name: 'gdocs-sync image staging (temp)', mimeType: 'application/vnd.google-apps.document' });
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n`;
    const tail = `\r\n--${boundary}--`;
    const enc = new TextEncoder();
    const body = new Uint8Array(head.length + docx.length + tail.length);
    body.set(enc.encode(head), 0);
    body.set(docx, head.length);
    body.set(enc.encode(tail), head.length + docx.length);

    // Quota-aware like every other API path (the harness lesson: the
    // one unwrapped call is where the suite flakes as it grows).
    const { id } = await withQuotaRetry(async () => {
      const up = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
        {
          method: 'POST',
          headers: { authorization: `Bearer ${t}`, 'content-type': `multipart/related; boundary=${boundary}` },
          body,
        },
      );
      if (!up.ok) {
        const err = new Error(`image staging upload failed: ${up.status} ${await up.text()}`);
        (err as unknown as { status: number }).status = up.status;
        throw err;
      }
      return (await up.json()) as { id: string };
    });
    try {
      const doc = (await withQuotaRetry(async () => {
        const res = await fetch(`https://docs.googleapis.com/v1/documents/${id}`, {
          headers: { authorization: `Bearer ${t}` },
        });
        if (!res.ok) {
          const err = new Error(`staging read-back failed: ${res.status}`);
          (err as unknown as { status: number }).status = res.status;
          throw err;
        }
        return res.json();
      })) as {
        body?: { content?: { paragraph?: { elements?: { inlineObjectElement?: { inlineObjectId?: string } }[] } }[] };
        inlineObjects?: Record<string, { inlineObjectProperties?: { embeddedObject?: { imageProperties?: { contentUri?: string } } } }>;
      };
      // contentUris in document order = our insertion order.
      const ids: string[] = [];
      for (const el of doc.body?.content ?? []) {
        for (const pe of el.paragraph?.elements ?? []) {
          const oid = pe.inlineObjectElement?.inlineObjectId;
          if (oid) ids.push(oid);
        }
      }
      ids.forEach((oid, i) => {
        const item = loaded[i];
        const uri = doc.inlineObjects?.[oid]?.inlineObjectProperties?.embeddedObject?.imageProperties?.contentUri;
        if (!item || !uri) return;
        const dims = imageDimensions(item.bytes);
        const size = dims ? displaySize(dims.width, dims.height) : {};
        out.set(item.path, { uri, ...size });
      });
    } finally {
      await fetch(`https://www.googleapis.com/drive/v3/files/${id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${t}` },
      }).catch(() => {});
    }
    return out;
  };
}
