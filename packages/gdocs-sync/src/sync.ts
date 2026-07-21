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
import { buildSegment } from './builder.ts';
import { BLOCK_GAP_PT } from './styles.ts';
import { diffBlocks } from './differ.ts';
import type { DocsClient, GDocDocument, GDocRequest, GDocStructuralElement } from './gdoc.ts';
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
async function applyBlocksAt(
  client: DocsClient,
  docId: string,
  blocks: CanonicalBlock[],
  insertAt: number,
  tablesBefore: number,
  /** Pre-planned (possibly pooled) widths for the tables in `blocks`, in order. */
  tableWidths?: number[][],
): Promise<number> {
  let written = 0;
  let cursor = insertAt;
  let tableOrdinal = tablesBefore;
  let widthIdx = 0;
  let afterTable = false;
  let pending: CanonicalBlock[] = [];

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    // The paragraph after a table carries the table's bottom gap —
    // tables themselves can't hold spacing (style-review feedback).
    const segment = buildSegment(pending, cursor, {
      leadingSpaceAbovePt: afterTable ? BLOCK_GAP_PT : undefined,
    });
    afterTable = false;
    const revision = await revisionOf(client, docId);
    await client.batchUpdate(docId, segment.requests, revision);
    written += segment.requests.length;
    cursor += segment.insertedLength;
    pending = [];
  };

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
    const fills: GDocRequest[] = [];
    const styleFixes: GDocRequest[] = [];
    const cells: { index: number; spans: InlineSpan[]; col: number }[] = [];
    table.table.tableRows.forEach((row, r) => {
      row.tableCells?.forEach((cell, c) => {
        const start = cell.content?.[0]?.startIndex;
        const spans = block.rows[r]?.[c];
        if (start !== undefined && spans && spanText(spans).length > 0) {
          cells.push({ index: start, spans, col: c });
        }
      });
    });
    const planned = tableWidths?.[widthIdx++];
    const widths = planned && planned.length > 0 ? planned : planColumnWidths(block.rows);
    // Reverse document order: earlier indices stay valid (lesson 1).
    cells.sort((a, b) => b.index - a.index);
    for (const cell of cells) {
      const text = spanText(cell.spans);
      fills.push({ insertText: { location: { index: cell.index }, text } });
      // Lesson 4 / SI-2: explicit style on cell text so a neighboring
      // heading can't bleed in. Reset + explicit named style.
      styleFixes.push({
        updateTextStyle: {
          range: { startIndex: cell.index, endIndex: cell.index + text.length },
          textStyle: {},
          fields: 'bold,italic,strikethrough,link,weightedFontFamily',
        },
      });
      styleFixes.push({
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
      let offset = cell.index;
      for (const span of cell.spans) {
        const fields: string[] = [];
        const style: Record<string, unknown> = {};
        if (span.bold) (style.bold = true), fields.push('bold');
        if (span.italic) (style.italic = true), fields.push('italic');
        if (span.code)
          (style.weightedFontFamily = { fontFamily: MONO_FONT }), fields.push('weightedFontFamily');
        if (fields.length > 0 && span.text.length > 0) {
          styleFixes.push({
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
    // Reference column sizing (doc-tools conventions.md @ ad145b3).
    // Column properties don't shift text indices.
    if (table.startIndex !== undefined) {
      styleFixes.push(...columnWidthRequests(table.startIndex, widths));
    }
    if (fills.length > 0 || styleFixes.length > 0) {
      // Fills are emitted in reverse order, so style ranges computed from
      // pre-fill indices are only valid for their own cell — which is
      // exactly how they were computed. Same batch, fills first.
      await client.batchUpdate(docId, [...fills, ...styleFixes], doc.revisionId);
      written += fills.length + styleFixes.length;
    }
    // Re-read for the post-fill end of the table.
    const after = await client.getDocument(docId);
    const filled = nthTable(after, tableOrdinal - 1);
    cursor = filled?.endIndex ?? cursor;
    afterTable = true;
  }
  await flush();
  return written;
}

export async function createFromMarkdown(
  client: DocsClient,
  title: string,
  markdown: string,
): Promise<{ documentId: string; requestsSent: number }> {
  const { documentId } = await client.createDocument(title);
  const blocks = mdToCanonical(markdown);
  const tableWidths = planDocumentWidths(
    blocks.filter((b) => b.kind === 'table').map((b) => (b as { rows: InlineSpan[][][] }).rows),
  );
  const requestsSent = await applyBlocksAt(client, documentId, blocks, 1, 0, tableWidths);
  return { documentId, requestsSent };
}

export interface UpdatePlan {
  regions: number;
  requestsSent: number;
}

/**
 * Incremental update: read back, canonicalize both sides, diff, rebuild
 * only the changed regions (reverse order so earlier indices survive).
 * Identical content sends zero write requests — RT-1's contract.
 */
export async function updateFromMarkdown(
  client: DocsClient,
  docId: string,
  markdown: string,
): Promise<UpdatePlan> {
  const doc = await client.getDocument(docId);
  const readBlocks = docToBlocks(doc);
  const mdBlocks = mdToCanonical(markdown);
  const regions = planRegions(diffBlocks(readBlocks.map((r) => r.block), mdBlocks));
  if (regions.length === 0) return { regions: 0, requestsSent: 0 };

  const endIndex = docEndIndex(doc);
  let requestsSent = 0;
  // Pooling context is the whole markdown document: plan widths for all
  // md tables up front, then hand each region its slice (forward order).
  const mdTables = mdBlocks.filter((b) => b.kind === 'table');
  const allWidths = planDocumentWidths(mdTables.map((b) => (b as { rows: InlineSpan[][][] }).rows));
  // Region blocks are references into mdBlocks, so widths map by identity.
  const widthByTable = new Map(mdTables.map((t, i) => [t, allWidths[i]!]));
  // Reverse region order: later edits never shift earlier indices.
  for (const region of [...regions].reverse()) {
    let insertAt: number;
    if (region.oldEnd > region.oldStart) {
      const start = readBlocks[region.oldStart]!.startIndex;
      // The final segment newline cannot be deleted (lesson 13).
      const end = Math.min(readBlocks[region.oldEnd - 1]!.endIndex, endIndex - 1);
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
    requestsSent += await applyBlocksAt(client, docId, region.blocks, insertAt, tablesBefore, widths);
  }
  return { regions: regions.length, requestsSent };
}
