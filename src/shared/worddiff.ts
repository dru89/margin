/**
 * Word-level diff between a suggestion's quote and its replacement
 * (spec §6, #98).
 *
 * The review stores both strings, so this is presentation only — no
 * schema change. Diffing at the anchor level renders the whole clause as
 * struck-then-inserted when three words changed, which buries what
 * actually differs and makes a long suggestion unreadable.
 */

export type DiffKind = 'same' | 'del' | 'ins';
export interface DiffPart {
  kind: DiffKind;
  text: string;
}

/**
 * Above this many tokens the O(n·m) table stops being worth it, and a
 * suggestion that large is a rewrite rather than an edit — showing it
 * whole is the more honest rendering anyway.
 */
const MAX_TOKENS = 400;

/**
 * Each token is a word with the whitespace that follows it, plus any
 * leading whitespace as its own token. Two properties matter:
 *
 * - Concatenating tokens reproduces the input exactly, so a diff can never
 *   quietly reformat the author's text.
 * - Whitespace never anchors a match. As separate tokens the spaces align
 *   across otherwise unrelated text, and the diff fragments around them:
 *   "alpha beta" → "gamma delta" came out as four alternating parts
 *   rather than one replacement.
 */
function tokenize(text: string): string[] {
  return text.match(/^\s+|\S+\s*/g) ?? [];
}

function merge(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  for (const p of parts) {
    if (p.text === '') continue;
    const last = out[out.length - 1];
    if (last && last.kind === p.kind) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

export function wordDiff(before: string, after: string): DiffPart[] {
  if (before === after) return merge([{ kind: 'same', text: before }]);
  if (before === '') return merge([{ kind: 'ins', text: after }]);
  if (after === '') return merge([{ kind: 'del', text: before }]);

  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return merge([
      { kind: 'del', text: before },
      { kind: 'ins', text: after },
    ]);
  }

  // Longest common subsequence over tokens.
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const parts: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      parts.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      parts.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      parts.push({ kind: 'ins', text: b[j] });
      j++;
    }
  }
  while (i < n) parts.push({ kind: 'del', text: a[i++] });
  while (j < m) parts.push({ kind: 'ins', text: b[j++] });
  return merge(parts);
}

/** The text as it stands today — every part except insertions. */
export function beforeText(parts: DiffPart[]): string {
  return parts.filter((p) => p.kind !== 'ins').map((p) => p.text).join('');
}

/** The text as it would stand — every part except deletions. */
export function afterText(parts: DiffPart[]): string {
  return parts.filter((p) => p.kind !== 'del').map((p) => p.text).join('');
}
