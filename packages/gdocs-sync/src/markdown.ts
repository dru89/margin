/**
 * Markdown side of the canonical form: GFM via mdast, dialect pinned
 * per UMD-1..4 (no smart punctuation — the author's characters reach
 * the doc verbatim), gpush comment-section stripping per UMISC-1,
 * frontmatter contract per doc-tools conventions.md.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import type {
  BlockContent,
  DefinitionContent,
  List,
  PhrasingContent,
  Root,
  RootContent,
  TableCell,
} from 'mdast';
import type { CanonicalBlock, InlineSpan, ListItem } from './blocks.ts';

const COMMENTS_START = '<!-- gpush:comments-start -->';

/**
 * UMISC-1: strip the fetched-comments section (start marker → EOF)
 * before any parse/push, so comments never round-trip into content.
 */
export function stripCommentsSection(markdown: string): string {
  const at = markdown.indexOf(COMMENTS_START);
  if (at === -1) return markdown;
  return markdown.slice(0, at).replace(/\n+$/, '\n');
}

export interface Frontmatter {
  title?: string;
  subtitle?: string;
  author?: string;
  /** All authors when the file carries a YAML list. */
  authors?: string[];
  authorEmail?: string;
  date?: string;
  /** Link-offer signal on import; Margin never writes it. */
  url?: string;
}

/** One frontmatter entry, raw lines kept verbatim for preservation. */
export interface FrontmatterEntry {
  key: string;
  lines: string[];
}

const CONTRACT_KEYS: Record<string, keyof Frontmatter> = {
  title: 'title',
  subtitle: 'subtitle',
  author: 'author',
  'author-email': 'authorEmail',
  date: 'date',
  url: 'url',
};

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '');
}

/**
 * Split leading YAML frontmatter. Contract keys parse (including
 * folded/literal block scalars and YAML-list authors, issue #20);
 * EVERY entry — known or unknown — is preserved verbatim in `entries`
 * so fetch-over-a-richer-file never drops keys.
 */
export function splitFrontmatter(markdown: string): {
  meta: Frontmatter;
  body: string;
  entries: FrontmatterEntry[];
} {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(markdown);
  if (!m) return { meta: {}, body: markdown, entries: [] };
  const meta: Frontmatter = {};
  const entries: FrontmatterEntry[] = [];
  const lines = m[1]!.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    const key = kv[1]!;
    const inline = kv[2]!.trim();
    const entry: FrontmatterEntry = { key, lines: [lines[i]!] };
    // Consume continuation lines: block scalars (`>` / `|`) and list
    // items — anything indented or a `- ` item belongs to this entry.
    const continuation: string[] = [];
    while (i + 1 < lines.length && /^(\s+\S|\s*-\s)/.test(lines[i + 1]!)) {
      i++;
      entry.lines.push(lines[i]!);
      continuation.push(lines[i]!.trim());
    }
    entries.push(entry);

    const contract = CONTRACT_KEYS[key];
    if (!contract) continue;
    let value: string;
    if (inline === '>' || inline === '|') {
      // Folded scalars join with spaces; literal scalars keep newlines.
      value = continuation.filter((l) => !l.startsWith('- ')).join(inline === '>' ? ' ' : '\n');
    } else if (inline === '' && continuation.some((l) => l.startsWith('- '))) {
      // YAML list (authors): first item is the value; keep the rest.
      const items = continuation.filter((l) => l.startsWith('- ')).map((l) => unquote(l.slice(2)));
      if (contract === 'author') meta.authors = items;
      value = items[0] ?? '';
    } else {
      value = unquote(inline);
    }
    if (value !== '') meta[contract] = value as never;
  }
  return { meta, body: markdown.slice(m[0].length), entries };
}

function spansOf(nodes: PhrasingContent[], inherit: Partial<InlineSpan> = {}): InlineSpan[] {
  const out: InlineSpan[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push({ ...inherit, text: node.value });
        break;
      case 'inlineCode':
        // UREAD-4 mirror: code styling suppresses other formatting.
        out.push({ text: node.value, code: true });
        break;
      case 'strong':
        out.push(...spansOf(node.children, { ...inherit, bold: true }));
        break;
      case 'emphasis':
        out.push(...spansOf(node.children, { ...inherit, italic: true }));
        break;
      case 'delete':
        out.push(...spansOf(node.children, { ...inherit, strike: true }));
        break;
      case 'link':
        out.push(...spansOf(node.children, { ...inherit, link: node.url }));
        break;
      case 'break':
        out.push({ ...inherit, text: '\n' });
        break;
      case 'image':
        // Mixed-in images become image spans (issue #23); one U+FFFC
        // unit of text keeps indices honest on both sides.
        out.push({ text: '\uFFFC', image: { src: node.url, alt: node.alt ?? '' } });
        break;
      default:
        // html, footnotes, etc.: flatten to their text if any.
        if ('value' in node && typeof node.value === 'string') {
          out.push({ ...inherit, text: node.value });
        }
    }
  }
  return out;
}

