import { describe, expect, it } from 'vitest';
import type { InlineSpan } from '../src/blocks.ts';
import { PAGE_WIDTH_PT, planColumnWidths } from '../src/widths.ts';

const row = (...cells: string[]): InlineSpan[][] => cells.map((text) => [{ text }]);

describe('UWIDTH — provisional column sizing (pending reference algorithm)', () => {
  it('UWIDTH-1 (SI-4 offline half): single-emoji status columns are narrow', () => {
    const widths = planColumnWidths([row('Status', 'Description'), row('⚠️', 'A long description of the thing')]);
    // 'Status' header caps the measurement? No — max over ALL cells,
    // and 'Status' is 6 glyphs; the point is ⚠️ counts as 1, not 2.
    // A pure emoji column (header included) is the SI-4 case:
    const emojiOnly = planColumnWidths([row('⚠️', 'x'), row('👍🏽', 'y'), row('1️⃣', 'z')]);
    expect(emojiOnly[0]).toBe(36); // MIN_PT — narrow
    expect(widths[1]!).toBeGreaterThan(widths[0]!);
  });

  it('UWIDTH-2: long-text columns clamp and the table fits the page', () => {
    const long = 'A very long sentence that would otherwise crush its neighboring columns badly';
    const widths = planColumnWidths([row(long, long, long)]);
    expect(widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(PAGE_WIDTH_PT + 2);
  });

  it('UWIDTH-3: scaling respects the minimum floor', () => {
    const long = 'x'.repeat(200);
    const widths = planColumnWidths([row(long, long, long, long, long, long, long, long, long, long, '⚠️')]);
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(36);
  });
});
