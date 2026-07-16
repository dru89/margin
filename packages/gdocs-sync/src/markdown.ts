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
  authorEmail?: string;
  date?: string;
  /** Link-offer signal on import; Margin never writes it. */
  url?: string;
}

/** Split leading YAML frontmatter; parse only the keys in the interop contract. */
export function splitFrontmatter(markdown: string): { meta: Frontmatter; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(markdown);
  if (!m) return { meta: {}, body: markdown };
  const meta: Frontmatter = {};
  const keys: Record<string, keyof Frontmatter> = {
    title: 'title',
    subtitle: 'subtitle',
    author: 'author',
    'author-email': 'authorEmail',
    date: 'date',
    url: 'url',
  };
  for (const line of m[1]!.split('\n')) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = keys[kv[1]!];
    if (!key) continue;
    // UMISC-5: quoted, single-quoted, and bare values all parse.
    meta[key] = kv[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: markdown.slice(m[0].length) };
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
        // Inline images are handled at block level for figures; mixed-in
        // images surface as a placeholder span so text indices stay sane.
        out.push({ ...inherit, text: '' });
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

/** Parse markdown (frontmatter and gpush section already handled by caller). */
export function markdownToBlocks(body: string): CanonicalBlock[] {
  const tree: Root = fromMarkdown(body, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const blocks: CanonicalBlock[] = [];
  for (const node of tree.children as RootContent[]) {
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
        blocks.push({ kind: 'list', items: listItems(node, 0) });
        break;
      case 'table':
        blocks.push({
          kind: 'table',
          rows: node.children.map((row) => row.children.map((cell: TableCell) => spansOf(cell.children))),
        });
        break;
      case 'blockquote': {
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