function listItems(list: List, depth: number): ListItem[] {
  const items: ListItem[] = [];
  for (const item of list.children) {
    const paragraphs: PhrasingContent[] = [];
    const nested: List[] = [];
    for (const child of item.children as (BlockContent | DefinitionContent)[]) {
      if (child.type === 'paragraph') paragraphs.push(...child.children);
      else if (child.type === 'list') nested.push(child);
    }
    items.push({
      depth,
      ordered: !!list.ordered,
      checked: item.checked ?? undefined,
      spans: spansOf(paragraphs),
    });
    for (const sub of nested) items.push(...listItems(sub, depth + 1));
  }
  return items;
}

import { calloutType as calloutTypeOf } from './styles.ts';

function nodesToBlocks(nodes: RootContent[]): CanonicalBlock[] {
  return convertNodes(nodes);
}

/** Parse markdown (frontmatter and gpush section already handled by caller). */
export function markdownToBlocks(body: string): CanonicalBlock[] {
  const tree: Root = fromMarkdown(body, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  return convertNodes(tree.children as RootContent[]);
}

function convertNodes(nodes: RootContent[]): CanonicalBlock[] {
  const blocks: CanonicalBlock[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'heading':
        blocks.push({ kind: 'heading', level: node.depth, spans: spansOf(node.children) });
        break;
      case 'paragraph': {
        // Figure / inline / empty-alt trichotomy (lesson 8, UIMG-2).
        const kids = node.children;
        if (kids.length === 1 && kids[0]!.type === 'image') {
          const img = kids[0]!;
          blocks.push({
            kind: 'image',
            alt: img.alt ?? '',
            src: img.url,
            figure: (img.alt ?? '') !== '',
          });
        } else {
          blocks.push({ kind: 'paragraph', spans: spansOf(kids) });
        }
        break;
      }
      case 'code':
        blocks.push({ kind: 'code', lang: node.lang ?? null, text: node.value });
        break;
      case 'list':
        blocks.push({ kind: 'list', items: listItems(node, 0), loose: node.spread === true });
        break;
      case 'table':
        blocks.push({
          kind: 'table',
          rows: node.children.map((row) => row.children.map((cell: TableCell) => spansOf(cell.children))),
        });
        break;
      case 'blockquote': {
        const callout = calloutFrom(node);
        if (callout) {
          blocks.push(callout);
          break;
        }
        const spans: InlineSpan[] = [];
        for (const child of node.children) {
          if (child.type === 'paragraph') {
            if (spans.length > 0) spans.push({ text: '\n' });
            spans.push(...spansOf(child.children));
          }
        }
        blocks.push({ kind: 'blockquote', spans });
        break;
      }
      case 'thematicBreak':
        blocks.push({ kind: 'hr' });
        break;
      default:
        break; // html comments, definitions — no doc representation yet
    }
  }
  return blocks;
}

/**
 * Callout detection (issue #40): a blockquote whose FIRST paragraph's
 * FIRST LINE is `[!type]` or `[!type] Title` (Obsidian/GFM alerts).
 * `[!x]` anywhere else stays a plain blockquote. Body children convert
 * through the normal block pipeline — paragraphs, code, lists all work;
 * tables/images/nested callouts are rejected back to a plain quote.
 */
function calloutFrom(node: import('mdast').Blockquote): CanonicalBlock | null {
  const first = node.children[0];
  if (first?.type !== 'paragraph') return null;
  const spans = spansOf(first.children);
  const firstText = spans[0]?.text ?? '';
  const m = /^\[!([A-Za-z-]+)\]([^\n]*)(\n?)/.exec(firstText);
  if (!m) return null;

  // Split the first paragraph: marker line → type/title; rest → body.
  const titleAndRest: InlineSpan[] = [
    ...(m[2] || m[3] ? [{ ...spans[0]!, text: (m[2] ?? '') + (m[3] ?? '') + firstText.slice(m[0].length) }] : []),
    ...spans.slice(1),
  ];
  const title: InlineSpan[] = [];
  const firstBody: InlineSpan[] = [];
  let inBody = false;
  for (const span of titleAndRest) {
    if (inBody) {
      firstBody.push(span);
      continue;
    }
    const nl = span.text.indexOf('\n');
    if (nl === -1) {
      title.push(span);
    } else {
      if (nl > 0) title.push({ ...span, text: span.text.slice(0, nl) });
      const rest = span.text.slice(nl + 1);
      if (rest) firstBody.push({ ...span, text: rest });
      inBody = true;
    }
  }
  const trimmedTitle = trimSpans(title);

  const body: CanonicalBlock[] = [];
  if (firstBody.length > 0) body.push({ kind: 'paragraph', spans: firstBody });
  for (const child of node.children.slice(1)) {
    // Reuse the block pipeline on the remaining children.
    const converted = nodesToBlocks([child]);
    for (const b of converted) {
      if (b.kind === 'table' || b.kind === 'image' || b.kind === 'callout') return null; // stay a quote
      body.push(b);
    }
  }
  return { kind: 'callout', type: calloutTypeOf(m[1]!), title: trimmedTitle, body };
}

function trimSpans(spans: InlineSpan[]): InlineSpan[] {
  const out = spans.map((s) => ({ ...s }));
  if (out[0]) out[0].text = out[0].text.replace(/^\s+/, '');
  const last = out[out.length - 1];
  if (last) last.text = last.text.replace(/\s+$/, '');
  return out.filter((s) => s.text !== '');
}
