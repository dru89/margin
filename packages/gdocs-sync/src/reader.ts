/**
 * Docs read-back → canonical blocks (UREAD-*): the doc side of
 * canonicalization parity. Structured documents.get walk only (lesson
 * 9 — never the export path). Adjacent same-format runs merge; code
 * lines coalesce (UCANON-2); headings shift +1 back from named styles
 * (conventions: TITLE → #, Heading N → N+1 hashes).
 *
 * Conventions this reader shares with the builder (self-consistent
 * round-trip): code = monospace-font runs; blockquote = non-list
 * paragraph with indentStart ≥ 24pt; hr = empty paragraph with a
 * bottom border.
 */
import type { CanonicalBlock, InlineSpan, ListItem } from './blocks.ts';
import { coalesceCodeBlocks } from './blocks.ts';
import { CALLOUTS } from './styles.ts';
import type { GDocDocument, GDocParagraph, GDocStructuralElement } from './gdoc.ts';

/** The font the builder writes for code. */
export const MONO_FONT = 'Roboto Mono';
/**
 * Fonts recognized as code on read. Docs authored by hand or by the
 * reference tool carry whatever monospace font their template chose;
 * recognizing only our own write font flattens their code to prose.
 */
const MONO_FONTS = new Set([
  MONO_FONT,
  'Courier New',
  'Consolas',
  'Source Code Pro',
  'Fira Code',
  'JetBrains Mono',
  'Noto Sans Mono',
  'Ubuntu Mono',
  'Inconsolata',
]);
// The builder writes 36pt; the reference tool writes 24pt per quote
// nesting level. Accept both — the Docs UI itself indents in 36pt
// steps, so 24pt only ever means a blockquote.
const QUOTE_INDENT_PT = 24;

export interface ReadBlock {
  block: CanonicalBlock;
  /** Doc index range covering the block (for region deletes). */
  startIndex: number;
  endIndex: number;
  /** Per-item paragraph ranges for list blocks (restyle targets). */
  items?: { start: number; end: number }[];
  /** Per-cell content ranges for table blocks (restyle targets). */
  cells?: { row: number; col: number; start: number; end: number }[];
}

function spansOf(doc: GDocDocument, para: GDocParagraph): InlineSpan[] {
  const spans: InlineSpan[] = [];
  for (const el of para.elements ?? []) {
    // Inline images mixed with text (issue #23): one U+FFFC unit.
    if (el.inlineObjectElement?.inlineObjectId) {
      const embedded =
        doc.inlineObjects?.[el.inlineObjectElement.inlineObjectId]?.inlineObjectProperties
          ?.embeddedObject;
      spans.push({
        text: '\uFFFC',
        image: {
          src: embedded?.imageProperties?.sourceUri ?? embedded?.imageProperties?.contentUri ?? '',
          alt: embedded?.description ?? '',
        },
      });
      continue;
    }
    // Smart chips render as text (lesson 5 / UREAD-9): content the
    // diff can't see gets deleted on the next region rebuild.
    if (el.person) {
      const p = el.person.personProperties;
      spans.push({ text: p?.name ?? p?.email ?? '', chip: true });
      continue;
    }
    if (el.dateElement) {
      const d = el.dateElement.dateElementProperties;
      spans.push({ text: d?.displayText ?? d?.timestamp?.slice(0, 10) ?? '', chip: true });
      continue;
    }
    if (el.richLink) {
      const r = el.richLink.richLinkProperties;
      spans.push({ text: r?.title ?? r?.uri ?? '', chip: true, link: r?.uri });
      continue;
    }
    const run = el.textRun;
    if (!run?.content) continue;
    const style = run.textStyle ?? {};
    const span: InlineSpan = { text: run.content };
    if (style.bold) span.bold = true;
    if (style.italic) span.italic = true;
    if (style.strikethrough) span.strike = true;
    if (style.link?.url) span.link = style.link.url;
    const font = style.weightedFontFamily?.fontFamily;
    if (font && MONO_FONTS.has(font)) span.code = true;
    spans.push(span);
  }
  // Strip the paragraph's trailing newline from the last span.
  const last = spans[spans.length - 1];
  if (last?.text.endsWith('\n')) last.text = last.text.slice(0, -1);
  // UREAD-5: merge adjacent runs with identical formatting.
  const merged: InlineSpan[] = [];
  for (const s of spans) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      !!prev.bold === !!s.bold &&
      !!prev.italic === !!s.italic &&
      !!prev.strike === !!s.strike &&
      !!prev.code === !!s.code &&
      !prev.chip &&
      !s.chip &&
      !prev.image &&
      !s.image &&
      prev.link === s.link
    ) {
      prev.text += s.text;
    } else {
      merged.push({ ...s });
    }
  }
  return merged.filter((s) => s.text !== '');
}

