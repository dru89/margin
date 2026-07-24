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

  it('foreign monospace fonts read as code, not prose', async () => {
    const { docToBlocks } = await import('../src/reader.ts');
    const para = (font: string) => ({
      startIndex: 1,
      endIndex: 9,
      paragraph: {
        elements: [{ textRun: { content: 'x = 1;\n', textStyle: { weightedFontFamily: { fontFamily: font } } } }],
        paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
      },
    });
    for (const font of ['Courier New', 'Consolas', 'Source Code Pro', 'Roboto Mono']) {
      const blocks = docToBlocks({ body: { content: [para(font)] } }).map((r) => r.block);
      expect(blocks[0], font).toMatchObject({ kind: 'code', text: 'x = 1;' });
    }
    // A proportional font stays prose.
    const blocks = docToBlocks({ body: { content: [para('Roboto')] } }).map((r) => r.block);
    expect(blocks[0]?.kind).toBe('paragraph');
  });

  it('24pt indent (reference-tool blockquotes) reads as a blockquote', async () => {
    const { docToBlocks } = await import('../src/reader.ts');
    const doc = {
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 8,
            paragraph: {
              elements: [{ textRun: { content: 'quoted\n' } }],
              paragraphStyle: { namedStyleType: 'NORMAL_TEXT', indentStart: { magnitude: 24 } },
            },
          },
        ],
      },
    };
    const blocks = docToBlocks(doc).map((r) => r.block);
    expect(blocks[0]?.kind).toBe('blockquote');
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
    // Two doc paragraphs = two quote paragraphs: '>' spacer form.
    // (Soft-wrapped '> a\n> b' is now ONE paragraph with a line break.)
    const md = markdownToBlocks('> first line\n>\n> second line\n');
    expect(identity(blocks[0]!)).toBe(identity(md[0]!));
  });
});

describe('soft line breaks (showcase-doc bugs, 2026-07-29)', () => {
  it('a hard-wrapped source paragraph is ONE paragraph with spaces', async () => {
    const { markdownToBlocks } = await import('../src/markdown.ts');
    const [p] = markdownToBlocks('This paragraph is\nwrapped across three\nsource lines.\n');
    if (p!.kind !== 'paragraph') throw new Error('expected paragraph');
    expect(p!.spans).toEqual([{ text: 'This paragraph is wrapped across three source lines.' }]);
  });

  it('wrapping survives inline styling mid-wrap', async () => {
    const { markdownToBlocks } = await import('../src/markdown.ts');
    const [p] = markdownToBlocks('before **bold\ncontinues** after\n');
    if (p!.kind !== 'paragraph') throw new Error('expected paragraph');
    expect(p!.spans.map((s) => s.text).join('')).toBe('before bold continues after');
  });

  it('blockquote and callout-body lines keep their line structure', async () => {
    const { markdownToBlocks } = await import('../src/markdown.ts');
    const [q] = markdownToBlocks('> line one\n> line two\n');
    if (q!.kind !== 'blockquote') throw new Error('expected quote');
    // Soft-wrapped quote lines are tight in-paragraph breaks (VT);
    // '\n' is reserved for real paragraph joins ('>' spacer lines).
    expect(q!.spans.map((s) => s.text).join('')).toBe('line one\u000bline two');
    const [q2] = markdownToBlocks('> para one\n>\n> para two\n');
    if (q2!.kind !== 'blockquote') throw new Error('expected quote');
    expect(q2!.spans.map((s) => s.text).join('')).toBe('para one\npara two');
    const [c] = markdownToBlocks('> [!note] T\n> body line one\n> body line two\n');
    if (c!.kind !== 'callout') throw new Error('expected callout');
    const body = c!.body[0];
    if (body!.kind !== 'paragraph') throw new Error('expected body paragraph');
    expect(body!.spans.map((s) => s.text).join('')).toBe('body line one\u000bbody line two');
  });
});


describe('hard line breaks (two trailing spaces)', () => {
  it('parse: hard break becomes an in-paragraph vertical tab', async () => {
    const { markdownToBlocks } = await import('../src/markdown.ts');
    const [p] = markdownToBlocks('line one  \nline two  \nline three\n');
    if (p!.kind !== 'paragraph') throw new Error('expected ONE paragraph');
    expect(p!.spans.map((s) => s.text).join('')).toBe('line one\u000bline two\u000bline three');
  });

  it('round-trip: vertical tab serializes back to a two-space hard break', async () => {
    const { markdownToBlocks } = await import('../src/markdown.ts');
    const { serializeBlocks } = await import('../src/serialize.ts');
    const md = 'line one  \nline two\n';
    const blocks = markdownToBlocks(md);
    const out = serializeBlocks(blocks);
    expect(out).toBe('line one  \nline two\n');
    expect(markdownToBlocks(out)).toEqual(blocks);
  });

  it('soft wrap and hard break coexist in one paragraph', async () => {
    const { markdownToBlocks } = await import('../src/markdown.ts');
    const [p] = markdownToBlocks('soft wrapped\nline then hard  \nbreak line\n');
    if (p!.kind !== 'paragraph') throw new Error('expected paragraph');
    expect(p!.spans.map((s) => s.text).join('')).toBe(
      'soft wrapped line then hard\u000bbreak line',
    );
  });
});
