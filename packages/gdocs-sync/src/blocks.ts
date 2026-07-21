/**
 * The canonical block model — the comparison form both sides (markdown
 * AST and Docs read-back) flatten to. Lesson 5: identity is content,
 * not styling; canonicalization parity between the two producers is
 * what keeps RT-1 (the noop re-push) green.
 */

export interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
  /**
   * Rendered from a smart chip (person/date/rich-link) on read-back.
   * The text is the chip's display text so the diff sees what a human
   * sees (lesson 5 — invisible content gets destroyed). Not a style:
   * excluded from restyle signatures; serializes as plain text.
   */
  chip?: boolean;
}

export interface ListItem {
  /** 0-based nesting depth. */
  depth: number;
  ordered: boolean;
  checked?: boolean;
  spans: InlineSpan[];
}

export type CanonicalBlock =
  | { kind: 'heading'; level: number; spans: InlineSpan[] }
  | { kind: 'paragraph'; spans: InlineSpan[] }
  | { kind: 'code'; lang: string | null; text: string }
  | { kind: 'list'; items: ListItem[]; /** blank-line-separated items → roomier spacing */ loose?: boolean }
  | { kind: 'table'; rows: InlineSpan[][][] } // rows → cells → spans
  | { kind: 'blockquote'; spans: InlineSpan[] }
  | { kind: 'hr' }
  | { kind: 'image'; alt: string; src: string; /** figure = alone with alt */ figure: boolean };

export function spanText(spans: InlineSpan[]): string {
  return spans.map((s) => s.text).join('');
}

/** UCANON-1: one canonical string per table — per-cell text, stripped, newline-joined, row-major. */
export function tableCanonical(rows: InlineSpan[][][]): string {
  return rows.map((cells) => cells.map((c) => spanText(c).trim()).join('\n')).join('\n');
}

function listCanonical(items: ListItem[]): string {
  return items
    .map((i) => `${i.depth}:${i.ordered ? 'o' : 'u'}${i.checked === undefined ? '' : i.checked ? 'x' : ' '}:${spanText(i.spans).trim()}`)
    .join('\n');
}

/**
 * Block identity for diffing (UDIFF-6/7): type + heading level + plain
 * text. Inline styling and colors deliberately excluded so a decorative
 * pass doesn't diff every block as changed.
 */
export function identity(block: CanonicalBlock): string {
  switch (block.kind) {
    case 'heading':
      return `h${block.level}:${spanText(block.spans)}`;
    case 'paragraph':
      return `p:${spanText(block.spans)}`;
    case 'code':
      // lang excluded: the Doc has nowhere to store it, so including it
      // would break canonicalization parity on every read-back diff.
      return `c:${block.text}`;
    case 'list':
      return `l:${listCanonical(block.items)}`;
    case 'table':
      return `t:${tableCanonical(block.rows)}`;
    case 'blockquote':
      return `q:${spanText(block.spans)}`;
    case 'hr':
      return 'hr';
    case 'image':
      // src excluded: read-back yields Google's contentUri, not the md
      // source, so including it would churn every image on every diff.
      // Cost (documented): a src-only change doesn't diff — change the
      // alt/caption too, or force a rebuild.
      return `i:${block.alt}:${block.figure ? 'fig' : 'inline'}`;
  }
}

/**
 * UCANON-2/3: Docs stores each fenced-code line as its own paragraph.
 * Coalesce runs of adjacent code blocks (as produced by a doc-side
 * reader emitting one per line) into a single block; stop at the first
 * non-code block.
 */
export function coalesceCodeBlocks(blocks: CanonicalBlock[]): CanonicalBlock[] {
  const out: CanonicalBlock[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (b.kind === 'code' && prev?.kind === 'code' && prev.lang === b.lang) {
      out[out.length - 1] = { kind: 'code', lang: prev.lang, text: `${prev.text}\n${b.text}` };
    } else {
      out.push(b);
    }
  }
  return out;
}