function headingLevel(named: string | undefined): number | null {
  if (named === 'TITLE') return 1;
  const m = /^HEADING_([1-6])$/.exec(named ?? '');
  return m ? Math.min(6, Number(m[1]) + 1) : null;
}

function isOrderedList(doc: GDocDocument, listId: string, level: number): boolean {
  const glyph = doc.lists?.[listId]?.listProperties?.nestingLevels?.[level]?.glyphType ?? '';
  return glyph.startsWith('DECIMAL') || glyph.startsWith('ALPHA') || glyph.startsWith('ROMAN') || glyph.startsWith('UPPER');
}

/**
 * Checkbox lists (probed live): glyphType GLYPH_TYPE_UNSPECIFIED with
 * no glyphSymbol. Disc/circle lists carry a glyphSymbol; ordered lists
 * carry a real glyphType.
 */
function isCheckboxList(doc: GDocDocument, listId: string): boolean {
  const level = doc.lists?.[listId]?.listProperties?.nestingLevels?.[0];
  if (!level) return false;
  return (level.glyphType ?? 'GLYPH_TYPE_UNSPECIFIED') === 'GLYPH_TYPE_UNSPECIFIED' && !level.glyphSymbol;
}

function imageOf(doc: GDocDocument, para: GDocParagraph): { src: string; alt: string } | null {
  const objEl = (para.elements ?? []).find((e) => e.inlineObjectElement?.inlineObjectId);
  if (!objEl) return null;
  const hasText = (para.elements ?? []).some((e) => (e.textRun?.content ?? '').trim() !== '');
  if (hasText) return null; // mixed image+text paragraphs stay paragraphs (v0)
  const embedded =
    doc.inlineObjects?.[objEl.inlineObjectElement!.inlineObjectId!]?.inlineObjectProperties
      ?.embeddedObject;
  return {
    src: embedded?.imageProperties?.sourceUri ?? embedded?.imageProperties?.contentUri ?? '',
    alt: embedded?.description ?? '',
  };
}

