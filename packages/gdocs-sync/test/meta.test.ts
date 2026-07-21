import { describe, expect, it } from 'vitest';
import {
  buildMetaRequests,
  emitFrontmatter,
  mdToCanonicalWithMeta,
  metaEquals,
  parseDocMeta,
} from '../src/meta.ts';
import { FakeDocsClient, type GDocDocument } from '../src/gdoc.ts';
import { updateFromMarkdown } from '../src/sync.ts';

type Req = Record<string, any>;

describe('META — both entry paths agree', () => {
  it('META-1/2: frontmatter title and leading # both lift into meta; # wins', () => {
    expect(mdToCanonicalWithMeta('---\ntitle: From FM\n---\nbody\n').meta.title).toBe('From FM');
    const viaHash = mdToCanonicalWithMeta('# From Hash\n\nbody\n');
    expect(viaHash.meta.title).toBe('From Hash');
    expect(viaHash.blocks[0]?.kind).toBe('paragraph'); // heading consumed
    expect(mdToCanonicalWithMeta('---\ntitle: FM\n---\n# Hash\n\nbody\n').meta.title).toBe('Hash');
  });

  it('META-3..6: subtitle + chips emit in order with named styles; chip = 1 unit', () => {
    const { requests, length } = buildMetaRequests(
      { title: 'T', subtitle: 'Sub', author: 'Drew', authorEmail: 'drew@hays.fm', date: '2026-07-21' },
      1,
    ) as { requests: Req[]; length: number };
    const named = requests
      .filter((r) => r.updateParagraphStyle)
      .map((r) => r.updateParagraphStyle.paragraphStyle.namedStyleType);
    expect(named).toEqual(['TITLE', 'SUBTITLE', 'NORMAL_TEXT']);
    expect(requests.some((r) => r.insertPerson?.personProperties?.email === 'drew@hays.fm')).toBe(true);
    expect(requests.some((r) => r.insertDate?.dateElementProperties?.timestamp === '2026-07-21T12:00:00Z')).toBe(true);
    // 'T\n'(2) + 'Sub\n'(4) + chip line: person(1)+' · '(3)+date(1)+'\n'(1) = 6 → 12
    expect(length).toBe(12);
  });
});

const titlePara = (start: number, text: string, named: string) => ({
  startIndex: start,
  endIndex: start + text.length + 1,
  paragraph: {
    elements: [{ textRun: { content: `${text}\n` } }],
    paragraphStyle: { namedStyleType: named },
  },
});
const bodyPara = (start: number, text: string) => titlePara(start, text, 'NORMAL_TEXT');

describe('UCHIP — meta scanner + replace-never-append', () => {
  it('UCHIP-3: an orphaned date chip alone is recognized as meta', () => {
    const doc: GDocDocument = {
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 3,
            paragraph: {
              elements: [{ dateElement: {} } as never, { textRun: { content: '\n' } }],
              paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
            },
          },
          bodyPara(3, 'content'),
        ],
      },
    };
    const parsed = parseDocMeta(doc);
    expect(parsed.meta.hasDateChip).toBe(true);
    expect(parsed.consumedElements).toBe(1);
    expect(parsed.endIndex).toBe(3);
  });

  it('UCHIP-4: a table immediately after the title terminates the scanner', () => {
    const doc: GDocDocument = {
      body: {
        content: [
          titlePara(1, 'Title', 'TITLE'),
          { startIndex: 7, endIndex: 20, table: { rows: 1, columns: 1, tableRows: [] } },
        ],
      },
    };
    const parsed = parseDocMeta(doc);
    expect(parsed.meta.title).toBe('Title');
    expect(parsed.consumedElements).toBe(1);
  });

  it('UCHIP-1 (offline half): unchanged meta + unchanged content → zero writes', async () => {
    const doc: GDocDocument = {
      revisionId: 'r1',
      body: { content: [titlePara(1, 'My Doc', 'TITLE'), bodyPara(8, 'body text.')] },
    };
    const client = new FakeDocsClient(doc);
    const plan = await updateFromMarkdown(client, 'fake', '# My Doc\n\nbody text.\n');
    expect(plan.requestsSent).toBe(0);
    expect(client.batches).toHaveLength(0);
  });

  it('UCHIP-2: a changed title REPLACES the meta region — delete then rebuild, no append', async () => {
    const doc: GDocDocument = {
      revisionId: 'r1',
      body: { content: [titlePara(1, 'Old Title', 'TITLE'), bodyPara(11, 'body text.')] },
    };
    const client = new FakeDocsClient(doc);
    await updateFromMarkdown(client, 'fake', '# New Title\n\nbody text.\n');
    const flat = client.batches.flat() as Req[];
    const del = flat.find((r) => r.deleteContentRange);
    expect(del!.deleteContentRange.range).toEqual({ startIndex: 1, endIndex: 11 });
    const inserts = flat.filter((r) => r.insertText);
    expect(inserts.some((r) => r.insertText.text === 'New Title\n')).toBe(true);
    // No content-region rebuild: body text untouched.
    expect(inserts.some((r) => r.insertText.text?.includes('body text'))).toBe(false);
  });
});

describe('metaEquals + frontmatter emitter', () => {
  it('compares chips by presence/email, title/subtitle strictly', () => {
    expect(metaEquals({ title: 'T' }, { title: 'T' })).toBe(true);
    expect(metaEquals({ title: 'T' }, { title: 'Other' })).toBe(false);
    expect(metaEquals({ title: 'T', author: 'Drew' }, { title: 'T' })).toBe(false);
    expect(
      metaEquals(
        { title: 'T', author: 'Drew', authorEmail: 'a@b.c' },
        { title: 'T', hasAuthorChip: true, authorEmail: 'a@b.c' },
      ),
    ).toBe(true);
  });

  it('emits only present keys; empty meta emits nothing', () => {
    expect(emitFrontmatter({})).toBe('');
    expect(emitFrontmatter({ title: 'T', subtitle: 'S' })).toBe('---\ntitle: T\nsubtitle: S\n---\n\n');
  });
});
