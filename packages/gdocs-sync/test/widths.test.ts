import { describe, expect, it } from 'vitest';
import type { InlineSpan } from '../src/blocks.ts';
import {
  PAGE_WIDTH_PT,
  planColumnWidths,
  planDocumentWidths,
  shouldCenterColumn,
} from '../src/widths.ts';

const row = (...cells: string[]): InlineSpan[][] => cells.map((text) => [{ text }]);

describe('UWIDTH — reference column-sizing algorithm (conventions @ ad145b3)', () => {
  it('UWIDTH-1: typical = 80th percentile of body cells, never below header', () => {
    // Nine short cells, one huge outlier: percentile ignores the outlier.
    // Outlier is long overall but has only short tokens, so the word
    // floor (tested in UWIDTH-2) stays out of the way here.
    const rows: InlineSpan[][][] = [
      row('Head', 'H2'),
      ...Array.from({ length: 9 }, () => row('abcde', 'x')),
      row('aa bb cc dd ee ff gg hh ii jj kk ll mm nn oo pp qq rr', 'x'),
    ];
    const widths = planColumnWidths(rows);
    // 80th percentile of body lengths (nine 5s, one 53) = 5 → one-line tier.
    expect(widths[0]).toBe(Math.round(5 * 6.2 + 14));
  });

  it('UWIDTH-2: wrap tier for long-text columns (26·√typical − 20), word floor holds', () => {
    const long = 'a sentence that goes on well past the one hundred and fifty point one line fit threshold for sure';
    const widths = planColumnWidths([row('Notes'), row(long), row(long)]);
    const typical = long.length;
    const expected = Math.round(26 * Math.sqrt(typical) - 20);
    expect(widths[0]).toBe(expected);
    // Word floor: a giant unbreakable token (capped at 20 glyphs) raises the width.
    const tokenRows = [row('T'), row('supercalifragilistic-expialidocious ok')];
    const w = planColumnWidths(tokenRows)[0]!;
    expect(w).toBeGreaterThanOrEqual(Math.round(20 * 6.2 + 14));
  });

  it('UWIDTH-3: water-fill page fit pins floors and rescales the rest; fitting tables untouched', () => {
    const long = 'x'.repeat(120);
    const widths = planColumnWidths([
      row('A', 'B', 'C', 'D'),
      row(long, long, long, '⚠️'),
    ]);
    const total = widths.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(PAGE_WIDTH_PT + widths.length); // rounding slack
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(26);
    // A small table is never stretched to the page.
    const small = planColumnWidths([row('a', 'b'), row('xx', 'yy')]);
    expect(small.reduce((a, b) => a + b, 0)).toBeLessThan(PAGE_WIDTH_PT / 2);
  });

  it('UWIDTH-4: pooling keys on (position, full leading-header prefix)', () => {
    const t1 = [row('Service', 'Owner'), row('identity-gateway', 'Drew')];
    const t2 = [row('Service', 'Owner'), row('gw', 'D')];
    const t3 = [row('Service', 'Region'), row('a-very-long-service-name-here', 'us-east-1')];
    const [w1, w2, w3] = planDocumentWidths([t1, t2, t3]);
    // t1/t2 share both columns (prefix matches through each position).
    expect(w2).toEqual(w1);
    // t3 shares column 0 (prefix 'Service') but not column 1.
    expect(w3![0]).toBe(w1![0]);
    expect(w3![1]).not.toBe(w1![1]);
  });

  it('UWIDTH-5 (SI-4): centering = every body cell ≤ 1 glyph, header width irrelevant', () => {
    // A wordy header ("Status") must not defeat centering — style-review
    // feedback; deviates deliberately from the reference's ≤48pt guard.
    const emoji = [row('Status', 'Desc'), row('⚠️', 'longer text'), row('👍🏽', 'more text')];
    expect(shouldCenterColumn(emoji, 0)).toBe(true);
    expect(shouldCenterColumn(emoji, 1)).toBe(false);
    // Two-glyph cells don't center; empty tables don't center.
    expect(shouldCenterColumn([row('S'), row('ab')], 0)).toBe(false);
    expect(shouldCenterColumn([row('S')], 0)).toBe(false);
  });
});
