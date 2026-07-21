/**
 * The document metadata block (UCHIP/META): frontmatter title/subtitle/
 * author/date rendered as a TITLE paragraph, SUBTITLE paragraph, and a
 * person + date smart-chip line. On update the existing block is found
 * and REPLACED, never appended — chips are invisible to a text diff
 * (lesson 5) and duplicate forever otherwise (UCHIP-*).
 *
 * Both entry paths agree (META-2): a leading `# H1` lifts into
 * meta.title exactly like frontmatter `title:`; the leading heading
 * wins when both exist. Fetch writes meta back as frontmatter —
 * SUBTITLE round-trips to `subtitle:`, not `##` (conventions).
 */
import type { CanonicalBlock } from './blocks.ts';
import type { GDocDocument, GDocRequest } from './gdoc.ts';
import { markdownToBlocks, splitFrontmatter, stripCommentsSection } from './markdown.ts';
import {
  SUBTITLE,
  SUBTITLE_SPACING,
  TITLE,
  TITLE_SPACING,
  spacingStyle,
  textStyleOf,
} from './styles.ts';

export interface DocMeta {
  title?: string;
  subtitle?: string;
  author?: string;
  /** All authors when known (YAML list in, multiple person chips out). */
  authors?: string[];
  authorEmail?: string;
  /** ISO 8601 date (YYYY-MM-DD accepted). */
  date?: string;
}

export function mdToCanonicalWithMeta(markdown: string): { meta: DocMeta; blocks: CanonicalBlock[] } {
  const { meta: fm, body } = splitFrontmatter(stripCommentsSection(markdown));
  const blocks = markdownToBlocks(body);
  const meta: DocMeta = {
    title: fm.title,
    subtitle: fm.subtitle,
    author: fm.author,
    authors: fm.authors,
    authorEmail: fm.authorEmail,
    date: fm.date,
  };
  const first = blocks[0];
  if (first?.kind === 'heading' && first.level === 1) {
    meta.title = first.spans.map((s) => s.text).join(''); // leading # wins
    blocks.shift();
  }
  for (const key of Object.keys(meta) as (keyof DocMeta)[]) {
    if (meta[key] === undefined || meta[key] === '') delete meta[key];
  }
  return { meta, blocks };
}

export function hasMeta(meta: DocMeta): boolean {
  return !!(meta.title || meta.subtitle || meta.author || meta.date);
}

/** Doc-side meta as read back: chip details are partially opaque. */
export interface ReadDocMeta extends DocMeta {
  hasAuthorChip?: boolean;
  hasDateChip?: boolean;
}

/**
 * Meta equality for the update diff: title/subtitle strict; chips
 * compared by presence + email when readable (a chip's rendered date
 * is not reliably recoverable, so date compares by presence).
 */
export function metaEquals(md: DocMeta, doc: ReadDocMeta): boolean {
  if ((md.title ?? '') !== (doc.title ?? '')) return false;
  if ((md.subtitle ?? '') !== (doc.subtitle ?? '')) return false;
  if (!!md.author !== !!doc.hasAuthorChip) return false;
  if (md.authorEmail && doc.authorEmail && md.authorEmail !== doc.authorEmail) return false;
  if (!!md.date !== !!doc.hasDateChip) return false;
  return true;
}

