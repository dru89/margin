import { describe, expect, it } from 'vitest';
import { identity } from '../src/blocks.ts';
import { diffBlocks } from '../src/differ.ts';
import { docToBlocks } from '../src/reader.ts';
import { markdownToBlocks } from '../src/markdown.ts';
import type { GDocDocument } from '../src/gdoc.ts';

/** Body paragraph: "Ship by " + [date chip "Jul 21, 2026"] + " says " + [person chip "Drew Hays"]. */
function chipDoc(): GDocDocument {
  return {
    body: {
      content: [
        {
          startIndex: 1,
          endIndex: 40,
          paragraph: {
            elements: [
              { textRun: { content: 'Ship by ' } },
              { dateElement: { dateElementProperties: { timestamp: '2026-07-21T12:00:00Z', displayText: 'Jul 21, 2026' } } },
              { textRun: { content: ' says ' } },
              { person: { personProperties: { name: 'Drew Hays', email: 'drew@hays.fm' } } },
              { textRun: { content: '\n' } },
            ],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          },
        },
      ],
    },
  };
}

describe('body-content smart chips read as text (issue #19)', () => {
  it('UREAD-9: chips render their display text into spans, marked chip', () => {
    const [rb] = docToBlocks(chipDoc());
    if (rb!.block.kind !== 'paragraph') throw new Error('expected paragraph');
    const spans = rb!.block.spans;
    expect(spans.map((s) => s.text).join('')).toBe('Ship by Jul 21, 2026 says Drew Hays');
    expect(spans.find((s) => s.text === 'Jul 21, 2026')!.chip).toBe(true);
    expect(spans.find((s) => s.text === 'Drew Hays')!.chip).toBe(true);
    // Chip spans never merge into plain neighbors (flag would be lost).
    expect(spans.length).toBeGreaterThanOrEqual(4);
  });

  it('the deletion trap is closed: a chip paragraph diffs as KEEP against its rendered text', () => {
    const docBlocks = docToBlocks(chipDoc()).map((r) => r.block);
    // What a fetch produces / what the user's markdown says after a pull:
    const mdBlocks = markdownToBlocks('Ship by Jul 21, 2026 says Drew Hays\n');
    expect(identity(docBlocks[0]!)).toBe(identity(mdBlocks[0]!));
    const ops = diffBlocks(docBlocks, mdBlocks);
    // KEEP — not delete+insert (which would destroy the chips), and
    // not restyle (chip-ness is not a style difference).
    expect(ops.map((o) => o.op)).toEqual(['keep']);
  });

  it('rich links round-trip as markdown links', () => {
    const doc: GDocDocument = {
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 20,
            paragraph: {
              elements: [
                { textRun: { content: 'see ' } },
                { richLink: { richLinkProperties: { title: 'The Spec', uri: 'https://x.dev/spec' } } },
                { textRun: { content: '\n' } },
              ],
              paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
            },
          },
        ],
      },
    };
    const [rb] = docToBlocks(doc);
    if (rb!.block.kind !== 'paragraph') throw new Error('expected paragraph');
    const linkSpan = rb!.block.spans.find((s) => s.link);
    expect(linkSpan).toMatchObject({ text: 'The Spec', link: 'https://x.dev/spec', chip: true });
    // A markdown link with the same text+url diffs as keep.
    const md = markdownToBlocks('see [The Spec](https://x.dev/spec)\n');
    expect(diffBlocks([rb!.block], md).map((o) => o.op)).toEqual(['keep']);
  });
});
