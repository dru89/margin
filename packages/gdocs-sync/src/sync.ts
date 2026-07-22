/**
 * Orchestrator: markdown → live doc (create) and live doc ← markdown
 * (incremental update). Push diffs the doc read-back against the
 * markdown (lesson 5); regions rebuild via segmented batches; tables
 * are inserted empty, located by read-back, and filled cell-by-cell in
 * reverse order (index-shift safety). writeControl chains through
 * every write (lesson 13).
 */
import type { CanonicalBlock, InlineSpan } from './blocks.ts';
import { spanText } from './blocks.ts';
import { buildSegment, restyleListRequests, restyleRequests, restyleTableRequests } from './builder.ts';
import { BLOCK_GAP_PT, BODY, TABLE_STYLE, rgb, textStyleOf } from './styles.ts';
import { resolveImageSource, stageImage, type LocalImageStager, type StagedImage } from './images.ts';
import {
  buildMetaRequests,
  emitFrontmatter,
  hasMeta,
  mdToCanonicalWithMeta,
  metaEquals,
  parseDocMeta,
} from './meta.ts';
import { diffBlocks } from './differ.ts';
import type { DocsClient, GDocDocument, GDocRequest, GDocStructuralElement } from './gdoc.ts';
import { hasPendingSuggestions } from './gdoc.ts';
import { serializeBlocks } from './serialize.ts';
import { markdownToBlocks, splitFrontmatter, stripCommentsSection } from './markdown.ts';
import { MONO_FONT, docToBlocks } from './reader.ts';
import { planRegions } from './regions.ts';
import {
  columnWidthRequests,
  planColumnWidths,
  planDocumentWidths,
  shouldCenterColumn,
} from './widths.ts';

export function mdToCanonical(markdown: string): CanonicalBlock[] {
  const { body } = splitFrontmatter(stripCommentsSection(markdown));
  return markdownToBlocks(body);
}

async function revisionOf(client: DocsClient, docId: string): Promise<string | undefined> {
  return (await client.getDocument(docId)).revisionId;
}

function docEndIndex(doc: GDocDocument): number {
  const content = doc.body?.content ?? [];
  return content[content.length - 1]?.endIndex ?? 1;
}

/** The n-th table element (document order) in the body. */
function nthTable(doc: GDocDocument, n: number): GDocStructuralElement | null {
  let seen = 0;
  for (const el of doc.body?.content ?? []) {
    if (el.table) {
      if (seen === n) return el;
      seen++;
    }
  }
  return null;
}

/**
 * Insert `blocks` at `insertAt`. Splits at tables: text segments go
 * through buildSegment; each table is inserted empty, located by
 * read-back, filled in reverse cell order with explicit styles (SI-2).
 * Returns the number of write requests sent.
 */
interface ApplyOptions {
  tablesBefore: number;
  /** The final segment ends at the doc end (issue #24). */
  omitTrailingNewline?: boolean;
  /** Pre-planned (possibly pooled) widths for the tables in `blocks`, in order. */
  tableWidths?: number[][];
  /** Staged images by markdown src. */
  images?: Map<string, StagedImage | null>;
}

/** Stage every image block's source: URLs fetched-to-measure; local
 * files batched through the temp-docx stager when one is provided. */
async function stageImages(
  blocks: CanonicalBlock[],
  baseDir: string,
  stager?: LocalImageStager,
): Promise<Map<string, StagedImage | null>> {
  const images = new Map<string, StagedImage | null>();
  const localBySrc = new Map<string, string>(); // src → resolved path
  const srcs: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'image') srcs.push(block.src);
    // Inline-image spans (issue #23) in span-bearing blocks.
    const spanLists =
      block.kind === 'paragraph' || block.kind === 'heading' || block.kind === 'blockquote'
        ? [block.spans]
        : block.kind === 'list'
          ? block.items.map((i) => i.spans)
          : block.kind === 'table'
            ? block.rows.flat()
            : [];
    for (const spans of spanLists) {
      for (const sp of spans) if (sp.image) srcs.push(sp.image.src);
    }
  }
  for (const src of srcs) {
    if (images.has(src)) continue;
    const source = resolveImageSource(src, baseDir);
    if (source?.kind === 'file' && stager) {
      images.set(src, null); // placeholder until batch staging
      localBySrc.set(src, source.path);
    } else {
      images.set(src, await stageImage(source));
    }
  }
  if (stager && localBySrc.size > 0) {
    const staged = await stager([...new Set(localBySrc.values())]);
    for (const [src, path] of localBySrc) {
      images.set(src, staged.get(path) ?? null);
    }
  }
  return images;
}

