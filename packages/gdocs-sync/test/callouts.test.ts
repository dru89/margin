import { describe, expect, it } from 'vitest';
import { identity, type CanonicalBlock } from '../src/blocks.ts';
import { markdownToBlocks } from '../src/markdown.ts';
import { serializeBlocks } from '../src/serialize.ts';
import { docToBlocks } from '../src/reader.ts';
import type { GDocDocument } from '../src/gdoc.ts';

const CALLOUT_MD = `> [!warning] Deploy **freeze** active
> No pushes after Friday.
>
> - check the calendar
> - ping the on-call
>
> \`\`\`sh
> kubectl get pods
> \`\`\`
`;

describe('callouts (issue #40) — parse', () => {
  it('parses type, styled title, and multi-block body (paragraphs, lists, code)', () => {
    const [b] = markdownToBlocks(CALLOUT_MD);
    if (b?.kind !== 'callout') throw new Error(`expected callout, got ${b?.kind}`);
    expect(b.type).toBe('warning');
    expect(b.title.map((s) => s.text).join('')).toBe('Deploy freeze active');
    expect(b.title.find((s) => s.text === 'freeze')!.bold).toBe(true);
    expect(b.body.map((x) => x.kind)).toEqual(['paragraph', 'list', 'code']);
  });

  it('aliases fold; GFM uppercase untitled form gets an empty title', () => {
    const [note] = markdownToBlocks('> [!NOTE]\n> Body only.\n');
    expect(note).toMatchObject({ kind: 'callout', type: 'info', title: [] });
    const [caution] = markdownToBlocks('> [!caution] Careful\n');
    expect(caution).toMatchObject({ kind: 'callout', type: 'danger' });
  });

  it('[!x] not at first-line position stays a blockquote; disallowed body types stay quotes', () => {
    expect(markdownToBlocks('> some text [!info] mid-line\n')[0]!.kind).toBe('blockquote');
    expect(markdownToBlocks('> body first\n> [!info] later\n')[0]!.kind).toBe('blockquote');
    const withTable = markdownToBlocks('> [!info] T\n>\n> | a | b |\n> | --- | --- |\n');
    expect(withTable[0]!.kind).toBe('blockquote');
  });
});

describe('callouts — round trip', () => {
  it('serialize → re-parse is identity-equal (title styling, body blocks, untitled form)', () => {
    for (const md of [CALLOUT_MD, '> [!NOTE]\n> Body only.\n', '> [!tip] Just a title\n']) {
      const blocks = markdownToBlocks(md);
      const reparsed = markdownToBlocks(serializeBlocks(blocks));
      expect(reparsed.map(identity)).toEqual(blocks.map(identity));
    }
  });

  it('reader folds a tinted 1×1 table (no emoji) back into an identity-equal callout', () => {
    const para = (start: number, text: string, opts: { bold?: boolean } = {}) => ({
      startIndex: start,
      endIndex: start + text.length + 1,
      paragraph: {
        elements: [{ textRun: { content: `${text}\n`, textStyle: opts.bold ? { bold: true } : {} } }],
        paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
      },
    });
    const tint = (hex: string) => {
      const n = parseInt(hex, 16);
      return {
        backgroundColor: {
          color: { rgbColor: { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 } },
        },
      };
    };
    const table = (cellStyle: object | undefined, cells: object[]) => ({
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 60,
            table: {
              rows: 1,
              columns: 1,
              tableRows: [
                { tableCells: [{ content: cells, ...(cellStyle ? { tableCellStyle: cellStyle } : {}) }] },
              ],
            },
          },
        ],
      },
    });

    // Warning tint + bold title + body → callout with title.
    const doc = table(tint('FEF7E0'), [
      para(3, 'Deploy freeze', { bold: true }),
      para(17, 'No pushes after Friday.'),
    ]) as GDocDocument;
    const [block] = docToBlocks(doc).map((r) => r.block);
    expect(block).toMatchObject({ kind: 'callout', type: 'warning' });
    if (block!.kind !== 'callout') throw new Error('expected callout');
    expect(block!.title.map((s) => s.text).join('')).toBe('Deploy freeze');
    expect(block!.title.every((s) => s.bold === undefined)).toBe(true);
    expect(block!.body[0]).toMatchObject({ kind: 'paragraph' });

    // The synthesized default title folds back to empty.
    const dflt = table(tint('E8F0FE'), [para(3, 'Info', { bold: true }), para(8, 'Body.')]) as GDocDocument;
    const [d] = docToBlocks(dflt).map((r) => r.block);
    expect(d).toMatchObject({ kind: 'callout', type: 'info', title: [] });

    // No tint background → plain table, not a callout.
    const plain = table(undefined, [para(3, 'Just a cell')]) as GDocDocument;
    const [t] = docToBlocks(plain).map((r) => r.block);
    expect(t?.kind).toBe('table');

    // Legacy emoji-era title text survives as literal title (no migration).
    const legacy = table(tint('FEF7E0'), [
      para(3, '⚠️ WARNING', { bold: true }),
      para(15, 'Old-doc body.'),
    ]) as GDocDocument;
    const [l] = docToBlocks(legacy).map((r) => r.block);
    if (l!.kind !== 'callout') throw new Error('expected callout');
    expect(l!.title.map((s) => s.text).join('')).toBe('⚠️ WARNING');
  });

});
