/**
 * The tightest way to show one suggestion (spec §6, #98).
 *
 * A suggestion is a single replacement: you accept or reject the whole
 * thing. So this trims rather than diffs — it strips the words the two
 * strings share at each end and shows everything between as one deletion
 * and one insertion.
 *
 * A real diff would be wrong here, not merely different. Replacing
 * "alpha and beta" with "gamma and delta" shares the word "and", and a
 * diff anchors on it: "[alpha|gamma] and [beta|delta]". That reads as two
 * independent edits when it is one, and a suggestion that fragments into
 * five small swaps is harder to judge than the sentence it came from.
 *
 * The review already stores both strings, so this is presentation only.
 */

export type DiffKind = 'same' | 'del' | 'ins';
export interface DiffPart {
  kind: DiffKind;
  text: string;
}

/**
 * Each token is a word with the whitespace that follows it, plus any
 * leading whitespace as its own token. Concatenating tokens reproduces the
 * input exactly, so trimming can never quietly reformat the author's text.
 */
function tokenize(text: string): string[] {
  return text.match(/^\s+|\S+\s*/g) ?? [];
}

function part(kind: DiffKind, tokens: string[]): DiffPart[] {
  const text = tokens.join('');
  return text === '' ? [] : [{ kind, text }];
}

export function wordDiff(before: string, after: string): DiffPart[] {
  if (before === after) return part('same', [before]);
  if (before === '') return part('ins', [after]);
  if (after === '') return part('del', [before]);

  const a = tokenize(before);
  const b = tokenize(after);

  // Shared opening, then shared ending — never meeting in the middle.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  return [
    ...part('same', a.slice(0, head)),
    ...part('del', a.slice(head, a.length - tail)),
    ...part('ins', b.slice(head, b.length - tail)),
    ...part('same', a.slice(a.length - tail)),
  ];
}

/** The text as it stands today — every part except insertions. */
export function beforeText(parts: DiffPart[]): string {
  return parts.filter((p) => p.kind !== 'ins').map((p) => p.text).join('');
}

/** The text as it would stand — every part except deletions. */
export function afterText(parts: DiffPart[]): string {
  return parts.filter((p) => p.kind !== 'del').map((p) => p.text).join('');
}
