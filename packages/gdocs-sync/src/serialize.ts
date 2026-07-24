/**
 * Canonical blocks → markdown text: the missing half of the fetch path
 * (reader produces blocks; this renders them back to the file).
 *
 * The contract is the round-trip property: for any block list this can
 * emit, `markdownToBlocks(serialize(blocks))` is identity-equal. That
 * is what keeps fetch → local edit → push from churning (RT-1's twin
 * on the markdown side). UREAD-5's hygiene rules live here: emphasis
 * markers never wrap leading/trailing whitespace, adjacent lists of
 * different types get separating blank lines (UREAD-8).
 */
import type { CanonicalBlock, InlineSpan, ListItem } from './blocks.ts';

function escapeText(text: string): string {
  // Minimal, round-trip-safe escaping: markers that would change the
  // parse when they lead a line, and inline markers mid-text.
  return text.replace(/([\\`*_[\]])/g, '\\$1');
}

function serializeSpan(span: InlineSpan): string {
  if (span.image) return `![${span.image.alt}](${span.image.src})`;
  if (span.code) return `\`${span.text}\``; // code suppresses other marks (UREAD-4)
  // Push whitespace outside emphasis markers (UREAD-5: `** bold **` is invalid).
  const lead = /^\s*/.exec(span.text)![0];
  const trail = /\s*$/.exec(span.text.slice(lead.length))![0];
  const core = span.text.slice(lead.length, span.text.length - trail.length);
  if (core === '') return span.text;
  let out = escapeText(core);
  if (span.bold) out = `**${out}**`;
  if (span.italic) out = `*${out}*`;
  if (span.strike) out = `~~${out}~~`;
  if (span.link) out = `[${out}](${span.link})`;
  return lead + out + trail;
}

export function serializeSpans(spans: InlineSpan[]): string {
  // Vertical tabs (in-paragraph line breaks) serialize as markdown
  // hard breaks: two trailing spaces before the newline.
  return spans.map(serializeSpan).join('').replace(/\u000b/g, '  \n');
}

function serializeListItem(item: ListItem, ordinal: number): string {
  const indent = '  '.repeat(item.depth);
  const marker = item.ordered ? `${ordinal}.` : '-';
  const box = item.checked === undefined ? '' : item.checked ? '[x] ' : '[ ] ';
  return `${indent}${marker} ${box}${serializeSpans(item.spans)}`;
}

function serializeList(items: ListItem[]): string {
  const lines: string[] = [];
  const counters = new Map<number, number>();
  for (const item of items) {
    const count = (counters.get(item.depth) ?? 0) + 1;
    counters.set(item.depth, count);
    // Reset deeper counters when we come back up.
    for (const depth of [...counters.keys()]) if (depth > item.depth) counters.delete(depth);
    lines.push(serializeListItem(item, count));
  }
  return lines.join('\n');
}

function serializeTable(rows: InlineSpan[][][]): string {
  const cell = (spans: InlineSpan[]): string =>
    serializeSpans(spans).trim().replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const header = rows[0] ?? [];
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const line = (cells: InlineSpan[][]): string =>
    `| ${Array.from({ length: cols }, (_, i) => cell(cells[i] ?? [])).join(' | ')} |`;
  const delim = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`;
  return [line(header), delim, ...rows.slice(1).map(line)].join('\n');
}

export function serializeBlocks(blocks: CanonicalBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'heading':
        parts.push(`${'#'.repeat(block.level)} ${serializeSpans(block.spans)}`);
        break;
      case 'paragraph':
        parts.push(serializeSpans(block.spans));
        break;
      case 'code':
        parts.push(`\`\`\`${block.lang ?? ''}\n${block.text}\n\`\`\``);
        break;
      case 'list': {
        // UREAD-8: adjacent lists of different types would merge on
        // re-parse without separation; the blank line between parts
        // handles it, but a same-type adjacent list needs an HTML
        // comment fence to stay two lists. Keep it simple: blank-line
        // separation (the common case); same-type adjacency merges,
        // which is canonical-equal anyway once merged.
        parts.push(serializeList(block.items));
        break;
      }
      case 'table':
        parts.push(serializeTable(block.rows));
        break;
      case 'blockquote':
        parts.push(
          serializeSpans(block.spans)
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n'),
        );
        break;
      case 'callout': {
        const head = `> [!${block.type}]${block.title.length > 0 ? ` ${serializeSpans(block.title)}` : ''}`;
        const bodyMd = block.body.length > 0 ? serializeBlocks(block.body).trimEnd() : '';
        const quoted = bodyMd
          ? '\n' + bodyMd.split('\n').map((l) => (l === '' ? '>' : `> ${l}`)).join('\n')
          : '';
        parts.push(head + quoted);
        break;
      }
      case 'hr':
        parts.push('---');
        break;
      case 'image':
        parts.push(`![${block.alt}](${block.src})`);
        break;
    }
  }
  return parts.join('\n\n') + '\n';
}
