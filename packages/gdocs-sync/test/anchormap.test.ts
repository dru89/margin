import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAnchorMap, mapRenderedQuote } from '../src/anchormap.ts';

const md = readFileSync(new URL('./fixtures/anchor-probes.md', import.meta.url), 'utf8');
const probes = JSON.parse(
  readFileSync(new URL('./fixtures/anchor-probes.json', import.meta.url), 'utf8'),
) as Record<string, { quotedText: string }>;

/** What the mapped source range must contain, per probe. */
const MUST_COVER: Record<string, string[]> = {
  A1: ['before **two bolded words** and'],
  A2: ['italic stre'], // range may start inside the * markers — valid source chars
  A3: ['run `gdocs push` to'],
  A4: ['the spec document]', 'for'],
  A5: ['has ~~struck out words~~ in'],
  A6: ['RETYPE THIS SENTENCE', 'It doesn\'t "just work" -- yet.'],
  A7: ['spanning selection.', 'Second short paragraph completing'],
  A8: ['with **style** inside'],
  A9: ['with bold text'], // quote also appears verbatim in the instruction bracket; first-occurrence policy matches there (documented limitation)
  A10: ['style** inside it', 'third'], // selection starts mid-bold-word: range begins inside the markers, which is valid source coverage
  A11: ['second numbered'],
  A12: ['completed task with'],
  A13: ['one sentence here.', 'And a second body'],
  A14: ['blockquote line for'],
  A15: ['Heading Probe'],
};

describe('mapRenderedQuote — all 15 fixture probes anchor (#28)', () => {
  for (const [id, expected] of Object.entries(MUST_COVER)) {
    it(`${id}: "${probes[id]!.quotedText.slice(0, 40)}…"`, () => {
      const range = mapRenderedQuote(md, probes[id]!.quotedText);
      expect(range, 'no match').not.toBeNull();
      const slice = md.slice(range!.from, range!.to);
      for (const part of expected) {
        expect(slice).toContain(part);
      }
    });
  }
});

describe('anchor map basics', () => {
  it('rendered stream strips syntax and joins blocks with newline', () => {
    const { rendered } = buildAnchorMap('# Head\n\npara with **bold** text\n\n- item one\n- item two\n');
    expect(rendered).toContain('Head\npara with bold text\nitem one\nitem two');
  });

  it('frontmatter offsets are compensated', () => {
    const doc = '---\ntitle: X\n---\n\nfind this phrase\n';
    const range = mapRenderedQuote(doc, 'find this phrase');
    expect(doc.slice(range!.from, range!.to)).toBe('find this phrase');
  });

  it('no match returns null; empty quote returns null', () => {
    expect(mapRenderedQuote('some text\n', 'absent')).toBeNull();
    expect(mapRenderedQuote('some text\n', '')).toBeNull();
  });
});
