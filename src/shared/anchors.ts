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
 * How much of the stored context an occurrence must reproduce before we
 * believe it. An anchor sitting where it always sat scores ~100%; one
 * that survived edits nearby still scores well, because only the changed
 * side of it is disturbed. A different occurrence of the same words in
 * unrelated surroundings scores a few percent — the space before it and
 * the punctuation after, and little else.
 */
const MIN_CONTEXT_RATIO = 0.2;

/** How well the text around `at` reproduces the anchor's stored context. */
function contextScore(
  content: string,
  at: number,
  quoteLen: number,
  opts: { prefix?: string; suffix?: string },
): { score: number; available: number } {
  let score = 0;
  let available = 0;
  if (opts.prefix) {
    available += opts.prefix.length;
    score += sharedSuffixLen(content.slice(Math.max(0, at - opts.prefix.length), at), opts.prefix);
  }
  if (opts.suffix) {
    available += opts.suffix.length;
    score += sharedPrefixLen(content.slice(at + quoteLen, at + quoteLen + opts.suffix.length), opts.suffix);
  }
  return { score, available };
}

/**
 * Locate `quote` in `content`. When the quote appears more than once, prefer
 * the occurrence whose surrounding context best matches the stored
 * prefix/suffix, then the one closest to the stored offset.
 *
 * A lone occurrence is scored too, rather than accepted for being the only
 * candidate: when the anchored text is deleted and the same words occur
 * elsewhere, the comment should orphan rather than migrate to a sentence
 * it was never about (#125).
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

  const scored = occurrences.map((at) => {
    const { score, available } = contextScore(content, at, quote.length, opts);
    const distance = opts.nearOffset === undefined ? 0 : Math.abs(at - opts.nearOffset);
    return { at, score, available, distance };
  });
  scored.sort((a, b) => b.score - a.score || a.distance - b.distance);
  const best = scored[0];
  // No stored context (older sidecars, and callers that resolve a bare
  // quote) — nothing to check against, so take the best position.
  if (best.available > 0 && best.score < best.available * MIN_CONTEXT_RATIO) return null;
  return { from: best.at, to: best.at + quote.length };
}

/** Re-anchor a stored anchor against (possibly externally edited) content. */
export function reanchor(content: string, anchor: Anchor): Anchor {
  // Fast path: the stored offsets hold the quote *and* its surroundings.
  // Checking the quote alone is not enough — inserting the same words
  // immediately before an anchor leaves the stored offsets sitting on the
  // new copy, and the anchor would silently adopt text the author just
  // typed (#125). Identical context means it is genuinely undisturbed.
  if (content.slice(anchor.from, anchor.to) === anchor.quote) {
    const { score, available } = contextScore(content, anchor.from, anchor.quote.length, anchor);
    if (score === available) return { ...anchor, orphaned: false };
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
