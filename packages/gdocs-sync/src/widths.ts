/**
 * Table column sizing — PROVISIONAL algorithm (Margin-added scenarios
 * UWIDTH-*), pending the reference implementation's actual rules
 * (asked in margin#10: width→points formula, pooling across tables
 * sharing headers, wrap threshold, page-fit distribution).
 *
 * v1 rules, documented so they can be replaced wholesale:
 * - Column content width = max displayWidth over its cells (UMISC-2 —
 *   emoji count as one glyph, not two code units; SI-4's failure mode).
 * - Points = width × CHAR_PT + PADDING_PT, clamped to [MIN_PT, MAX_PT].
 *   Single-glyph columns clamp to MIN_PT (SI-4: narrow).
 * - If the total exceeds the usable page width (468pt — US Letter,
 *   1" margins, lesson 8), scale proportionally to fit, respecting
 *   MIN_PT floors.
 */
import type { InlineSpan } from './blocks.ts';
import { spanText } from './blocks.ts';
import { displayWidth } from './util.ts';

export const PAGE_WIDTH_PT = 468;
const CHAR_PT = 6.5; // ≈ average glyph advance at 11pt body text
const PADDING_PT = 14; // cell padding both sides
const MIN_PT = 36;
const MAX_PT = 300;

export function planColumnWidths(rows: InlineSpan[][][]): number[] {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let maxGlyphs = 0;
    for (const row of rows) {
      const cell = row[c];
      if (cell) maxGlyphs = Math.max(maxGlyphs, displayWidth(spanText(cell).trim()));
    }
    const pt = maxGlyphs <= 2 ? MIN_PT : Math.min(MAX_PT, maxGlyphs * CHAR_PT + PADDING_PT);
    widths.push(Math.max(MIN_PT, Math.round(pt)));
  }
  const total = widths.reduce((a, b) => a + b, 0);
  if (total <= PAGE_WIDTH_PT) return widths;
  // Scale down proportionally, but never below the floor.
  const scale = PAGE_WIDTH_PT / total;
  return widths.map((w) => Math.max(MIN_PT, Math.round(w * scale)));
}

/** updateTableColumnProperties requests for a table starting at tableStartIndex. */
export function columnWidthRequests(
  tableStartIndex: number,
  widths: number[],
): Record<string, unknown>[] {
  return widths.map((w, i) => ({
    updateTableColumnProperties: {
      tableStartLocation: { index: tableStartIndex },
      columnIndices: [i],
      tableColumnProperties: { widthType: 'FIXED_WIDTH', width: { magnitude: w, unit: 'PT' } },
      fields: 'widthType,width',
    },
  }));
}
