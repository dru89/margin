/**
 * Rendered-text ↔ markdown-source offset mapping (issue #28).
 *
 * Google Docs comment quotes (`quotedFileContent`) are *rendered* text:
 * no `**`/`` ` ``/link syntax, no list/heading/quote markers, blocks
 * joined by a single '\n' (fixture ground truth, probes A7/A10/A13).
 * Margin's anchors are offsets into markdown *source*. This module
 * builds a segment map from mdast positions so a rendered quote
 * resolves to the source range whose rendering it is.
 *
 * Ground-truth-driven normalization (probe A6): UI autocorrect turns
 * straight quotes curly and `--` into an EN dash (U+2013), so a quote
 * variant with those substitutions reversed is tried when the literal
 * form misses. Multi-occurrence quotes anchor to the first match —
 * Drive provides no context or position to disambiguate with
 * (api-blocked anchor opacity); callers should present imported
 * anchors as "matched by text".
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import type { Nodes, Parent, Root } from 'mdast';
import { splitFrontmatter, stripCommentsSection } from './markdown.ts';

interface Segment {
  /** Range in the rendered stream. */
  renderedStart: number;
  renderedEnd: number;
  /** Source offset of the rendered range's first character; rendered
   * characters map 1:1 onto source from here (true for text/code
   * values). Join segments (synthetic '\n') set sourceStart = the
   * boundary offset and are non-linear. */
  sourceStart: number;
  sourceEnd: number;
  linear: boolean;
}

export interface AnchorMap {
  /** The document as Docs renders it (block texts joined by '\n'). */
  rendered: string;
  segments: Segment[];
}

/** Node types whose text content becomes rendered output. */
const TEXT_LEAVES = new Set(['text', 'inlineCode', 'code']);
/** Containers whose children each render as their own block line. */
const BLOCK_CONTAINERS = new Set([
  'root',
  'blockquote',
  'list',
  'listItem',
  'table',
  'tableRow',
]);

export function buildAnchorMap(markdown: string): AnchorMap {
  // Comments section is a tail, frontmatter a head; the body between
  // them is verbatim, so offsets from parsing it shift by the prefix.
  const { body } = splitFrontmatter(stripCommentsSection(markdown));
  const prefixLen = body === '' ? 0 : Math.max(markdown.indexOf(body), 0);

  const tree: Root = fromMarkdown(body, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });

  const segments: Segment[] = [];
  let rendered = '';

  const pushText = (value: string, sourceStart: number, sourceEnd: number, linear: boolean) => {
    if (value === '') return;
    segments.push({
      renderedStart: rendered.length,
      renderedEnd: rendered.length + value.length,
      sourceStart,
      sourceEnd,
      linear,
    });
    rendered += value;
  };

  const joinBoundary = (sourceOffset: number) => {
    if (rendered === '' || rendered.endsWith('\n')) return;
    pushText('\n', sourceOffset, sourceOffset, false);
  };

  const visit = (node: Nodes): void => {
    const start = (node.position?.start.offset ?? 0) + prefixLen;
    const end = (node.position?.end.offset ?? 0) + prefixLen;
    if (TEXT_LEAVES.has(node.type)) {
      const value = (node as { value: string }).value;
      if (node.type === 'inlineCode') {
        // Source spans the backticks; the value sits inside them and
        // maps 1:1 starting after the opening fence.
        const open = markdown.slice(start, end).indexOf(value);
        pushText(value, start + Math.max(open, 0), end, true);
      } else if (node.type === 'code') {
        joinBoundary(start);
        // Fenced block: the anchor covers the block; per-line source
        // accuracy is unnecessary.
        pushText(value, start, end, false);
      } else if (markdown.slice(start, end) === value) {
        // Soft breaks render as spaces in prose (same length — the
        // 1:1 positional mapping holds).
        pushText(value.replace(/\n/g, ' '), start, end, true);
      } else {
        // Value ≠ source slice: soft-wrapped text inside blockquotes/
        // callouts carries '> ' prefixes (and lists their indents) in
        // source but not in the value. Map line by line.
        let cursor = start;
        const lines = value.split('\n');
        for (const [i, line] of lines.entries()) {
          const at = line === '' ? cursor : markdown.indexOf(line, cursor);
          if (i > 0) pushText('\n', at === -1 ? cursor : at, at === -1 ? cursor : at, false);
          if (line === '') continue;
          if (at === -1) {
            pushText(line, cursor, end, false);
          } else {
            pushText(line, at, at + line.length, true);
            cursor = at + line.length;
          }
        }
      }
      return;
    }
    if (node.type === 'image') return; // no rendered text (U+FFFC in Docs)
    const children = (node as Parent).children ?? [];
    const isBlockContainer = BLOCK_CONTAINERS.has(node.type);
    for (const child of children) {
      // Each block-level child starts on its own rendered line.
      if (isBlockContainer || node.type === 'tableCell') joinBoundary((child.position?.start.offset ?? 0) + prefixLen);
      visit(child);
    }
  };
  visit(tree);

  return { rendered, segments };
}

/** Quote variants to try, literal first (probe A6 normalization). */
function variants(quote: string): string[] {
  const out = [quote];
  const normalized = quote
    .normalize('NFC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/—/g, '---')
    .replace(/–/g, '--')
    .replace(/\u000b/g, '\n')
    .replace(/ /g, ' ');
  if (normalized !== quote) out.push(normalized);
  return out;
}

function sourceOffsetAt(map: AnchorMap, renderedOffset: number, edge: 'start' | 'end'): number {
  for (const seg of map.segments) {
    if (renderedOffset >= seg.renderedStart && renderedOffset < seg.renderedEnd) {
      if (!seg.linear) return edge === 'start' ? seg.sourceStart : seg.sourceEnd;
      return seg.sourceStart + (renderedOffset - seg.renderedStart);
    }
  }
  const last = map.segments[map.segments.length - 1];
  return last ? last.sourceEnd : 0;
}

/**
 * Resolve a Docs-rendered quote to a markdown source range. Returns
 * null when no variant matches (caller falls back to orphaned import).
 */
export function mapRenderedQuote(
  markdown: string,
  quote: string,
): { from: number; to: number } | null {
  if (!quote) return null;
  const map = buildAnchorMap(markdown);
  for (const candidate of variants(quote)) {
    const at = map.rendered.indexOf(candidate);
    if (at === -1) continue;
    const from = sourceOffsetAt(map, at, 'start');
    const to = sourceOffsetAt(map, at + candidate.length - 1, 'end') + inc(map, at + candidate.length - 1);
    if (to > from) return { from, to };
  }
  return null;
}

/** Width of the source char at the rendered offset's segment (1 for linear). */
function inc(map: AnchorMap, renderedOffset: number): number {
  for (const seg of map.segments) {
    if (renderedOffset >= seg.renderedStart && renderedOffset < seg.renderedEnd) {
      return seg.linear ? 1 : 0;
    }
  }
  return 0;
}
