/**
 * Docs read-back → canonical blocks (UREAD-*): the doc side of
 * canonicalization parity. Structured documents.get walk only (lesson
 * 9 — never the export path). Adjacent same-format runs merge; code
 * lines coalesce (UCANON-2); headings shift +1 back from named styles
 * (conventions: TITLE → #, Heading N → N+1 hashes).
 *
 * Conventions this reader shares with the builder (self-consistent
 * round-trip): code = monospace-font runs; blockquote = non-list
 * paragraph with indentStart ≥ 30pt; hr = empty paragraph with a
 * bottom border.
 */
import type { CanonicalBlock, InlineSpan, ListItem } from './blocks.ts';
import { coalesceCodeBlocks } from './blocks.ts';
import type { GDocDocument, GDocParagraph, GDocStructuralElement } from './gdoc.ts';

export const MONO_FONT = 'Roboto Mono';
const QUOTE_INDENT_PT = 30;

export interface ReadBlock {
  block: CanonicalBlock;
  /** Doc index range covering the block (for region deletes). */
  startIndex: number;
  endIndex: number;
}

function spansOf(para: GDocParagraph): InlineSpan[] {
  const spans: InlineSpan[] = [];
  for (const el of para.elements ?? []) {
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
    if (style.weightedFontFamily?.fontFamily === MONO_FONT) span.code = true;
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

  for (let ci = 0; ci < content.length; ci++) {
    const el = content[ci]!;
    const start = el.startIndex ?? 0;
    const end = el.endIndex ?? start;

    if (el.table) {
      const rows = (el.table.tableRows ?? []).map((row) =>
        (row.tableCells ?? []).map((cell) => {
          const cellSpans: InlineSpan[] = [];
          for (const inner of cell.content ?? []) {
            if (inner.paragraph) cellSpans.push(...spansOf(inner.paragraph));
          }
          return cellSpans;
        }),
      );
      out.push({ block: { kind: 'table', rows }, startIndex: start, endIndex: end });
      continue;
    }

    const para = el.paragraph;
    if (!para) continue; // sectionBreak etc.

    // Image paragraph → image block; a following centered-italic
    // paragraph is its caption (figure trichotomy, builder convention).
    const image = imageOf(doc, para);
    if (image) {
      const centered = para.paragraphStyle?.alignment === 'CENTER';
      let blockEnd = end;
      let alt = image.alt;
      let figure = false;
      const next = content[ci + 1];
      if (centered && next?.paragraph) {
        const nextSpans = spansOf(next.paragraph);
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

    const spans = spansOf(para);
    const text = spans.map((s) => s.text).join('');
    const style = para.paragraphStyle ?? {};

    // hr: empty paragraph carrying a bottom border.
    if (text === '' && style.borderBottom?.width?.magnitude !== undefined) {
      out.push({ block: { kind: 'hr' }, startIndex: start, endIndex: end });
      continue;
    }

    if (para.bullet?.listId) {
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
        prev.endIndex = end;
      } else {
        const rb: ReadBlock & { listId?: string } = {
          block: { kind: 'list', items: [item] },
          startIndex: start,
          endIndex: end,
          listId: para.bullet.listId,
        };
        out.push(rb);
      }
      continue;
    }

    if (text === '') continue; // UREAD-1: skip empty padding paragraphs

    const level = headingLevel(style.namedStyleType);
    if (level !== null) {
      out.push({ block: { kind: 'heading', level, spans }, startIndex: start, endIndex: end });
      continue;
    }

    // Code line: every span monospace.
    if (spans.length > 0 && spans.every((s) => s.code)) {
      out.push({
        block: { kind: 'code', lang: null, text },
        startIndex: start,
        endIndex: end,
      });
      continue;
    }

    if ((style.indentStart?.magnitude ?? 0) >= QUOTE_INDENT_PT) {
      out.push({ block: { kind: 'blockquote', spans }, startIndex: start, endIndex: end });
      continue;
    }

    out.push({ block: { kind: 'paragraph', spans }, startIndex: start, endIndex: end });
  }

  // Coalesce adjacent code lines (UCANON-2/3), merging their ranges.
  const result: ReadBlock[] = [];
  for (const rb of out) {
    const prev = result[result.length - 1];
    if (rb.block.kind === 'code' && prev?.block.kind === 'code') {
      const merged = coalesceCodeBlocks([prev.block, rb.block]);
      if (merged.length === 1) {
        prev.block = merged[0]!;
        prev.endIndex = rb.endIndex;
        continue;
      }
    }
    result.push(rb);
  }
  return result;
}