async function applyBlocksAt(
  client: DocsClient,
  docId: string,
  blocks: CanonicalBlock[],
  insertAt: number,
  opts: ApplyOptions,
): Promise<number> {
  let written = 0;
  let cursor = insertAt;
  let tableOrdinal = opts.tablesBefore;
  let widthIdx = 0;
  let afterTable = false;
  let pending: CanonicalBlock[] = [];

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    // The paragraph after a table carries the table's bottom gap —
    // tables themselves can't hold spacing (style-review feedback).
    const segment = buildSegment(pending, cursor, {
      leadingSpaceAbovePt: afterTable ? BLOCK_GAP_PT : undefined,
      images: opts.images,
      omitTrailingNewline: opts.omitTrailingNewline && flushedFinal,
    });
    afterTable = false;
    const revision = await revisionOf(client, docId);
    await client.batchUpdate(docId, segment.requests, revision);
    written += segment.requests.length;
    cursor += segment.insertedLength;
    pending = [];
  };

  let flushedFinal = false;
  for (const block of blocks) {
    if (block.kind !== 'table') {
      pending.push(block);
      continue;
    }
    await flush();
    const rows = block.rows.length;
    const columns = block.rows[0]?.length ?? 1;
    const revision = await revisionOf(client, docId);
    await client.batchUpdate(
      docId,
      [{ insertTable: { rows, columns, location: { index: cursor } } }],
      revision,
    );
    written += 1;

    // Locate the just-inserted table and fill cells in reverse order.
    const doc = await client.getDocument(docId);
    const table = nthTable(doc, tableOrdinal);
    tableOrdinal++;
    if (!table?.table?.tableRows) throw new Error('inserted table not found on read-back');
    const cellRequests: GDocRequest[] = [];
    const cells: { index: number; spans: InlineSpan[]; col: number; row: number }[] = [];
    table.table.tableRows.forEach((row, r) => {
      row.tableCells?.forEach((cell, c) => {
        const start = cell.content?.[0]?.startIndex;
        const spans = block.rows[r]?.[c];
        if (start !== undefined && spans && spanText(spans).length > 0) {
          cells.push({ index: start, spans, col: c, row: r });
        }
      });
    });
    const planned = opts.tableWidths?.[widthIdx++];
    const widths = planned && planned.length > 0 ? planned : planColumnWidths(block.rows);
    // Reverse document order, with each cell's fill IMMEDIATELY
    // followed by its style requests: a cell's ranges are only valid
    // before earlier-position fills execute (SI-2 caught the phased
    // version applying styles against already-shifted indices).
    cells.sort((a, b) => b.index - a.index);
    for (const cell of cells) {
      const text = spanText(cell.spans);
      cellRequests.push({ insertText: { location: { index: cell.index }, text } });
      // Paragraph style FIRST: applying namedStyleType re-applies the
      // named style's text properties, wiping run-level overrides —
      // text styles must come after (SI-2 caught the inverted order;
      // same rule as buildSegment's phase ordering).
      cellRequests.push({
        updateParagraphStyle: {
          range: { startIndex: cell.index, endIndex: cell.index + text.length },
          paragraphStyle: {
            namedStyleType: 'NORMAL_TEXT',
            // SI-4: single-glyph columns center their cells.
            alignment: shouldCenterColumn(block.rows, cell.col) ? 'CENTER' : 'START',
          },
          fields: 'namedStyleType,alignment',
        },
      });
      // Lesson 4 / SI-2: explicit body look on cell text (not a bare
      // reset — that clears to the named-style default, not Roboto).
      // Header cells (row 0) get the reference chrome: bold, #333333.
      cellRequests.push({
        updateTextStyle: {
          range: { startIndex: cell.index, endIndex: cell.index + text.length },
          textStyle: {
            ...textStyleOf(BODY),
            foregroundColor: rgb(cell.row === 0 ? TABLE_STYLE.header.textColorHex : '000000'),
            bold: cell.row === 0,
          },
          fields: 'bold,italic,strikethrough,link,weightedFontFamily,fontSize,foregroundColor',
        },
      });
      let offset = cell.index;
      for (const span of cell.spans) {
        const fields: string[] = [];
        const style: Record<string, unknown> = {};
        if (span.bold) (style.bold = true), fields.push('bold');
        if (span.italic) (style.italic = true), fields.push('italic');
        if (span.code)
          (style.weightedFontFamily = { fontFamily: MONO_FONT }), fields.push('weightedFontFamily');
        if (fields.length > 0 && span.text.length > 0) {
          cellRequests.push({
            updateTextStyle: {
              range: { startIndex: offset, endIndex: offset + span.text.length },
              textStyle: style,
              fields: fields.join(','),
            },
          });
        }
        offset += span.text.length;
      }
    }
    // Table chrome (reference.docx "Table" style, issue #17). Cell-style
    // requests address cells by table position, not text index — safe
    // after fills in the same batch.
    if (table.startIndex !== undefined) {
      const tStart = { index: table.startIndex };
      const columns = block.rows[0]?.length ?? 1;
      const borderSide = {
        width: { magnitude: TABLE_STYLE.border.widthPt, unit: 'PT' },
        dashStyle: 'SOLID',
        color: rgb(TABLE_STYLE.border.colorHex),
      };
      const cellRange = (rowIndex: number, rowSpan: number) => ({
        tableCellLocation: { tableStartLocation: tStart, rowIndex, columnIndex: 0 },
        rowSpan,
        columnSpan: columns,
      });
      // Whole table: borders + padding.
      cellRequests.push({
        updateTableCellStyle: {
          tableRange: cellRange(0, block.rows.length),
          tableCellStyle: {
            borderTop: borderSide,
            borderBottom: borderSide,
            borderLeft: borderSide,
            borderRight: borderSide,
            paddingTop: { magnitude: TABLE_STYLE.padding.topPt, unit: 'PT' },
            paddingBottom: { magnitude: TABLE_STYLE.padding.bottomPt, unit: 'PT' },
            paddingLeft: { magnitude: TABLE_STYLE.padding.leftPt, unit: 'PT' },
            paddingRight: { magnitude: TABLE_STYLE.padding.rightPt, unit: 'PT' },
          },
          fields:
            'borderTop,borderBottom,borderLeft,borderRight,paddingTop,paddingBottom,paddingLeft,paddingRight',
        },
      });
      // Header row: background, heavier bottom border, bottom-aligned.
      cellRequests.push({
        updateTableCellStyle: {
          tableRange: cellRange(0, 1),
          tableCellStyle: {
            backgroundColor: rgb(TABLE_STYLE.header.backgroundHex),
            borderBottom: {
              width: { magnitude: TABLE_STYLE.header.bottomBorder.widthPt, unit: 'PT' },
              dashStyle: 'SOLID',
              color: rgb(TABLE_STYLE.header.bottomBorder.colorHex),
            },
            contentAlignment: 'BOTTOM',
          },
          fields: 'backgroundColor,borderBottom,contentAlignment',
        },
      });
      // Zebra striping on body rows: first body row shaded, alternating.
      for (let r = 1; r < block.rows.length; r++) {
        cellRequests.push({
          updateTableCellStyle: {
            tableRange: cellRange(r, 1),
            tableCellStyle: {
              backgroundColor: (r - 1) % 2 === 0 ? rgb(TABLE_STYLE.bandHex) : rgb('FFFFFF'),
            },
            fields: 'backgroundColor',
          },
        });
      }
      // Headers repeat across page breaks.
      cellRequests.push({
        pinTableHeaderRows: { tableStartLocation: tStart, pinnedHeaderRowsCount: 1 },
      });
      // Reference column sizing (doc-tools conventions.md @ ad145b3).
      cellRequests.push(...columnWidthRequests(table.startIndex, widths));
    }
    if (cellRequests.length > 0) {
      await client.batchUpdate(docId, cellRequests, doc.revisionId);
      written += cellRequests.length;
    }
    // Re-read for the post-fill end of the table.
    const after = await client.getDocument(docId);
    const filled = nthTable(after, tableOrdinal - 1);
    cursor = filled?.endIndex ?? cursor;
    afterTable = true;
  }
  flushedFinal = true;
  await flush();
  return written;
}

