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
export const CODE_SPACING: ParaSpacing = { beforePt: 0, afterPt: 2 };

export const QUOTE_SPACING: ParaSpacing = { beforePt: 5, afterPt: 5 };
/** The reference's Compact style — list items breathe 1.8pt, not 10pt. */
export const LIST_SPACING: ParaSpacing = { beforePt: 1.8, afterPt: 1.8 };

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
