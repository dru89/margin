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
  BLOCK_GAP_PT,
  TABLE_STYLE,
  BODY,
  BODY_SPACING,
  CODE,
  LIST_ITEM_GAP_PT,
  LOOSE_ITEM_GAP_PT,
  QUOTE_BORDER,
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
  /** Staged image layout: caption range (absolute) when a figure. */
  image?: { figure: boolean; caption?: { start: number; end: number } };
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

export interface SegmentOptions {
  /** Extra spaceAbove on the segment's first paragraph (e.g. after a table). */
  leadingSpaceAbovePt?: number;
  /**
   * Drop the final inserted newline — for segments ending at the doc
   * end, where the undeletable segment newline (lesson 13) serves as
   * the last paragraph break. Prevents trailing-empty-paragraph
   * accumulation on end-of-doc edits (issue #24).
   */
  omitTrailingNewline?: boolean;
  /** Staged images by markdown src; unstaged images fall back to a placeholder paragraph. */
  images?: Map<string, import('./images.ts').StagedImage | null>;
}

/**
 * In-place restyle for a block whose text is unchanged (differ
 * 'restyle' op): base reset + block look + per-span styles over the
 * block's existing doc range. No inserts, no deletes — comments
 * anchored inside are untouched. Only span-bearing single-paragraph
 * kinds (paragraph/heading/blockquote); offsets map 1:1 because their
 * doc text equals the concatenated span text.
 */
export function restyleRequests(block: CanonicalBlock, startIndex: number): GDocRequest[] {
  if (block.kind !== 'paragraph' && block.kind !== 'heading' && block.kind !== 'blockquote') return [];
  const { spans } = blockText(block);
  const textLen = block.spans.reduce((n, s) => n + s.text.length, 0);
  if (textLen === 0) return [];
  const requests: GDocRequest[] = [
    {
      updateTextStyle: {
        range: { startIndex, endIndex: startIndex + textLen },
        textStyle: { ...textStyleOf(BODY), foregroundColor: rgb('000000') },
        fields: 'bold,italic,strikethrough,link,weightedFontFamily,fontSize,foregroundColor',
      },
    },
  ];
  if (block.kind === 'heading') {
    const look = block.level === 1 ? TITLE : headingStyle(block.level).look;
    requests.push({
      updateTextStyle: {
        range: { startIndex, endIndex: startIndex + textLen },
        textStyle: textStyleOf(look),
        fields: 'weightedFontFamily,fontSize' + (look.colorHex ? ',foregroundColor' : ''),
      },
    });
  }
  for (const { span, start, end } of spans) {
    if (start === end) continue;
    const style: Record<string, unknown> = {};
    const fields: string[] = [];
    if (span.code) {
      Object.assign(style, textStyleOf(CODE));
      fields.push('weightedFontFamily', 'fontSize', 'foregroundColor');
    }
    if (span.bold) (style.bold = true), fields.push('bold');
    if (span.italic) (style.italic = true), fields.push('italic');
    if (span.strike) (style.strikethrough = true), fields.push('strikethrough');
    if (span.link) (style.link = { url: span.link }), fields.push('link');
    if (fields.length === 0) continue;
    requests.push({
      updateTextStyle: {
        range: { startIndex: startIndex + start, endIndex: startIndex + end },
        textStyle: style,
        fields: fields.join(','),
      },
    });
  }
  return requests;
}

/** Per-span inline style requests over an absolute range (restyle plumbing). */
function spanStyleRequests(
  spans: InlineSpan[],
  startIndex: number,
  baseStyle: Record<string, unknown>,
  baseFields: string,
): GDocRequest[] {
  const textLen = spans.reduce((n, s) => n + s.text.length, 0);
  if (textLen === 0) return [];
  const requests: GDocRequest[] = [
    {
      updateTextStyle: {
        range: { startIndex, endIndex: startIndex + textLen },
        textStyle: baseStyle,
        fields: baseFields,
      },
    },
  ];
  let at = startIndex;
  for (const span of spans) {
    const end = at + span.text.length;
    const style: Record<string, unknown> = {};
    const fields: string[] = [];
    if (span.code) {
      Object.assign(style, textStyleOf(CODE));
      fields.push('weightedFontFamily', 'fontSize', 'foregroundColor');
    }
    if (span.bold) (style.bold = true), fields.push('bold');
    if (span.italic) (style.italic = true), fields.push('italic');
    if (span.strike) (style.strikethrough = true), fields.push('strikethrough');
    if (span.link) (style.link = { url: span.link }), fields.push('link');
    if (fields.length > 0 && end > at) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: at, endIndex: end },
          textStyle: style,
          fields: fields.join(','),
        },
      });
    }
    at = end;
  }
  return requests;
}

