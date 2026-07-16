import { describe, expect, it } from 'vitest';
import { identity, type CanonicalBlock } from '../src/blocks.ts';
import { markdownToBlocks } from '../src/markdown.ts';
import { serializeBlocks } from '../src/serialize.ts';

/** The serializer's contract: re-parsing its output is identity-equal. */
function roundTrips(blocks: CanonicalBlock[]): void {
  const md = serializeBlocks(blocks);
  const reparsed = markdownToBlocks(md);
  expect(reparsed.map(identity)).toEqual(blocks.map(identity));
}

describe('serializer — round-trip property (fetch path)', () => {
  it('headings, paragraphs, inline styles, links', () => {
    roundTrips(
      markdownToBlocks(
        '# Title\n\n## Section\n\nPlain with **bold**, *italic*, ~~gone~~, `code`, and a [link](https://x.dev).\n',
      ),
    );
  });

  it('lists: unordered, ordered, nested, checkboxes', () => {
    roundTrips(markdownToBlocks('- a\n- b\n  - b1\n  - b2\n'));
    roundTrips(markdownToBlocks('1. one\n2. two\n'));
    roundTrips(markdownToBlocks('- [ ] open\n- [x] done\n'));
  });

  it('tables (escaped pipes survive)', () => {
    roundTrips(markdownToBlocks('| a | b |\n| --- | --- |\n| c\\|d | e |\n'));
  });

  it('code blocks with language, blockquotes, hr', () => {
    roundTrips(markdownToBlocks('```js\nconst x = 1;\nrun(x);\n```\n\n> wisdom\n\n---\n'));
  });

  it('images: figure, inline-empty-alt', () => {
    roundTrips(markdownToBlocks('![A caption](img.png)\n\n![](plain.png)\n'));
  });

  it('UREAD-5 hygiene: emphasis never wraps whitespace', () => {
    const md = serializeBlocks([
      { kind: 'paragraph', spans: [{ text: 'a ' }, { text: ' padded ', bold: true }, { text: ' z' }] },
    ]);
    // Whitespace lands outside the markers; total spacing is preserved.
    expect(md).toBe('a  **padded**  z\n');
    expect(md).not.toContain('** padded');
    expect(md).not.toContain('padded **');
  });

  it('special characters escape and survive', () => {
    roundTrips(markdownToBlocks('literal \\*stars\\* and \\[brackets\\] stay literal\n'));
  });

  it('the RT-1 corpus round-trips through serialize → parse', () => {
    const corpus =
      '# T\n\n## S\n\nPara with **b** and [l](https://e.co).\n\n- a\n- b\n  - c\n\n1. x\n2. y\n\n| h | i |\n| --- | --- |\n| 1 | 2 |\n\n```\ncode line\n```\n\n> quote\n';
    roundTrips(markdownToBlocks(corpus));
  });
});
