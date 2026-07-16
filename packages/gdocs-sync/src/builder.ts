/**
 * Canonical blocks → batchUpdate requests, one segment at a time.
 * Segments contain no tables (the orchestrator splits at tables and
 * fills cells via read-back).
 *
 * Lesson 2 phase order, one batch: all inserts → bullet phase (clear
 * then create) → paragraph styles → text styles (reset first, then
 * bold/italic/link — base-before-inline or the bold silently dies).
 *
 * Lesson 3: createParagraphBullets removes the leading nesting tabs,
 * shrinking the document mid-batch. Every post-bullet index is
 * corrected by the count of removed tabs before it.
 *
 * Lesson 4: explicitly set every inheritable property on everything
 * inserted — named style + alignment on every paragraph, a full text
 * style reset over the whole range — because inserted content inherits
 * neighbor formatting, and only on incremental updates.
 */
import type { CanonicalBlock, InlineSpan } from './blocks.ts';
import type { GDocRequest } from './gdoc.ts';
import { MONO_FONT } from './reader.ts';

const QUOTE_INDENT = { magnitude: 36, unit: 'PT' };

interface SpanRange {
  span: InlineSpan;
  start: number;
  end: number;
}

interface BlockLayout {
  block: CanonicalBlock;
  /** Pre-bullet-correction absolute range of the block's paragraphs. */
  start: number;
  end: number;
  spans: SpanRange[];
}

export interface BuiltSegment {
  requests: GDocRequest[];
  /** Length the segment occupies after bullet tab removal. */
  insertedLength: number;
}

function blockText(block: CanonicalBlock): { text: string; spans: SpanRange[] } {
  switch (block.kind) {
    case 'heading':
    case 'paragraph':
    case 'blockquote': {
      let cursor = 0;
      const spans: SpanRange[] = [];
      for (const span of block.spans) {
        spans.push({ span, start: cursor, end: cursor + span.text.length });
        cursor += span.text.length;
      }
      return { text: block.spans.map((s) => s.text).join('') + '\n', spans };
    }
    case 'code':
      return { text: block.text + '\n', spans: [] };
    case 'list': {
      let cursor = 0;
      const spans: SpanRange[] = [];
      const lines: string[] = [];
      for (const item of block.items) {
        const prefix = '\t'.repeat(item.depth);
        cursor += prefix.length;
        for (const span of item.spans) {
          spans.push({ span, start: cursor, end: cursor + span.text.length });
          cursor += span.text.length;
        }
        cursor += 1; // newline
        lines.push(prefix + item.spans.map((s) => s.text).join(''));
      }
      return { text: lines.join('\n') + '\n', spans };
    }
    case 'hr':
      return { text: '\n', spans: [] };
    case 'table':
      throw new Error('tables are handled by the orchestrator, not buildSegment');
    case 'image':
      // v0: images are inserted by the orchestrator (URI staging); an
      // empty paragraph holds the spot in text-only segments.
      return { text: '\n', spans: [] };
  }
}

function namedStyleFor(block: CanonicalBlock): string {
  if (block.kind === 'heading') {
    // Conventions: -1 shift. # → TITLE, ## → HEADING_1, …
    return block.level === 1 ? 'TITLE' : `HEADING_${Math.min(block.level - 1, 6)}`;
  }
  return 'NORMAL_TEXT';
}

