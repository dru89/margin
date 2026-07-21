import { describe, expect, it } from 'vitest';
import { identity } from '../src/blocks.ts';
import { restyleRequests } from '../src/builder.ts';
import { diffBlocks } from '../src/differ.ts';
import { FakeDocsClient, type GDocDocument } from '../src/gdoc.ts';
import { markdownToBlocks } from '../src/markdown.ts';
import { serializeBlocks } from '../src/serialize.ts';
import { updateFromMarkdown } from '../src/sync.ts';

type Req = Record<string, any>;

// The probe sentence: every inline boundary class in one range.
const MIXED = 'This is **bold** and *italics* and `inline code` and ***bold/italics*** together.\n';
const PLAIN = 'This is bold and italics and inline code and bold/italics together.\n';

describe('mixed inline boundaries (the probe sentence)', () => {
  it('parses, serializes, and re-parses identity-equal', () => {
    const blocks = markdownToBlocks(MIXED);
    expect(blocks).toHaveLength(1);
    const reparsed = markdownToBlocks(serializeBlocks(blocks));
    expect(reparsed.map(identity)).toEqual(blocks.map(identity));
    // Identity is the plain text — styling excluded (UDIFF-7).
    expect(identity(blocks[0]!)).toBe(identity(markdownToBlocks(PLAIN)[0]!));
  });

  it('restyleRequests emits correct ranges for every span', () => {
    const [block] = markdownToBlocks(MIXED);
    const requests = restyleRequests(block!, 10) as Req[];
    // Base reset first, then one request per styled span.
    expect(requests[0]!.updateTextStyle.range).toEqual({ startIndex: 10, endIndex: 10 + 'This is bold and italics and inline code and bold/italics together.'.length });
    const text = 'This is bold and italics and inline code and bold/italics together.';
    const at = (needle: string) => 10 + text.indexOf(needle);
    const styled = requests.slice(1).map((r) => r.updateTextStyle);
    const find = (needle: string) => styled.find((s) => s.range.startIndex === at(needle));
    expect(find('bold and')!.textStyle.bold).toBe(true);
    expect(find('italics and')!.textStyle.italic).toBe(true);
    expect(find('inline code')!.fields).toContain('weightedFontFamily'); // code look
    const both = find('bold/italics')!;
    expect(both.textStyle.bold).toBe(true);
    expect(both.textStyle.italic).toBe(true);
  });
});

describe('restyle op — styling-only changes patch in place', () => {
  it('differ: equal text with different spans → restyle, not keep or rebuild', () => {
    const ops = diffBlocks(markdownToBlocks(PLAIN), markdownToBlocks(MIXED));
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe('restyle');
    // Identical styling stays a keep.
    expect(diffBlocks(markdownToBlocks(MIXED), markdownToBlocks(MIXED))[0]!.op).toBe('keep');
  });

  it('orchestrator: a styling-only edit sends zero deletes and zero inserts', async () => {
    const doc: GDocDocument = {
      revisionId: 'r1',
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 1 + PLAIN.length,
            paragraph: {
              elements: [{ textRun: { content: PLAIN } }],
              paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
            },
          },
        ],
      },
    };
    const client = new FakeDocsClient(doc);
    const plan = await updateFromMarkdown(client, 'fake', MIXED);
    expect(plan.regions).toBe(0);
    expect(plan.restyles).toBe(1);
    const flat = client.batches.flat() as Req[];
    expect(flat.some((r) => r.deleteContentRange)).toBe(false);
    expect(flat.some((r) => r.insertText)).toBe(false);
    expect(flat.filter((r) => r.updateTextStyle).length).toBeGreaterThan(2);
  });
});

describe('restyle op — lists and tables (issue #21)', () => {
  it('differ: styling-only list change → restyle; styling-only table change → restyle', () => {
    const plainList = markdownToBlocks('- alpha item\n- beta item\n');
    const styledList = markdownToBlocks('- alpha **item**\n- beta item\n');
    expect(diffBlocks(plainList, styledList).map((o) => o.op)).toEqual(['restyle']);

    const plainTable = markdownToBlocks('| H | I |\n| --- | --- |\n| aa | bb |\n');
    const styledTable = markdownToBlocks('| H | I |\n| --- | --- |\n| **aa** | bb |\n');
    expect(diffBlocks(plainTable, styledTable).map((o) => o.op)).toEqual(['restyle']);
    // Identical styling stays keep.
    expect(diffBlocks(styledTable, styledTable).map((o) => o.op)).toEqual(['keep']);
  });

  it('orchestrator: list restyle sends per-item style patches, no deletes/inserts', async () => {
    const listPara = (start: number, text: string, listId = 'kix.l1') => ({
      startIndex: start,
      endIndex: start + text.length + 1,
      paragraph: {
        elements: [{ textRun: { content: `${text}\n` } }],
        paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        bullet: { listId, nestingLevel: 0 },
      },
    });
    const doc: GDocDocument = {
      revisionId: 'r1',
      lists: { 'kix.l1': { listProperties: { nestingLevels: [{ glyphSymbol: '●', glyphType: 'GLYPH_TYPE_UNSPECIFIED' }] } } },
      body: { content: [listPara(1, 'alpha item'), listPara(12, 'beta item')] },
    };
    const client = new FakeDocsClient(doc);
    const plan = await updateFromMarkdown(client, 'fake', '- alpha **item**\n- beta item\n');
    expect(plan.restyles).toBe(1);
    expect(plan.regions).toBe(0);
    const flat = client.batches.flat() as Req[];
    expect(flat.some((r) => r.deleteContentRange || r.insertText)).toBe(false);
    // The bold patch targets 'item' within the first item's doc range.
    const bold = flat.find((r) => r.updateTextStyle?.textStyle?.bold)!;
    expect(bold.updateTextStyle.range).toEqual({ startIndex: 7, endIndex: 11 });
  });
});
