/**
 * Style values extracted from the reference tool's reference.docx
 * (dru89/doc-tools reference/, styles.xml + docDefaults). These are
 * the "standard styles" pushed docs should carry — layered explicitly
 * on top of named styles per the lesson-4 explicit-everything rule.
 *
 * Markdown heading level → docx style: level 1 = Title, level 2 =
 * Heading1, … (the −1 shift), clamping at the reference's Heading4.
 */

export interface TextLook {
  font: string;
  sizePt: number;
  colorHex?: string;
}

export interface ParaSpacing {
  beforePt: number;
  afterPt: number;
}

export const BODY: TextLook = { font: 'Roboto', sizePt: 11 };
export const BODY_SPACING: ParaSpacing = { beforePt: 0, afterPt: 10 };

export const TITLE: TextLook = { font: 'Lato', sizePt: 26 };
export const TITLE_SPACING: ParaSpacing = { beforePt: 0, afterPt: 3 };

export const SUBTITLE: TextLook = { font: 'Lato', sizePt: 14, colorHex: '666666' };
export const SUBTITLE_SPACING: ParaSpacing = { beforePt: 0, afterPt: 16 };

/** Keyed by markdown heading level (2..5+); level 1 is TITLE. */
export const HEADINGS: Record<number, { look: TextLook; spacing: ParaSpacing }> = {
  2: { look: { font: 'Lato', sizePt: 20 }, spacing: { beforePt: 20, afterPt: 6 } },
  3: { look: { font: 'Lato', sizePt: 16 }, spacing: { beforePt: 18, afterPt: 6 } },
  4: { look: { font: 'Lato', sizePt: 14, colorHex: '434343' }, spacing: { beforePt: 16, afterPt: 4 } },
  5: { look: { font: 'Lato', sizePt: 12, colorHex: '666666' }, spacing: { beforePt: 14, afterPt: 4 } },
};

export function headingStyle(level: number): { look: TextLook; spacing: ParaSpacing } {
  return HEADINGS[Math.min(Math.max(level, 2), 5)]!;
}

export const CODE: TextLook = { font: 'Roboto Mono', sizePt: 11, colorHex: '188038' };
/** Docs' default link look — the API's link field does NOT auto-apply it. */
export const LINK_COLOR_HEX = '1155CC';

export const CODE_SPACING: ParaSpacing = { beforePt: 0, afterPt: 2 };

export const QUOTE_SPACING: ParaSpacing = { beforePt: 10, afterPt: 10 };
/** Tight lists breathe 1.8pt between items; loose (blank-line) lists get body spacing. */
export const LIST_ITEM_GAP_PT = 1.8;
export const LOOSE_ITEM_GAP_PT = 10;
/** Block-level breathing room above/below lists, code blocks, and tables. */
export const BLOCK_GAP_PT = 10;
/** Blockquote left border — reads as a quoted block. */
export const QUOTE_BORDER = {
  width: { magnitude: 3, unit: 'PT' },
  padding: { magnitude: 8, unit: 'PT' },
  dashStyle: 'SOLID',
  color: { color: { rgbColor: { red: 0.7, green: 0.7, blue: 0.7 } } },
};

/** Table chrome from reference.docx (style id "Table" + firstRow/banding). */
export const TABLE_STYLE = {
  border: { widthPt: 0.5, colorHex: 'BFBFBF' },
  /** dxa 40/115 → pt. */
  // Bumped from the reference-extracted 2/5.75 — cells read cramped in
  // Docs' rendering (issue #63).
  padding: { topPt: 4, bottomPt: 4, leftPt: 7.5, rightPt: 7.5 },
  header: {
    backgroundHex: 'F2F2F2',
    textColorHex: '333333',
    bottomBorder: { widthPt: 1, colorHex: '808080' },
  },
  /** Zebra striping: first body row F9F9F9, then alternating white. */
  bandHex: 'F9F9F9',
} as const;

export function rgb(hex: string): { color: { rgbColor: { red: number; green: number; blue: number } } } {
  return {
    color: {
      rgbColor: {
        red: parseInt(hex.slice(0, 2), 16) / 255,
        green: parseInt(hex.slice(2, 4), 16) / 255,
        blue: parseInt(hex.slice(4, 6), 16) / 255,
      },
    },
  };
}

export function textStyleOf(look: TextLook): Record<string, unknown> {
  const style: Record<string, unknown> = {
    weightedFontFamily: { fontFamily: look.font },
    fontSize: { magnitude: look.sizePt, unit: 'PT' },
  };
  if (look.colorHex) style.foregroundColor = rgb(look.colorHex);
  return style;
}

export function spacingStyle(spacing: ParaSpacing): Record<string, unknown> {
  return {
    spaceAbove: { magnitude: spacing.beforePt, unit: 'PT' },
    spaceBelow: { magnitude: spacing.afterPt, unit: 'PT' },
  };
}

/** Callout chrome (issue #40): emoji + tint per canonical type. */
/**
 * Callout chrome (issue #40, restyled per feedback): no emoji — the
 * tint background is the machine-readable type signal on read, the
 * saturated accent colors the left border and the bold title.
 */
export const CALLOUTS: Record<string, { tintHex: string; accentHex: string }> = {
  info: { tintHex: 'E8F0FE', accentHex: '1967D2' },
  tip: { tintHex: 'E6F4EA', accentHex: '188038' },
  important: { tintHex: 'F3E8FD', accentHex: '7627BB' },
  warning: { tintHex: 'FEF7E0', accentHex: '8A4A00' }, // deeper than B05A00 — amber on pale yellow read muddy
  danger: { tintHex: 'FCE8E6', accentHex: 'C5221F' },
};

/** Default (and fold-back) title for a callout with none in markdown. */
export function calloutTitleFor(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** Aliases fold to canonical types; unknown types become info. */
export function calloutType(raw: string): string {
  const t = raw.toLowerCase();
  const aliases: Record<string, string> = {
    note: 'info', info: 'info',
    tip: 'tip', hint: 'tip',
    important: 'important',
    warning: 'warning', warn: 'warning',
    caution: 'danger', danger: 'danger', error: 'danger',
  };
  return aliases[t] ?? 'info';
}