export interface SyncOptions {
  /** Directory for resolving relative image paths in the markdown. */
  baseDir?: string;
  /** Stages local image files (the temp-docx trick — images.makeDocxStager). */
  imageStager?: LocalImageStager;
}

export async function createFromMarkdown(
  client: DocsClient,
  title: string,
  markdown: string,
  options?: SyncOptions,
): Promise<{ documentId: string; requestsSent: number }> {
  const { documentId } = await client.createDocument(title);
  const { meta, blocks } = mdToCanonicalWithMeta(markdown);
  let requestsSent = 0;
  let contentStart = 1;
  if (hasMeta(meta)) {
    const built = buildMetaRequests(meta, 1);
    const revision = await revisionOf(client, documentId);
    await client.batchUpdate(documentId, built.requests, revision);
    requestsSent += built.requests.length;
    contentStart += built.length;
  }
  const tableWidths = planDocumentWidths(
    blocks.filter((b) => b.kind === 'table').map((b) => (b as { rows: InlineSpan[][][] }).rows),
  );
  const images = await stageImages(blocks, options?.baseDir ?? '', options?.imageStager);
  requestsSent += await applyBlocksAt(client, documentId, blocks, contentStart, {
    tablesBefore: 0,
    tableWidths,
    images,
  });
  return { documentId, requestsSent };
}

