import { describe, expect, it } from 'vitest';
import type { CanonicalBlock } from '../src/blocks.ts';
import { diffBlocks } from '../src/differ.ts';
import { planRegions } from '../src/regions.ts';

const p = (text: string): CanonicalBlock => ({ kind: 'paragraph', spans: [{ text }] });
const h = (level: number, text: string): CanonicalBlock => ({ kind: 'heading', level, spans: [{ text }] });

describe('UDIFF — block diff planner', () => {
  it('UDIFF-1: identical lists → all KEEP', () => {
    const blocks = [h(1, 'Title'), p('one'), p('two')];
    const ops = diffBlocks(blocks, blocks);
    expect(ops.every((o) => o.op === 'keep')).toBe(true);
    expect(ops).toHaveLength(3);
  });

  it('UDIFF-2: append / prepend / delete / insert-in-middle are minimal', () => {
    const base = [p('a'), p('b'), p('c')];
    const cases: { next: CanonicalBlock[]; expected: string[] }[] = [
      { next: [p('a'), p('b'), p('c'), p('d')], expected: ['keep', 'keep', 'keep', 'insert'] },
      { next: [p('z'), p('a'), p('b'), p('c')], expected: ['insert', 'keep', 'keep', 'keep'] },
      { next: [p('a'), p('c')], expected: ['keep', 'delete', 'keep'] },
      { next: [p('a'), p('m'), p('b'), p('c')], expected: ['keep', 'insert', 'keep', 'keep'] },
    ];
    for (const { next, expected } of cases) {
      expect(diffBlocks(base, next).map((o) => o.op)).toEqual(expected);
    }
  });

  it('UDIFF-3: modified paragraph → single MODIFY for that block only', () => {
    const ops = diffBlocks([p('a'), p('b'), p('c')], [p('a'), p('b CHANGED'), p('c')]);
    expect(ops.map((o) => o.op)).toEqual(['keep', 'modify', 'keep']);
  });

  it('UDIFF-4: swapped paragraphs do not diff the whole document', () => {
    const ops = diffBlocks([p('a'), p('b'), p('c'), p('d')], [p('a'), p('c'), p('b'), p('d')]);
    const keeps = ops.filter((o) => o.op === 'keep').length;
    expect(keeps).toBeGreaterThanOrEqual(3);
  });

  it('UDIFF-5: degenerate cases produce sensible plans', () => {
    expect(diffBlocks([], [p('a')]).map((o) => o.op)).toEqual(['insert']);
    expect(diffBlocks([p('a')], []).map((o) => o.op)).toEqual(['delete']);
    const disjoint = diffBlocks([p('a'), p('b')], [p('x'), p('y')]);
    expect(disjoint.some((o) => o.op === 'keep')).toBe(false);
  });

  it('UDIFF-6: a heading and a paragraph with identical text do NOT match', () => {
    const ops = diffBlocks([h(2, 'same text')], [p('same text')]);
    expect(ops.some((o) => o.op === 'keep')).toBe(false);
  });

  it('UDIFF-7: formatting differences do not affect matching', () => {
    const plain: CanonicalBlock = { kind: 'paragraph', spans: [{ text: 'hello world' }] };
    const styled: CanonicalBlock = {
      kind: 'paragraph',
      spans: [{ text: 'hello ' }, { text: 'world', bold: true }],
    };
    expect(diffBlocks([plain], [styled]).map((o) => o.op)).toEqual(['keep']);
  });
});

describe('UREGION — contiguous rebuild regions', () => {
  it('UREGION-1: all-KEEP → no regions', () => {
    const blocks = [p('a'), p('b')];
    expect(planRegions(diffBlocks(blocks, blocks))).toHaveLength(0);
  });

  it('UREGION-2: consecutive changed blocks merge into one region', () => {
    const regions = planRegions(
      diffBlocks([p('a'), p('b'), p('c'), p('d')], [p('a'), p('B'), p('C'), p('d')]),
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ oldStart: 1, oldEnd: 3 });
    expect(regions[0]!.blocks).toHaveLength(2);
  });

  it('UREGION-3: two changes separated by a KEEP → two regions, KEEP in neither', () => {
    const regions = planRegions(
      diffBlocks([p('a'), p('b'), p('c')], [p('A'), p('b'), p('C')]),
    );
    expect(regions).toHaveLength(2);
    expect(regions[0]).toMatchObject({ oldStart: 0, oldEnd: 1 });
    expect(regions[1]).toMatchObject({ oldStart: 2, oldEnd: 3 });
  });

  it('UREGION-4: insert-only region resolves a correct insertion point', () => {
    const regions = planRegions(diffBlocks([p('a'), p('c')], [p('a'), p('b'), p('c')]));
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ oldStart: 1, oldEnd: 1, insertBeforeOld: 1 });
    expect(regions[0]!.blocks).toHaveLength(1);
  });

  it('UREGION-5: delete-only region carries no new blocks; modify carries the old range', () => {
    const del = planRegions(diffBlocks([p('a'), p('b'), p('c')], [p('a'), p('c')]));
    expect(del).toHaveLength(1);
    expect(del[0]).toMatchObject({ oldStart: 1, oldEnd: 2 });
    expect(del[0]!.blocks).toHaveLength(0);

    const mod = planRegions(diffBlocks([p('a'), p('b')], [p('a'), p('B')]));
    expect(mod[0]).toMatchObject({ oldStart: 1, oldEnd: 2 });
    expect(mod[0]!.blocks).toHaveLength(1);
  });

  it('USCOPE-2 (offline half of RT-1): identical markdown plans zero regions', () => {
    const blocks = [h(1, 'Doc'), p('body'), p('more')];
    expect(planRegions(diffBlocks(blocks, blocks))).toHaveLength(0);
  });
});
