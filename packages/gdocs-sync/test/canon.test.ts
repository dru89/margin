import { describe, expect, it } from 'vitest';
import { coalesceCodeBlocks, identity, tableCanonical, type CanonicalBlock } from '../src/blocks.ts';
import { markdownToBlocks } from '../src/markdown.ts';

describe('UCANON — canonicalization parity', () => {
  it('UCANON-1: doc-side and md-side tables flatten to the identical canonical string', () => {
    const md = markdownToBlocks('| Name | Qty |\n| --- | --- |\n| apple | 3 |\n');
    expect(md).toHaveLength(1);
    const mdTable = md[0]!;
    if (mdTable.kind !== 'table') throw new Error('expected table');
    // Simulated doc-side read of the same table (different producer, extra whitespace).
    const docRows = [
      [[{ text: ' Name ' }], [{ text: 'Qty' }]],
      [[{ text: 'apple' }], [{ text: ' 3' }]],
    ];
    expect(tableCanonical(docRows)).toBe(tableCanonical(mdTable.rows));
  });

  it('UCANON-2: N consecutive code-styled one-line paragraphs coalesce into one block', () => {
    const docSide: CanonicalBlock[] = [
      { kind: 'code', lang: null, text: 'line one' },
      { kind: 'code', lang: null, text: 'line two' },
      { kind: 'code', lang: null, text: 'line three' },
    ];
    const coalesced = coalesceCodeBlocks(docSide);
    expect(coalesced).toHaveLength(1);
    const mdSide = markdownToBlocks('```\nline one\nline two\nline three\n```\n');
    expect(identity(coalesced[0]!)).toBe(identity(mdSide[0]!));
  });

  it('UCANON-3: coalescing stops at the first non-code paragraph', () => {
    const docSide: CanonicalBlock[] = [
      { kind: 'code', lang: null, text: 'a' },
      { kind: 'paragraph', spans: [{ text: 'prose' }] },
      { kind: 'code', lang: null, text: 'b' },
    ];
    expect(coalesceCodeBlocks(docSide)).toHaveLength(3);
  });
});

describe('UMD — dialect pinning (author characters reach the doc verbatim)', () => {
  const textOf = (md: string): string => {
    const blocks = markdownToBlocks(md);
    const b = blocks[0]!;
    if (b.kind !== 'paragraph') throw new Error('expected paragraph');
    return b.spans.map((s) => s.text).join('');
  };

  it('UMD-1: straight double quotes stay straight', () => {
    expect(textOf('She said "hello" to everyone.\n')).toBe('She said "hello" to everyone.');
  });
  it('UMD-2: apostrophes stay straight', () => {
    expect(textOf("It's Drew's doc.\n")).toBe("It's Drew's doc.");
  });
  it('UMD-3: -- stays two hyphens', () => {
    expect(textOf('前 -- 後\n')).toBe('前 -- 後');
  });
  it('UMD-4: ... stays three dots', () => {
    expect(textOf('Wait for it...\n')).toBe('Wait for it...');
  });
  it('lists parse without a preceding blank line (GFM)', () => {
    const blocks = markdownToBlocks('Some prose\n- item one\n- item two\n');
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'list']);
  });
});

describe('image trichotomy (lesson 8 / UIMG-2)', () => {
  it('image alone with alt text is a figure', () => {
    const [b] = markdownToBlocks('![A caption](img.png)\n');
    expect(b).toMatchObject({ kind: 'image', figure: true, alt: 'A caption' });
  });
  it('image alone with empty alt is a plain (non-figure) image', () => {
    const [b] = markdownToBlocks('![](img.png)\n');
    expect(b).toMatchObject({ kind: 'image', figure: false });
  });
  it('image mixed with text stays a paragraph', () => {
    const [b] = markdownToBlocks('before ![x](i.png) after\n');
    expect(b?.kind).toBe('paragraph');
  });
});

describe('wart fixes (issue #24)', () => {
  it('blank lines inside code blocks survive read-back coalescing', async () => {
    const { docToBlocks } = await import('../src/reader.ts');
    const codeLine = (start: number, text: string) => ({
      startIndex: start,
      endIndex: start + text.length + 1,
      paragraph: {
        elements: [{ textRun: { content: `${text}\n`, textStyle: { weightedFontFamily: { fontFamily: 'Roboto Mono' } } } }],
        paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
      },
    });
    const emptyPara = (start: number) => ({
      startIndex: start,
      endIndex: start + 1,
      paragraph: { elements: [{ textRun: { content: '\n' } }], paragraphStyle: { namedStyleType: 'NORMAL_TEXT' } },
    });
    const doc = { body: { content: [codeLine(1, 'first();'), emptyPara(10), codeLine(11, 'second();')] } };
    const blocks = docToBlocks(doc).map((r) => r.block);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'code', text: 'first();\n\nsecond();' });
  });

  it('adjacent indented paragraphs coalesce into one multi-paragraph blockquote', async () => {
    const { docToBlocks } = await import('../src/reader.ts');
    const quotePara = (start: number, text: string) => ({
      startIndex: start,
      endIndex: start + text.length + 1,
      paragraph: {
        elements: [{ textRun: { content: `${text}\n` } }],
        paragraphStyle: { namedStyleType: 'NORMAL_TEXT', indentStart: { magnitude: 36 } },
      },
    });
    const doc = { body: { content: [quotePara(1, 'first line'), quotePara(12, 'second line')] } };
    const blocks = docToBlocks(doc).map((r) => r.block);
    expect(blocks).toHaveLength(1);
    if (blocks[0]!.kind !== 'blockquote') throw new Error('expected blockquote');
    expect(blocks[0]!.spans.map((s) => s.text).join('')).toBe('first line\nsecond line');
    // Matches the md side: a multi-paragraph quote is one block there too.
    const md = markdownToBlocks('> first line\n> second line\n');
    expect(identity(blocks[0]!)).toBe(identity(md[0]!));
  });
});