export interface UpdatePlan {
  regions: number;
  /** Styling-only blocks patched in place (comments untouched). */
  restyles?: number;
  requestsSent: number;
}

/**
 * Incremental update: read back, canonicalize both sides, diff, rebuild
 * only the changed regions (reverse order so earlier indices survive).
 * Identical content sends zero write requests — RT-1's contract.
 */
/**
 * Fetch path (the gfetch core): Doc → markdown. Reads the
 * original-text view — collaborators' pending suggestions are their
 * proposals, not document content.
 */
export interface FetchOptions {
  /** Existing file content whose unknown frontmatter keys must survive (issue #20). */
  preserveFrontmatterFrom?: string;
}

export async function fetchAsMarkdown(
  client: DocsClient,
  docId: string,
  fetchOpts?: FetchOptions,
): Promise<string> {
  // Refuse multi-tab docs rather than silently returning the first tab
  // (issue #22): callers use fetchTabs for those. Clients without tab
  // reads (the fake) skip the check.
  const withTabs = (
    client as DocsClient & { getDocumentWithTabs?: DocsClient['getDocument'] }
  ).getDocumentWithTabs;
  if (withTabs) {
    const tabbed = (await withTabs.call(client, docId)) as { tabs?: unknown[] };
    if ((tabbed.tabs?.length ?? 0) > 1) {
      throw new Error('Document has multiple tabs — use fetchTabs (CLI: fetch --tabs).');
    }
  }
  const doc = await client.getDocument(docId, 'PREVIEW_WITHOUT_SUGGESTIONS');
  const { meta, consumedElements } = parseDocMeta(doc);
  const body = serializeBlocks(docToBlocks(doc, consumedElements).map((r) => r.block));
  const preserve = fetchOpts?.preserveFrontmatterFrom
    ? splitFrontmatter(fetchOpts.preserveFrontmatterFrom).entries
    : undefined;
  return emitFrontmatter(meta, preserve) + body;
}