/** Walk body content (single tab) into canonical blocks with doc ranges. */
export function docToBlocks(doc: GDocDocument, skipElements = 0): ReadBlock[] {
  const out: ReadBlock[] = [];
  const content = (doc.body?.content ?? []).slice(skipElements);
  let pendingEmpties = 0;
  /** Empties between two code blocks are blank code lines. */
  const empties = new Map<ReadBlock, number>();

  for (let ci = 0; ci < content.length; ci++) {
    const el = content[ci]!;
    const start = el.startIndex ?? 0;
    const end = el.endIndex ?? start;

    if (el.table) {
      pendingEmpties = 0;
      // Callout fold-back (issue #40): a 1×1 table whose cell text
      // leads with a known callout emoji reads as a callout block.
      const callout = calloutOf(doc, el);
      if (callout) {
        out.push({ block: callout, startIndex: start, endIndex: end });
        continue;
      }
      const cellRanges: { row: number; col: number; start: number; end: number }[] = [];
      const rows = (el.table.tableRows ?? []).map((row, r) =>
        (row.tableCells ?? []).map((cell, c) => {
          // Guards (issue #17): merged cells and nested tables would
          // silently mangle — refuse loudly instead.
          const style = (cell as { tableCellStyle?: { rowSpan?: number; columnSpan?: number } })
            .tableCellStyle;
          if ((style?.rowSpan ?? 1) > 1 || (style?.columnSpan ?? 1) > 1) {
            throw new Error('Table has merged cells — not supported by gdocs-sync yet.');
          }
          const cellSpans: InlineSpan[] = [];
          for (const inner of cell.content ?? []) {
            if (inner.table) throw new Error('Nested tables are not supported by gdocs-sync yet.');
            if (inner.paragraph) cellSpans.push(...spansOf(doc, inner.paragraph));
          }
          const first = cell.content?.[0]?.startIndex;
          if (first !== undefined) {
            cellRanges.push({
              row: r,
              col: c,
              start: first,
              end: cell.content?.[cell.content.length - 1]?.endIndex ?? first,
            });
          }
          // Header-row bold is OUR chrome (reference table style), not
          // authored formatting — strip it so fetch stays round-trip
          // stable ('| Name |' never becomes '| **Name** |').
          if (r === 0) for (const s of cellSpans) delete s.bold;
          return cellSpans;
        }),
      );
      out.push({ block: { kind: 'table', rows }, startIndex: start, endIndex: end, cells: cellRanges });
      continue;
    }

    const para = el.paragraph;
    if (!para) continue; // sectionBreak etc.

    // Image paragraph → image block; a following centered-italic
    // paragraph is its caption (figure trichotomy, builder convention).
    const image = imageOf(doc, para);
    if (image) {
      pendingEmpties = 0;
      const centered = para.paragraphStyle?.alignment === 'CENTER';
      let blockEnd = end;
      let alt = image.alt;
      let figure = false;
      const next = content[ci + 1];
      if (centered && next?.paragraph) {
        const nextSpans = spansOf(doc, next.paragraph);
        const isCaption =
          nextSpans.length > 0 &&
          nextSpans.every((s) => s.italic) &&
          next.paragraph.paragraphStyle?.alignment === 'CENTER';
        if (isCaption) {
          alt = nextSpans.map((s) => s.text).join('');
          figure = true;
          blockEnd = next.endIndex ?? blockEnd;
          ci++; // consume the caption
        }
      }
      out.push({
        block: { kind: 'image', src: image.src, alt, figure },
        startIndex: start,
        endIndex: blockEnd,
      });
      continue;
    }

    const spans = spansOf(doc, para);
    const text = spans.map((s) => s.text).join('');
    const style = para.paragraphStyle ?? {};

    // hr: empty paragraph carrying a bottom border.
    if (text === '' && style.borderBottom?.width?.magnitude !== undefined) {
      pendingEmpties = 0;
      out.push({ block: { kind: 'hr' }, startIndex: start, endIndex: end });
      continue;
    }

    if (para.bullet?.listId) {
      pendingEmpties = 0;
      const depth = para.bullet.nestingLevel ?? 0;
      const item: ListItem = {
        depth,
        ordered: isOrderedList(doc, para.bullet.listId, depth),
        spans,
      };
      if (isCheckboxList(doc, para.bullet.listId)) {
        // UREAD-7 heuristic: checked = every run struck through. Strip
        // the strike from spans — it encodes checked state, not
        // author formatting (mirrors the builder's write path).
        item.checked = spans.length > 0 && spans.every((s) => s.strike);
        if (item.checked) for (const s of spans) delete s.strike;
      }
      // Group consecutive items of the same listId into one list block.
      const prev = out[out.length - 1];
      const prevListId = (prev as { listId?: string } | undefined)?.listId;
      if (prev?.block.kind === 'list' && prevListId === para.bullet.listId) {
        prev.block.items.push(item);
        prev.items!.push({ start, end });
        prev.endIndex = end;
      } else {
        const rb: ReadBlock & { listId?: string } = {
          block: { kind: 'list', items: [item] },
          startIndex: start,
          endIndex: end,
          items: [{ start, end }],
          listId: para.bullet.listId,
        };
        out.push(rb);
      }
      continue;
    }

    if (text === '') {
      // UREAD-1: empty padding paragraphs are skipped — but counted,
      // so blank lines INSIDE code blocks survive the coalesce pass
      // (issue #24: an empty line has no runs, hence no mono signal).
      pendingEmpties++;
      continue;
    }
    const emptiesBefore = pendingEmpties;
    pendingEmpties = 0;

    const level = headingLevel(style.namedStyleType);
    if (level !== null) {
      out.push({ block: { kind: 'heading', level, spans }, startIndex: start, endIndex: end });
      continue;
    }

    // Code line: every span monospace.
    if (spans.length > 0 && spans.every((s) => s.code)) {
      const rb: ReadBlock = { block: { kind: 'code', lang: null, text }, startIndex: start, endIndex: end };
      if (emptiesBefore > 0) empties.set(rb, emptiesBefore);
      out.push(rb);
      continue;
    }

    if ((style.indentStart?.magnitude ?? 0) >= QUOTE_INDENT_PT) {
      out.push({ block: { kind: 'blockquote', spans }, startIndex: start, endIndex: end });
      continue;
    }

    out.push({ block: { kind: 'paragraph', spans }, startIndex: start, endIndex: end });
  }

  // Coalesce adjacent code lines (UCANON-2/3) — blank lines between
  // them rejoin as empty code lines — and adjacent blockquote
  // paragraphs (a multi-paragraph quote is ONE canonical block).
  const result: ReadBlock[] = [];
  for (const rb of out) {
    const prev = result[result.length - 1];
    if (rb.block.kind === 'code' && prev?.block.kind === 'code') {
      const blanks = empties.get(rb) ?? 0;
      prev.block = {
        kind: 'code',
        lang: null,
        text: `${(prev.block as { text: string }).text}${'\n'.repeat(blanks + 1)}${rb.block.text}`,
      };
      prev.endIndex = rb.endIndex;
      continue;
    }
    if (rb.block.kind === 'blockquote' && prev?.block.kind === 'blockquote') {
      prev.block = {
        kind: 'blockquote',
        spans: [...prev.block.spans, { text: '\n' }, ...rb.block.spans],
      };
      prev.endIndex = rb.endIndex;
      continue;
    }
    result.push(rb);
  }
  return result;
}