const BODY_RESET = {
  style: { ...textStyleOf(BODY), foregroundColor: rgb('000000') } as Record<string, unknown>,
  fields: 'bold,italic,strikethrough,link,weightedFontFamily,fontSize,foregroundColor',
};

/** Restyle a list in place: per-item span styles over item doc ranges (issue #21). */
export function restyleListRequests(
  block: CanonicalBlock & { kind: 'list' },
  itemRanges: { start: number; end: number }[],
): GDocRequest[] {
  const requests: GDocRequest[] = [];
  block.items.forEach((item, i) => {
    const range = itemRanges[i];
    if (!range) return;
    // Checked items keep their strike encoding: re-apply after reset.
    const spans = item.checked
      ? item.spans.map((s) => ({ ...s, strike: true }))
      : item.spans;
    requests.push(...spanStyleRequests(spans, range.start, BODY_RESET.style, BODY_RESET.fields));
  });
  return requests;
}

/** Restyle table cells in place; header row keeps its chrome (issue #21). */
export function restyleTableRequests(
  block: CanonicalBlock & { kind: 'table' },
  cellRanges: { row: number; col: number; start: number; end: number }[],
): GDocRequest[] {
  const requests: GDocRequest[] = [];
  for (const cell of cellRanges) {
    const spans = block.rows[cell.row]?.[cell.col];
    if (!spans || spans.length === 0) continue;
    const base =
      cell.row === 0
        ? {
            style: {
              ...textStyleOf(BODY),
              foregroundColor: rgb(TABLE_STYLE.header.textColorHex),
              bold: true,
            } as Record<string, unknown>,
            fields: BODY_RESET.fields,
          }
        : BODY_RESET;
    requests.push(...spanStyleRequests(spans, cell.start, base.style, base.fields));
  }
  return requests;
}