function chipTimestamp(date: string): string {
  // Accept YYYY-MM-DD or full ISO; the API wants ISO 8601 UTC.
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00Z` : date;
}

/** Requests for the meta block at `insertAt`; returns occupied length. */
export function buildMetaRequests(
  meta: DocMeta,
  insertAt: number,
): { requests: GDocRequest[]; length: number } {
  const requests: GDocRequest[] = [];
  let cursor = insertAt;

  const paragraph = (
    text: string,
    namedStyleType: string,
    look: Record<string, unknown>,
    spacing: Record<string, unknown>,
  ): void => {
    requests.push({ insertText: { location: { index: cursor }, text: `${text}\n` } });
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: cursor, endIndex: cursor + text.length + 1 },
        paragraphStyle: { namedStyleType, alignment: 'START', ...spacing },
        fields: 'namedStyleType,alignment,spaceAbove,spaceBelow',
      },
    });
    if (text.length > 0) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: cursor, endIndex: cursor + text.length },
          textStyle: look,
          fields: 'weightedFontFamily,fontSize' + ('foregroundColor' in look ? ',foregroundColor' : ''),
        },
      });
    }
    cursor += text.length + 1;
  };

  if (meta.title) paragraph(meta.title, 'TITLE', textStyleOf(TITLE), spacingStyle(TITLE_SPACING));
  if (meta.subtitle)
    paragraph(meta.subtitle, 'SUBTITLE', textStyleOf(SUBTITLE), spacingStyle(SUBTITLE_SPACING));

  if (meta.author || meta.date) {
    // Chip line: person chip and/or date chip, each one index unit.
    const lineStart = cursor;
    requests.push({ insertText: { location: { index: cursor }, text: '\n' } });
    let at = cursor;
    if (meta.author) {
      // API constraint: personProperties takes email only (a name is
      // rejected); Docs resolves the display name from the email.
      requests.push({
        insertPerson: {
          location: { index: at },
          personProperties: { email: meta.authorEmail ?? meta.author },
        },
      });
      at += 1;
    }
    if (meta.date) {
      if (meta.author) {
        requests.push({ insertText: { location: { index: at }, text: ' · ' } });
        at += 3;
      }
      requests.push({
        insertDate: {
          location: { index: at },
          dateElementProperties: { timestamp: chipTimestamp(meta.date) },
        },
      });
      at += 1;
    }
    cursor = at + 1; // + newline
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: lineStart, endIndex: cursor },
        paragraphStyle: {
          namedStyleType: 'NORMAL_TEXT',
          alignment: 'START',
          ...spacingStyle({ beforePt: 0, afterPt: 16 }),
        },
        fields: 'namedStyleType,alignment,spaceAbove,spaceBelow',
      },
    });
  }

  return { requests, length: cursor - insertAt };
}

/**
 * UCHIP scanner: parse the doc's leading meta region. Stops at the
 * first content paragraph or table (UCHIP-4 — a table right after the
 * title terminates the scan). Returns consumed element count and the
 * absolute end index of the region.
 */
export function parseDocMeta(doc: GDocDocument): {
  meta: ReadDocMeta;
  consumedElements: number;
  endIndex: number;
} {
  const meta: ReadDocMeta = {};
  const content = doc.body?.content ?? [];
  let consumed = 0;
  let endIndex = 1;

  for (const el of content) {
    if (el.table) break; // UCHIP-4
    const para = el.paragraph;
    if (!para) {
      // sectionBreak etc. — precedes everything in a Doc body; skip.
      consumed++;
      continue;
    }
    const named = para.paragraphStyle?.namedStyleType;
    const text = (para.elements ?? [])
      .map((e) => e.textRun?.content ?? '')
      .join('')
      .replace(/\n$/, '');
    const chips = (para.elements ?? []).filter(
      (e) => (e as { person?: unknown }).person || (e as { dateElement?: unknown }).dateElement,
    );

    if (named === 'TITLE' && meta.title === undefined) {
      meta.title = text;
    } else if (named === 'SUBTITLE' && meta.subtitle === undefined) {
      meta.subtitle = text;
    } else if (chips.length > 0 && text.trim().replace(/·/g, '') === '') {
      for (const chip of chips) {
        const person = (chip as { person?: { personProperties?: { email?: string; name?: string } } }).person;
        if (person) {
          meta.hasAuthorChip = true;
          const name = person.personProperties?.name ?? person.personProperties?.email;
          if (name) (meta.authors ??= []).push(name);
          if (!meta.author) {
            meta.author = name;
            meta.authorEmail = person.personProperties?.email;
          }
        }
        const dateEl = (chip as { dateElement?: { dateElementProperties?: { timestamp?: string } } })
          .dateElement;
        if (dateEl) {
          meta.hasDateChip = true;
          const ts = dateEl.dateElementProperties?.timestamp;
          if (ts) meta.date = ts.slice(0, 10);
        }
      }
    } else {
      break;
    }
    consumed++;
    endIndex = el.endIndex ?? endIndex;
  }
  return { meta, consumedElements: consumed, endIndex };
}

/**
 * Frontmatter emitter for the fetch path. With `preserve` (the target
 * file's existing entries from splitFrontmatter), contract keys are
 * updated in their original positions, unknown keys pass through
 * verbatim in order, and new contract keys append — fetch over a
 * richer file never drops anything (issue #20).
 */
export function emitFrontmatter(
  meta: ReadDocMeta,
  preserve?: import('./markdown.ts').FrontmatterEntry[],
): string {
  const contractLines = (key: string): string[] | null => {
    switch (key) {
      case 'title':
        return meta.title ? [`title: ${meta.title}`] : null;
      case 'subtitle':
        return meta.subtitle ? [`subtitle: ${meta.subtitle}`] : null;
      case 'author':
        if (meta.authors && meta.authors.length > 1)
          return ['author:', ...meta.authors.map((a) => `  - ${a}`)];
        return meta.author ? [`author: ${meta.author}`] : null;
      case 'author-email':
        return meta.authorEmail && meta.authorEmail !== meta.author
          ? [`author-email: ${meta.authorEmail}`]
          : null;
      case 'date':
        return meta.date ? [`date: ${meta.date}`] : null;
      default:
        return null;
    }
  };
  const CONTRACT = ['title', 'subtitle', 'author', 'author-email', 'date'];
  const lines: string[] = [];
  const emitted = new Set<string>();

  for (const entry of preserve ?? []) {
    if (CONTRACT.includes(entry.key)) {
      if (emitted.has(entry.key)) continue;
      emitted.add(entry.key);
      const updated = contractLines(entry.key);
      if (updated) lines.push(...updated);
      // Contract key absent from the doc → dropped (doc is the source
      // of truth for its own meta on fetch).
    } else {
      lines.push(...entry.lines); // unknown keys verbatim, in order
    }
  }
  for (const key of CONTRACT) {
    if (emitted.has(key)) continue;
    const fresh = contractLines(key);
    if (fresh) lines.push(...fresh);
  }
  if (lines.length === 0) return '';
  return `---\n${lines.join('\n')}\n---\n\n`;
}
