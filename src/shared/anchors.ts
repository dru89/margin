import type { Anchor } from '@shared/types';

const CONTEXT_LEN = 32;

export function makeAnchor(content: string, from: number, to: number): Anchor {
  return {
    from,
    to,
    quote: content.slice(from, to),
    prefix: content.slice(Math.max(0, from - CONTEXT_LEN), from),
    suffix: content.slice(to, to + CONTEXT_LEN),
  };
}

/**
 * Locate `quote` in `content`. When the quote appears more than once, prefer
 * the occurrence whose surrounding context best matches the stored
 * prefix/suffix, then the one closest to the stored offset.
 */
export function resolveQuote(
  content: string,
  quote: string,
  opts: { prefix?: string; suffix?: string; nearOffset?: number } = {},
): { from: number; to: number } | null {
  if (!quote) return null;
  const occurrences: number[] = [];
  let idx = content.indexOf(quote);
  while (idx !== -1) {
    occurrences.push(idx);
    idx = content.indexOf(quote, idx + 1);
  }
  if (occurrences.length === 0) return null;
  if (occurrences.length === 1) return { from: occurrences[0], to: occurrences[0] + quote.length };

  const scored = occurrences.map((at) => {
    let score = 0;
    if (opts.prefix) {
      const actual = content.slice(Math.max(0, at - opts.prefix.length), at);
      score += sharedSuffixLen(actual, opts.prefix);
    }
    if (opts.suffix) {
      const actual = content.slice(at + quote.length, at + quote.length + opts.suffix.length);
      score += sharedPrefixLen(actual, opts.suffix);
    }
    const distance = opts.nearOffset === undefined ? 0 : Math.abs(at - opts.nearOffset);
    return { at, score, distance };
  });
  scored.sort((a, b) => b.score - a.score || a.distance - b.distance);
  const best = scored[0];
  return { from: best.at, to: best.at + quote.length };
}

/** Re-anchor a stored anchor against (possibly externally edited) content. */
export function reanchor(content: string, anchor: Anchor): Anchor {
  // Fast path: the stored offsets still hold the quote.
  if (content.slice(anchor.from, anchor.to) === anchor.quote) {
    return { ...anchor, orphaned: false };
  }
  const found = resolveQuote(content, anchor.quote, {
    prefix: anchor.prefix,
    suffix: anchor.suffix,
    nearOffset: anchor.from,
  });
  if (!found) return { ...anchor, orphaned: true };
  return makeAnchor(content, found.from, found.to);
}

function sharedSuffixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function sharedPrefixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}