export function buildSegment(
  blocks: CanonicalBlock[],
  insertAt: number,
  opts: SegmentOptions = {},
): BuiltSegment {
  const layouts: BlockLayout[] = [];
  const inserts: GDocRequest[] = [];
  const tabPositions: number[] = []; // absolute, pre-bullet
  let cursor = insertAt;

  for (const block of blocks) {
    // Staged images: an inline object (1 index unit) in its own
    // paragraph, plus a caption paragraph for figures.
    const staged = block.kind === 'image' ? opts.images?.get(block.src) : undefined;
    if (block.kind === 'image' && staged) {
      const start = cursor;
      inserts.push({ insertText: { location: { index: cursor }, text: '\n' } });
      inserts.push({
        insertInlineImage: {
          location: { index: cursor },
          uri: staged.uri,
          ...(staged.widthPt && staged.heightPt
            ? {
                objectSize: {
                  width: { magnitude: staged.widthPt, unit: 'PT' },
                  height: { magnitude: staged.heightPt, unit: 'PT' },
                },
              }
            : {}),
        },
      });
      cursor += 2; // image (1 unit) + newline
      let caption: { start: number; end: number } | undefined;
      if (block.figure && block.alt) {
        caption = { start: cursor, end: cursor + block.alt.length + 1 };
        inserts.push({ insertText: { location: { index: cursor }, text: `${block.alt}\n` } });
        cursor = caption.end;
      }
      layouts.push({
        block,
        start,
        end: cursor,
        spans: [],
        image: { figure: block.figure, caption },
      });
      continue;
    }

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

  /* ——— paragraph styles (post-correction indices) ———
   * Block-gap model (style review feedback): every block ends with
   * 10pt spaceBelow; lists and code blocks get 10pt at their edges but
   * tight spacing between inner lines/items (1.8pt tight, 10pt loose). */
  const paraStyles: GDocRequest[] = [];
  const pushSpacing = (startIdx: number, endIdx: number, abovePt: number, belowPt: number): void => {
    paraStyles.push({
      updateParagraphStyle: {
        range: { startIndex: corrected(startIdx), endIndex: corrected(endIdx) },
        paragraphStyle: spacingStyle({ beforePt: abovePt, afterPt: belowPt }),
        fields: 'spaceAbove,spaceBelow',
      },
    });
  };
  for (const layout of layouts) {
    if (layout.image) {
      // Image paragraph: centered for figures; caption centered too.
      const imgEnd = layout.image.caption ? layout.image.caption.start : layout.end;
      paraStyles.push({
        updateParagraphStyle: {
          range: { startIndex: corrected(layout.start), endIndex: corrected(imgEnd) },
          paragraphStyle: {
            namedStyleType: 'NORMAL_TEXT',
            alignment: layout.image.figure ? 'CENTER' : 'START',
            ...spacingStyle(BODY_SPACING),
          },
          fields: 'namedStyleType,alignment,spaceAbove,spaceBelow',
        },
      });
      if (layout.image.caption) {
        paraStyles.push({
          updateParagraphStyle: {
            range: {
              startIndex: corrected(layout.image.caption.start),
              endIndex: corrected(layout.image.caption.end),
            },
            paragraphStyle: {
              namedStyleType: 'NORMAL_TEXT',
              alignment: 'CENTER',
              ...spacingStyle(BODY_SPACING),
            },
            fields: 'namedStyleType,alignment,spaceAbove,spaceBelow',
          },
        });
      }
      continue;
    }
    const range = { startIndex: corrected(layout.start), endIndex: corrected(layout.end) };
    const style: Record<string, unknown> = {
      namedStyleType: namedStyleFor(layout.block),
      alignment: 'START',
    };
    let fields = 'namedStyleType,alignment,spaceAbove,spaceBelow';
    switch (layout.block.kind) {
      case 'heading':
        Object.assign(
          style,
          spacingStyle(layout.block.level === 1 ? TITLE_SPACING : headingStyle(layout.block.level).spacing),
        );
        break;
      case 'blockquote': {
        // Multi-paragraph quotes: inner paragraphs 0/0, edges 10 —
        // same pattern as code blocks (issue #24).
        const multi = layout.block.spans.some((sp) => sp.text.includes('\n'));
        Object.assign(style, spacingStyle(multi ? { beforePt: 0, afterPt: 0 } : QUOTE_SPACING));
        style.indentStart = QUOTE_INDENT;
        style.indentFirstLine = QUOTE_INDENT;
        style.borderLeft = QUOTE_BORDER;
        fields += ',indentStart,indentFirstLine,borderLeft';
        break;
      }
      case 'code':
      case 'list': {
        // Inner spacing over the whole range; edge gaps patched after.
        const gap =
          layout.block.kind === 'list'
            ? layout.block.loose
              ? LOOSE_ITEM_GAP_PT
              : LIST_ITEM_GAP_PT
            : 0;
        Object.assign(style, spacingStyle({ beforePt: gap, afterPt: gap }));
        break;
      }
      case 'hr':
        Object.assign(style, spacingStyle(BODY_SPACING));
        style.borderBottom = {
          width: { magnitude: 1, unit: 'PT' },
          padding: { magnitude: 1, unit: 'PT' },
          dashStyle: 'SOLID',
          color: { color: { rgbColor: { red: 0.6, green: 0.6, blue: 0.6 } } },
        };
        fields += ',borderBottom';
        break;
      default:
        Object.assign(style, spacingStyle(BODY_SPACING));
    }
    paraStyles.push({ updateParagraphStyle: { range, paragraphStyle: style, fields } });

    // Edge gaps for multi-paragraph blocks: 10pt entering and leaving.
    if (layout.block.kind === 'code') {
      const lines = layout.block.text.split('\n');
      const firstEnd = layout.start + lines[0]!.length + 1;
      const lastStart = layout.end - (lines[lines.length - 1]!.length + 1);
      pushSpacing(layout.start, firstEnd, BLOCK_GAP_PT, lines.length === 1 ? BLOCK_GAP_PT : 0);
      if (lines.length > 1) pushSpacing(lastStart, layout.end, 0, BLOCK_GAP_PT);
    }
    if (layout.block.kind === 'blockquote') {
      const text = layout.block.spans.map((sp) => sp.text).join('');
      const lines = text.split('\n');
      if (lines.length > 1) {
        const firstEnd = layout.start + lines[0]!.length + 1;
        const lastStart = layout.end - (lines[lines.length - 1]!.length + 1);
        pushSpacing(layout.start, firstEnd, BLOCK_GAP_PT, 0);
        pushSpacing(lastStart, layout.end, 0, BLOCK_GAP_PT);
      }
    }
    if (layout.block.kind === 'list' && layout.items && layout.items.length > 0) {
      const gap = layout.block.loose ? LOOSE_ITEM_GAP_PT : LIST_ITEM_GAP_PT;
      const first = layout.items[0]!;
      const last = layout.items[layout.items.length - 1]!;
      pushSpacing(first.start, first.end + 1, BLOCK_GAP_PT, layout.items.length === 1 ? BLOCK_GAP_PT : gap);
      if (layout.items.length > 1) pushSpacing(last.start, last.end + 1, gap, BLOCK_GAP_PT);
    }
  }
  // Segment following a table: its first paragraph provides the gap
  // below the table (tables themselves can't carry spacing).
  if (opts.leadingSpaceAbovePt !== undefined && layouts.length > 0) {
    const firstLayout = layouts[0]!;
    let firstParaEnd = firstLayout.end;
    if (firstLayout.block.kind === 'code') {
      firstParaEnd = firstLayout.start + firstLayout.block.text.split('\n')[0]!.length + 1;
    } else if (firstLayout.block.kind === 'list' && firstLayout.items?.[0]) {
      firstParaEnd = firstLayout.items[0]!.end + 1;
    }
    paraStyles.push({
      updateParagraphStyle: {
        range: { startIndex: corrected(firstLayout.start), endIndex: corrected(firstParaEnd) },
        paragraphStyle: { spaceAbove: { magnitude: opts.leadingSpaceAbovePt, unit: 'PT' } },
        fields: 'spaceAbove',
      },
    });
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
    // Figure captions: italic, small, subdued (reader detects the
    // italic+centered pair to fold the caption back into the figure).
    if (layout.image?.caption) {
      const cap = layout.image.caption;
      if (cap.end - 1 > cap.start) {
        textStyles.push({
          updateTextStyle: {
            range: { startIndex: corrected(cap.start), endIndex: corrected(cap.end - 1) },
            textStyle: { italic: true, fontSize: { magnitude: 10, unit: 'PT' }, foregroundColor: rgb('666666') },
            fields: 'italic,fontSize,foregroundColor',
          },
        });
      }
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

  let requests = [...inserts, ...bullets, ...paraStyles, ...textStyles];
  let insertedLength = correctedTotalEnd - insertAt;
  if (opts.omitTrailingNewline && insertedLength > 0) {
    const lastInsert = [...requests].reverse().find(
      (r) => (r as { insertText?: { text: string } }).insertText,
    ) as { insertText: { text: string } } | undefined;
    if (lastInsert?.insertText.text.endsWith('\n')) {
      lastInsert.insertText.text = lastInsert.insertText.text.slice(0, -1);
      insertedLength -= 1;
      const finalEnd = insertAt + insertedLength;
      requests = requests.filter((r) => {
        const range = (r as { updateParagraphStyle?: { range: { startIndex: number; endIndex: number } }; updateTextStyle?: { range: { startIndex: number; endIndex: number } }; deleteParagraphBullets?: { range: { startIndex: number; endIndex: number } }; createParagraphBullets?: { range: { startIndex: number; endIndex: number } } }).updateParagraphStyle?.range ??
          (r as { updateTextStyle?: { range: { startIndex: number; endIndex: number } } }).updateTextStyle?.range ??
          (r as { deleteParagraphBullets?: { range: { startIndex: number; endIndex: number } } }).deleteParagraphBullets?.range ??
          (r as { createParagraphBullets?: { range: { startIndex: number; endIndex: number } } }).createParagraphBullets?.range;
        if (!range) return true;
        if (range.endIndex > finalEnd) range.endIndex = finalEnd;
        return range.endIndex > range.startIndex;
      });
    }
  }
  return { requests, insertedLength };
}
