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

  let before2 = a.slice(head, a.length - tail).join('');
  let after2 = b.slice(head, b.length - tail).join('');
  let lead = a.slice(0, head).join('');
  let trail = a.slice(a.length - tail).join('');

  // Characters both sides share at the edges are unchanged, so they belong
  // outside the marked spans. Leaving them in strikes and re-underlines
  // something nothing touched, and the mark stops matching the words that
  // actually differ.
  //
  // Whitespace *and* punctuation, because both produce the same artefact:
  //   ... [-C+I,-]{+Commerce & Identity (C&I),+} where     two commas
  //   (something [-parenthetical)-]{+in parentheses)+}     two closing parens
  // The second reads worse — a closing paren is half a matched pair, so
  // seeing two looks like broken markup rather than repeated content — but
  // it is the same thing, so one rule covers both.
  //
  // Never letters or digits: hoisting those would cut words in half
  // ("runn[-ing-]{+er+}"), which trades one oddity for a worse one.
  //
  // And only when *both* sides have it: inserting a word into a sentence
  // adds a space as well as a word, and that space really is new.
  if (before2 !== '' && after2 !== '') {
    const shared = (x: string, y: string, at: 'start' | 'end') => {
      const re = at === 'end' ? /[^\p{L}\p{N}]+$/u : /^[^\p{L}\p{N}]+/u;
      const mx = re.exec(x)?.[0] ?? '';
      const my = re.exec(y)?.[0] ?? '';
      // Compare character by character from the shared edge; stop at the
      // first difference, so "(C&I)," and "C+I," share only the comma.
      let n = 0;
      while (n < mx.length && n < my.length) {
        const cx = at === 'end' ? mx[mx.length - 1 - n] : mx[n];
        const cy = at === 'end' ? my[my.length - 1 - n] : my[n];
        if (cx !== cy) break;
        n++;
      }
      if (n === 0) return '';
      return at === 'end' ? mx.slice(mx.length - n) : mx.slice(0, n);
    };
    const tailWs = shared(before2, after2, 'end');
    if (tailWs) {
      before2 = before2.slice(0, before2.length - tailWs.length);
      after2 = after2.slice(0, after2.length - tailWs.length);
      trail = tailWs + trail;
    }
    const leadWs = shared(before2, after2, 'start');
    if (leadWs) {
      before2 = before2.slice(leadWs.length);
      after2 = after2.slice(leadWs.length);
      lead += leadWs;
    }
  }

  return [
    ...part('same', [lead]),
    ...part('del', [before2]),
    ...part('ins', [after2]),
    ...part('same', [trail]),
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