export async function updateFromMarkdown(
  client: DocsClient,
  docId: string,
  markdown: string,
  options?: SyncOptions,
): Promise<UpdatePlan> {
  const doc = await client.getDocument(docId);
  // Pending suggestions poison both diff and indices: the original-text
  // view diffs correctly but its indices don't match the stored content
  // batchUpdate writes against; the inline view has usable indices but
  // would diff collaborators' suggestions as document text and destroy
  // them. v1 policy (spec: unpinned behavior): refuse, cleanly.
  if (hasPendingSuggestions(doc)) {
    throw new Error(
      'Document has pending suggested edits — resolve them in Google Docs (or pull first) before pushing.',
    );
  }
  const docMeta = parseDocMeta(doc);
  const readBlocks = docToBlocks(doc, docMeta.consumedElements);
  const { meta: mdMeta, blocks: mdBlocks } = mdToCanonicalWithMeta(markdown);
  const metaChanged = !metaEquals(mdMeta, docMeta.meta);
  const ops = diffBlocks(readBlocks.map((r) => r.block), mdBlocks);
  const regions = planRegions(ops);
  const restyles = ops.filter((op) => op.op === 'restyle');
  if (regions.length === 0 && restyles.length === 0 && !metaChanged) {
    return { regions: 0, restyles: 0, requestsSent: 0 };
  }

  const endIndex = docEndIndex(doc);
  let requestsSent = 0;

  // Restyles FIRST: pure style patches against read-snapshot indices,
  // valid before any region edit moves content. No deletes → comments
  // anchored in these blocks cannot be orphaned.
  if (restyles.length > 0) {
    const requests: GDocRequest[] = [];
    for (const op of restyles) {
      if (op.op !== 'restyle') continue;
      const rb = readBlocks[op.oldIndex]!;
      if (op.block.kind === 'list' && rb.items) {
        requests.push(...restyleListRequests(op.block, rb.items));
      } else if (op.block.kind === 'table' && rb.cells) {
        requests.push(...restyleTableRequests(op.block, rb.cells));
      } else {
        requests.push(...restyleRequests(op.block, rb.startIndex));
      }
    }
    if (requests.length > 0) {
      await client.batchUpdate(docId, requests, doc.revisionId);
      requestsSent += requests.length;
    }
  }
  // Pooling context is the whole markdown document: plan widths for all
  // md tables up front, then hand each region its slice (forward order).
  const mdTables = mdBlocks.filter((b) => b.kind === 'table');
  const allWidths = planDocumentWidths(mdTables.map((b) => (b as { rows: InlineSpan[][][] }).rows));
  // Region blocks are references into mdBlocks, so widths map by identity.
  const widthByTable = new Map(mdTables.map((t, i) => [t, allWidths[i]!]));
  // Reverse region order: later edits never shift earlier indices.
  for (const region of [...regions].reverse()) {
    let insertAt: number;
    // Regions touching the doc end swallow stray trailing paragraphs
    // and omit their own final newline (issue #24) — otherwise every
    // end-of-doc edit accumulates an empty paragraph.
    const touchesEnd =
      region.oldEnd === readBlocks.length &&
      region.blocks.length > 0 &&
      region.blocks[region.blocks.length - 1]!.kind !== 'table';
    if (region.oldEnd > region.oldStart) {
      const start = readBlocks[region.oldStart]!.startIndex;
      // The final segment newline cannot be deleted (lesson 13).
      const end = touchesEnd
        ? endIndex - 1
        : Math.min(readBlocks[region.oldEnd - 1]!.endIndex, endIndex - 1);
      if (end > start) {
        const revision = await revisionOf(client, docId);
        await client.batchUpdate(
          docId,
          [{ deleteContentRange: { range: { startIndex: start, endIndex: end } } }],
          revision,
        );
        requestsSent += 1;
      }
      insertAt = start;
    } else {
      insertAt =
        region.insertBeforeOld < readBlocks.length
          ? readBlocks[region.insertBeforeOld]!.startIndex
          : endIndex - 1;
    }
    const tablesBefore = readBlocks
      .slice(0, region.oldStart)
      .filter((r) => r.block.kind === 'table').length;
    const widths = region.blocks
      .filter((b) => b.kind === 'table')
      .map((t) => widthByTable.get(t) ?? []);
    const images = await stageImages(region.blocks, options?.baseDir ?? '', options?.imageStager);
    requestsSent += await applyBlocksAt(client, docId, region.blocks, insertAt, {
      tablesBefore,
      tableWidths: widths,
      images,
      omitTrailingNewline: touchesEnd,
    });
  }

  // Meta last (it's the earliest region — content indices above stay
  // valid): UCHIP-2 replace-never-append — delete the existing block
  // and rebuild.
  if (metaChanged) {
    const requests: GDocRequest[] = [];
    if (docMeta.consumedElements > 0 && docMeta.endIndex > 1) {
      requests.push({
        deleteContentRange: { range: { startIndex: 1, endIndex: docMeta.endIndex } },
      });
    }
    if (hasMeta(mdMeta)) requests.push(...buildMetaRequests(mdMeta, 1).requests);
    if (requests.length > 0) {
      const revision = await revisionOf(client, docId);
      await client.batchUpdate(docId, requests, revision);
      requestsSent += requests.length;
    }
  }
  return { regions: regions.length + (metaChanged ? 1 : 0), restyles: restyles.length, requestsSent };
}
