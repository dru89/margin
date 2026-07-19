/**
 * Canonical blocks → batchUpdate requests, one segment at a time.
 * Segments contain no tables (the orchestrator splits at tables and
 * fills cells via read-back).
 *
 * Lesson 2 phase order, one batch: all inserts → bullet phase (clear
 * then create) → paragraph styles → text styles (base reset first,
 * then block looks, then inline — base-before-inline or bold dies).
 *
 * Lesson 3: createParagraphBullets removes the leading nesting tabs,
 * shrinking the document mid-batch. Every post-bullet index is
 * corrected by the count of removed tabs before it.
 *
 * Lesson 4: explicitly set every inheritable property on everything
 * inserted. The base reset sets the reference body look (Roboto 11)
 * rather than clearing to named-style defaults — pushed docs carry the
 * reference.docx styling (src/styles.ts), not Google's defaults.
 *
 * Checkboxes (conventions option c): BULLET_CHECKBOX preset + explicit
 * strikethrough on checked items — real checkboxes, and checked state
 * round-trips through the read heuristic. The API cannot set the box
 * itself; the strikethrough mirrors how the Docs UI renders checked
 * items, so UI-authored and pushed data read back identically.
 */
import type { CanonicalBlock, InlineSpan } from './blocks.ts';
import type { GDocRequest } from './gdoc.ts';
import {
  BODY,
  BODY_SPACING,
  CODE,
  CODE_SPACING,
  LIST_SPACING,
  QUOTE_SPACING,
  TITLE,
  TITLE_SPACING,
  headingStyle,
  rgb,
  spacingStyle,
  textStyleOf,
} from './styles.ts';

const QUOTE_INDENT = { magnitude: 36, unit: 'PT' };

interface SpanRange {
  span: InlineSpan;
  start: number;
  end: number;
}

interface ItemRange {
  start: number;
  end: number;
  checked?: boolean;
}

interface BlockLayout {
  block: CanonicalBlock;
  /** Pre-bullet-correction absolute range of the block's paragraphs. */
  start: number;
  end: number;
  spans: SpanRange[];
  items?: ItemRange[];
}

export interface BuiltSegment {
  requests: GDocRequest[];
  /** Length the segment occupies after bullet tab removal. */
  insertedLength: number;
}

function blockText(block: CanonicalBlock): { text: string; spans: SpanRange[]; items?: ItemRange[] } {
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
      const items: ItemRange[] = [];
      const lines: string[] = [];
      for (const item of block.items) {
        const prefix = '\t'.repeat(item.depth);
        const itemStart = cursor + prefix.length;
        cursor += prefix.length;
        for (const span of item.spans) {
          spans.push({ span, start: cursor, end: cursor + span.text.length });
          cursor += span.text.length;
        }
        items.push({ start: itemStart, end: cursor, checked: item.checked });
        cursor += 1; // newline
        lines.push(prefix + item.spans.map((s) => s.text).join(''));
      }
      return { text: lines.join('\n') + '\n', spans, items };
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

function spacingFor(block: CanonicalBlock): ReturnType<typeof spacingStyle> {
  switch (block.kind) {
    case 'heading':
      return spacingStyle(block.level === 1 ? TITLE_SPACING : headingStyle(block.level).spacing);
    case 'code':
      return spacingStyle(CODE_SPACING);
    case 'blockquote':
      return spacingStyle(QUOTE_SPACING);
    case 'list':
      return spacingStyle(LIST_SPACING);
    default:
      return spacingStyle(BODY_SPACING);
  }
}

export function buildSegment(blocks: CanonicalBlock[], insertAt: number): BuiltSegment {
  const layouts: BlockLayout[] = [];
  const inserts: GDocRequest[] = [];
  const tabPositions: number[] = []; // absolute, pre-bullet
  let cursor = insertAt;

  for (const block of blocks) {
    const { text, spans, items } = blockText(block);
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
      items: items?.map((i) => ({ ...i, start: cursor + i.start, end: cursor + i.end })),
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
    bullets.push({
      deleteParagraphBullets: { range: { startIndex: insertAt, endIndex: totalEnd } },
    });
  }
  let tabsRemovedSoFar = 0;
  for (const layout of layouts) {
    if (layout.block.kind !== 'list') continue;
    const isCheckbox = layout.block.items.some((i) => i.checked !== undefined);
    const ordered = layout.block.items[0]?.ordered ?? false;
    bullets.push({
      createParagraphBullets: {
        range: {
          startIndex: layout.start - tabsRemovedSoFar,
          endIndex: layout.end - tabsRemovedSoFar,
        },
        bulletPreset: isCheckbox
          ? 'BULLET_CHECKBOX'
          : ordered
            ? 'NUMBERED_DECIMAL_ALPHA_ROMAN'
            : 'BULLET_DISC_CIRCLE_SQUARE',
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
      ...spacingFor(layout.block),
    };
    let fields = 'namedStyleType,alignment,spaceAbove,spaceBelow';
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

  /* ——— text styles: base reset, block looks, then inline ——— */
  const textStyles: GDocRequest[] = [];
  const correctedTotalEnd = corrected(totalEnd);
  if (correctedTotalEnd > insertAt) {
    // Base reset = the reference body look, explicitly (lesson 4).
    textStyles.push({
      updateTextStyle: {
        range: { startIndex: insertAt, endIndex: correctedTotalEnd },
        textStyle: { ...textStyleOf(BODY), foregroundColor: rgb('000000') },
        fields: 'bold,italic,strikethrough,link,weightedFontFamily,fontSize,foregroundColor',
      },
    });
  }
  for (const layout of layouts) {
    const range = { startIndex: corrected(layout.start), endIndex: corrected(layout.end) };
    if (layout.block.kind === 'heading') {
      const look = layout.block.level === 1 ? TITLE : headingStyle(layout.block.level).look;
      textStyles.push({
        updateTextStyle: {
          range,
          textStyle: textStyleOf(look),
          fields: 'weightedFontFamily,fontSize' + (look.colorHex ? ',foregroundColor' : ''),
        },
      });
    }
    if (layout.block.kind === 'code') {
      textStyles.push({
        updateTextStyle: {
          range,
          textStyle: textStyleOf(CODE),
          fields: 'weightedFontFamily,fontSize,foregroundColor',
        },
      });
    }
    // Checked checkbox items: explicit strikethrough (conventions option c).
    for (const item of layout.items ?? []) {
      if (item.checked && item.end > item.start) {
        textStyles.push({
          updateTextStyle: {
            range: { startIndex: corrected(item.start), endIndex: corrected(item.end) },
            textStyle: { strikethrough: true },
            fields: 'strikethrough',
          },
        });
      }
    }
    for (const { span, start, end } of layout.spans) {
      if (start === end) continue;
      const style: Record<string, unknown> = {};
      const fields: string[] = [];
      if (span.code) {
        Object.assign(style, textStyleOf(CODE));
        fields.push('weightedFontFamily', 'fontSize', 'foregroundColor');
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
