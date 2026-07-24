import { describe, expect, it } from 'vitest';
import type { CanonicalBlock } from '../src/blocks.ts';
import { buildSegment } from '../src/builder.ts';

const p = (text: string, spans?: CanonicalBlock & { kind: 'paragraph' }): CanonicalBlock => ({
  kind: 'paragraph',
  spans: [{ text }],
});

type Req = Record<string, any>;

describe('UBUILD — request builder', () => {
  it('UBUILD-1/2: bold and italic updateTextStyle come after the base reset', () => {
    const blocks: CanonicalBlock[] = [
      { kind: 'paragraph', spans: [{ text: 'plain ' }, { text: 'bold', bold: true }, { text: ' and ' }, { text: 'it', italic: true }] },
    ];
    const { requests } = buildSegment(blocks, 1) as { requests: Req[] };
    const textStyles = requests.filter((r) => r.updateTextStyle);
    // First text-style request is the full reset (base), inline styles follow.
    expect(textStyles[0]!.updateTextStyle.fields).toContain('weightedFontFamily');
    const boldIdx = textStyles.findIndex((r) => r.updateTextStyle.textStyle?.bold);
    const italicIdx = textStyles.findIndex((r) => r.updateTextStyle.textStyle?.italic);
    expect(boldIdx).toBeGreaterThan(0);
    expect(italicIdx).toBeGreaterThan(0);
  });

  it('UBUILD-3: link URLs ride in the inline phase with correct ranges', () => {
    const blocks: CanonicalBlock[] = [
      { kind: 'paragraph', spans: [{ text: 'see ' }, { text: 'the docs', link: 'https://example.com' }] },
    ];
    const { requests } = buildSegment(blocks, 1) as { requests: Req[] };
    const link = requests.find((r) => r.updateTextStyle?.textStyle?.link);
    expect(link!.updateTextStyle.textStyle.link.url).toBe('https://example.com');
    // 'see ' is 4 chars starting at index 1 → link range [5, 13).
    expect(link!.updateTextStyle.range).toEqual({ startIndex: 5, endIndex: 13 });
  });

  it('UBUILD-4: a document ending in a deeply nested list emits in-bounds style requests', () => {
    const blocks: CanonicalBlock[] = [
      { kind: 'paragraph', spans: [{ text: 'intro' }] },
      {
        kind: 'list',
        items: [
          { depth: 0, ordered: false, spans: [{ text: 'top' }] },
          { depth: 1, ordered: false, spans: [{ text: 'mid', bold: true }] },
          { depth: 2, ordered: false, spans: [{ text: 'deep' }] },
        ],
      },
    ];
    const { requests, insertedLength } = buildSegment(blocks, 1) as {
      requests: Req[];
      insertedLength: number;
    };
    const docEnd = 1 + insertedLength; // post-bullet-tab-removal bound
    for (const r of requests) {
      const range = r.updateParagraphStyle?.range ?? r.updateTextStyle?.range;
      if (!range) continue;
      expect(range.startIndex).toBeGreaterThanOrEqual(1);
      expect(range.endIndex).toBeLessThanOrEqual(docEnd);
      expect(range.endIndex).toBeGreaterThan(range.startIndex);
    }
    // Three nesting tabs (0+1+2) must have been subtracted from the length.
    const rawLength = 'intro\n'.length + 'top\n'.length + '\tmid\n'.length + '\t\tdeep\n'.length;
    expect(insertedLength).toBe(rawLength - 3);
  });

  it('UBUILD-5: every emitted paragraph carries explicit named style and alignment', () => {
    const blocks: CanonicalBlock[] = [
      { kind: 'heading', level: 1, spans: [{ text: 'Title' }] },
      { kind: 'heading', level: 2, spans: [{ text: 'Section' }] },
      p('body'),
      { kind: 'code', lang: 'js', text: 'x()' },
      { kind: 'blockquote', spans: [{ text: 'quoted' }] },
      { kind: 'hr' },
    ];
    const { requests } = buildSegment(blocks, 1) as { requests: Req[] };
    // Spacing-patch requests (block-edge gaps) ride alongside; the
    // per-block style request is the one carrying namedStyleType.
    const paraStyles = requests.filter((r) =>
      r.updateParagraphStyle?.fields.includes('namedStyleType'),
    );
    expect(paraStyles).toHaveLength(blocks.length);
    for (const r of paraStyles) {
      expect(r.updateParagraphStyle.fields).toContain('alignment');
      expect(r.updateParagraphStyle.paragraphStyle.alignment).toBe('START');
    }
    // Conventions: -1 shift. # → TITLE, ## → HEADING_1.
    expect(paraStyles[0]!.updateParagraphStyle.paragraphStyle.namedStyleType).toBe('TITLE');
    expect(paraStyles[1]!.updateParagraphStyle.paragraphStyle.namedStyleType).toBe('HEADING_1');
    // Inherited-bullet clearing across the whole range (lesson 4).
    expect(requests.some((r) => r.deleteParagraphBullets)).toBe(true);
  });

  it('phase ordering: inserts → bullets → paragraph styles → text styles', () => {
    const blocks: CanonicalBlock[] = [
      p('a'),
      { kind: 'list', items: [{ depth: 0, ordered: true, spans: [{ text: 'one', bold: true }] }] },
    ];
    const { requests } = buildSegment(blocks, 1) as { requests: Req[] };
    const phase = (r: Req): number =>
      r.insertText ? 0 : r.deleteParagraphBullets || r.createParagraphBullets ? 1 : r.updateParagraphStyle ? 2 : 3;
    const phases = requests.map(phase);
    expect([...phases].sort((a, b) => a - b)).toEqual(phases);
  });
});

describe('after-table spacing floor (showcase-doc bug, 2026-07-29)', () => {
  it('a heading after a table keeps its own larger before-spacing', async () => {
    const { buildSegment } = await import('../src/builder.ts');
    const seg = buildSegment(
      [{ kind: 'heading', level: 2, spans: [{ text: 'After the table' }] }],
      1,
      { leadingSpaceAbovePt: 10 },
    );
    const spaceReqs = seg.requests.filter(
      (r: any) => r.updateParagraphStyle?.paragraphStyle?.spaceAbove,
    ) as any[];
    const magnitudes = spaceReqs.map((r) => r.updateParagraphStyle.paragraphStyle.spaceAbove.magnitude);
    expect(Math.max(...magnitudes)).toBe(20); // h1 natural 20 > gap 10
  });

  it('a paragraph after a table gets the 10pt gap', async () => {
    const { buildSegment } = await import('../src/builder.ts');
    const seg = buildSegment([{ kind: 'paragraph', spans: [{ text: 'x' }] }], 1, {
      leadingSpaceAbovePt: 10,
    });
    const magnitudes = (seg.requests as any[])
      .filter((r) => r.updateParagraphStyle?.paragraphStyle?.spaceAbove)
      .map((r) => r.updateParagraphStyle.paragraphStyle.spaceAbove.magnitude);
    expect(Math.max(...magnitudes)).toBe(10);
  });
});
