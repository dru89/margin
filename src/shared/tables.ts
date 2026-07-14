/**
 * GFM table formatting: pad every cell so the pipes align. Pure string logic
 * so it can be exercised by a compiled-module node script (no test framework).
 */

/** Matches the editor's table-line detection: optional indent, then a pipe. */
export function isTableLine(text: string): boolean {
  return /^\s*\|/.test(text);
}

type Align = 'left' | 'center' | 'right' | 'none';

const DELIM_CELL = /^:?-+:?$/;

/** Split a row into trimmed cells: outer pipes stripped, `\|` kept intact. */
function splitCells(text: string): string[] {
  const inner = text.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && inner[i + 1] === '|') {
      cur += '\\|';
      i++;
    } else if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function isDelimiterRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => DELIM_CELL.test(c));
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return 'none';
}

/** Code points, not UTF-16 units (wide-glyph width is out of scope). */
function width(cell: string): number {
  return [...cell].length;
}

function pad(cell: string, w: number, align: Align): string {
  const gap = w - width(cell);
  if (gap <= 0) return cell;
  if (align === 'right') return ' '.repeat(gap) + cell;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + cell + ' '.repeat(gap - left);
  }
  return cell + ' '.repeat(gap);
}

/**
 * Reformat a table block: every cell padded to its column's width, content
 * justified per the delimiter row's alignment colons, all lines carrying the
 * first line's indent. Idempotent — formatting a formatted table is a no-op.
 */
export function formatTableLines(lines: string[]): string[] {
  const rows = lines.map(splitCells);
  const cols = Math.max(...rows.map((r) => r.length));
  const delimIndex = rows.findIndex(isDelimiterRow);
  const aligns: Align[] = Array.from({ length: cols }, (_, i) =>
    delimIndex === -1 ? 'none' : alignOf(rows[delimIndex][i] ?? ''),
  );
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max(3, ...rows.map((r, ri) => (ri === delimIndex ? 0 : width(r[i] ?? '')))),
  );
  const indent = /^\s*/.exec(lines[0])![0];
  return rows.map((cells, ri) => {
    const parts = Array.from({ length: cols }, (_, i) => {
      if (ri === delimIndex) {
        const a = aligns[i];
        const dashes = '-'.repeat(widths[i] - (a === 'center' ? 2 : a === 'none' ? 0 : 1));
        if (a === 'center') return `:${dashes}:`;
        if (a === 'right') return `${dashes}:`;
        if (a === 'left') return `:${dashes}`;
        return dashes;
      }
      return pad(cells[i] ?? '', widths[i], aligns[i] === 'none' ? 'left' : aligns[i]);
    });
    return `${indent}| ${parts.join(' | ')} |`;
  });
}