/** 1×1 table + leading callout emoji → callout block (issue #40). */
function calloutOf(doc: GDocDocument, el: GDocStructuralElement): CanonicalBlock | null {
  const rows = el.table?.tableRows ?? [];
  if (rows.length !== 1 || (rows[0]!.tableCells ?? []).length !== 1) return null;
  const content = rows[0]!.tableCells![0]!.content ?? [];
  const view: GDocDocument = { body: { content }, lists: doc.lists, inlineObjects: doc.inlineObjects };
  let inner: ReadBlock[];
  try {
    inner = docToBlocks(view);
  } catch {
    return null; // guarded structures inside — treat as a plain table upstream
  }
  const first = inner[0]?.block;
  if (first?.kind !== 'paragraph') return null;
  const firstText = first.spans.map((s) => s.text).join('');
  const entry = Object.entries(CALLOUTS).find(([, c]) => firstText.startsWith(c.emoji));
  if (!entry) return null;
  const [type, chrome] = entry;
  // Strip the emoji prefix and the chrome bold from the title spans.
  let toStrip = chrome.emoji.length + 1; // emoji + space
  const title: InlineSpan[] = [];
  for (const span of first.spans) {
    let text = span.text;
    if (toStrip > 0) {
      const take = Math.min(toStrip, text.length);
      text = text.slice(take);
      toStrip -= take;
    }
    if (text !== '') title.push({ ...span, text, bold: undefined });
  }
  const body = inner.slice(1).map((r) => r.block);
  // Synthesized uppercase-type titles fold back to an empty title.
  const titleText = title.map((s) => s.text).join('');
  const finalTitle = titleText === type.toUpperCase() ? [] : title;
  return { kind: 'callout', type, title: finalTitle, body };
}