export function buildSegment(blocks: CanonicalBlock[], insertAt: number): BuiltSegment {
  const layouts: BlockLayout[] = [];
  const inserts: GDocRequest[] = [];
  const tabPositions: number[] = []; // absolute, pre-bullet
  let cursor = insertAt;

  for (const block of blocks) {
    const { text, spans } = blockText(block);
    // Record nesting-tab positions for the lesson-3 correction.
    if (block.kind === 'list') {
      let lineStart = cursor;
      for (const item of block.items) {
        for (let t = 0; t < item.depth; t++) tabPositions.push(lineStart + t);
        lineStart += item.depth + item.spans.reduce((n, s) => n + s.text.length, 0) + 1;
      }
    }
    inserts.push({ insertText: { location: { index: cursor }, text } });
    layouts.push({
      block,
      start: cursor,
      end: cursor + text.length,
      spans: spans.map((s) => ({ ...s, start: cursor + s.start, end: cursor + s.end })),
    });
    cursor += text.length;
  }

  const totalEnd = cursor;
  tabPositions.sort((a, b) => a - b);
  const tabsBefore = (index: number): number => {
    let lo = 0;
    let hi = tabPositions.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tabPositions[mid]! < index) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const corrected = (index: number): number => index - tabsBefore(index);

  /* ——— bullet phase ——— */
  const bullets: GDocRequest[] = [];
  if (totalEnd > insertAt) {
    // Clear inherited bullets across the entire inserted range (lesson 4),
    // then apply real ones. Range still contains tabs at this point.
    bullets.push({
      deleteParagraphBullets: { range: { startIndex: insertAt, endIndex: totalEnd } },
    });
  }
  let tabsRemovedSoFar = 0;
  for (const layout of layouts) {
    if (layout.block.kind !== 'list') continue;
    const ordered = layout.block.items[0]?.ordered ?? false;
    bullets.push({
      createParagraphBullets: {
        range: {
          startIndex: layout.start - tabsRemovedSoFar,
          endIndex: layout.end - tabsRemovedSoFar,
        },
        bulletPreset: ordered ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE',
      },
    });
    tabsRemovedSoFar += layout.block.items.reduce((n, i) => n + i.depth, 0);
  }

  /* ——— paragraph styles (post-correction indices) ——— */
  const paraStyles: GDocRequest[] = [];
  for (const layout of layouts) {
    const range = { startIndex: corrected(layout.start), endIndex: corrected(layout.end) };
    const style: Record<string, unknown> = {
      namedStyleType: namedStyleFor(layout.block),
      alignment: 'START',
    };
    let fields = 'namedStyleType,alignment';
    if (layout.block.kind === 'blockquote') {
      style.indentStart = QUOTE_INDENT;
      style.indentFirstLine = QUOTE_INDENT;
      fields += ',indentStart,indentFirstLine';
    }
    if (layout.block.kind === 'hr') {
      style.borderBottom = {
        width: { magnitude: 1, unit: 'PT' },
        padding: { magnitude: 1, unit: 'PT' },
        dashStyle: 'SOLID',
        color: { color: { rgbColor: { red: 0.6, green: 0.6, blue: 0.6 } } },
      };
      fields += ',borderBottom';
    }
    paraStyles.push({ updateParagraphStyle: { range, paragraphStyle: style, fields } });
  }

  /* ——— text styles: reset first, then base fonts, then inline ——— */
  const textStyles: GDocRequest[] = [];
  const correctedTotalEnd = corrected(totalEnd);
  if (correctedTotalEnd > insertAt) {
    // Full reset over the inserted range: inherited bold/fonts die here.
    textStyles.push({
      updateTextStyle: {
        range: { startIndex: insertAt, endIndex: correctedTotalEnd },
        textStyle: {},
        fields: 'bold,italic,strikethrough,link,weightedFontFamily',
      },
    });
  }
  for (const layout of layouts) {
    if (layout.block.kind === 'code') {
      textStyles.push({
        updateTextStyle: {
          range: { startIndex: corrected(layout.start), endIndex: corrected(layout.end) },
          textStyle: { weightedFontFamily: { fontFamily: MONO_FONT } },
          fields: 'weightedFontFamily',
        },
      });
    }
    for (const { span, start, end } of layout.spans) {
      if (start === end) continue;
      const style: Record<string, unknown> = {};
      const fields: string[] = [];
      if (span.code) {
        style.weightedFontFamily = { fontFamily: MONO_FONT };
        fields.push('weightedFontFamily');
      }
      if (span.bold) {
        style.bold = true;
        fields.push('bold');
      }
      if (span.italic) {
        style.italic = true;
        fields.push('italic');
      }
      if (span.strike) {
        style.strikethrough = true;
        fields.push('strikethrough');
      }
      if (span.link) {
        style.link = { url: span.link };
        fields.push('link');
      }
      if (fields.length === 0) continue;
      textStyles.push({
        updateTextStyle: {
          range: { startIndex: corrected(start), endIndex: corrected(end) },
          textStyle: style,
          fields: fields.join(','),
        },
      });
    }
  }

  return {
    requests: [...inserts, ...bullets, ...paraStyles, ...textStyles],
    insertedLength: correctedTotalEnd - insertAt,
  };
}
