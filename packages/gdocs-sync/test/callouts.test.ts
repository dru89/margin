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

  it('reader folds a 1×1 emoji table back into an identity-equal callout', () => {
    const para = (start: number, text: string, opts: { bold?: boolean; mono?: boolean } = {}) => ({
      startIndex: start,
      endIndex: start + text.length + 1,
      paragraph: {
        elements: [{ textRun: { content: `${text}\n`, textStyle: {
          ...(opts.bold ? { bold: true } : {}),
          ...(opts.mono ? { weightedFontFamily: { fontFamily: 'Roboto Mono' } } : {}),
        } } }],
        paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
      },
    });
    const doc: GDocDocument = {
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 60,
            table: {
              rows: 1,
              columns: 1,
              tableRows: [
                {
                  tableCells: [
                    {
                      content: [
                        // Title paragraph is emoji + bold chrome.
                        {
                          startIndex: 3, endIndex: 25,
                          paragraph: {
                            elements: [
                              { textRun: { content: '⚠️ ' } },
                              { textRun: { content: 'Deploy freeze\n', textStyle: { bold: true } } },
                            ],
                            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
                          },
                        },
                        para(25, 'No pushes after Friday.'),
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    };
    const [rb] = docToBlocks(doc);
    if (rb!.block.kind !== 'callout') throw new Error('expected callout');
    expect(rb!.block.type).toBe('warning');
    const mdSide = markdownToBlocks('> [!warning] Deploy freeze\n> No pushes after Friday.\n');
    expect(identity(rb!.block)).toBe(identity(mdSide[0]!));
  });
});
