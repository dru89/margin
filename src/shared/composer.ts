/**
 * The one composer's draft (spec §8, #121).
 *
 * There is a single composer, because committing a comment already stages
 * it without sending — so several drafts before a round already work, and
 * a second composer would be a second draft *buffer*, not a second
 * comment.
 *
 * The rule that needs a home outside the store: a new selection re-targets
 * an *empty* composer freely, and is refused by one holding work. That
 * turns on what "holding work" means, which is the only judgement here and
 * the only part worth testing.
 */

export type ComposerMode = 'comment' | 'suggest';

export interface ComposerDraft {
  mode: ComposerMode;
  /** The comment, or a suggestion's rationale. */
  text: string;
  /** Edited replacement text; null means "still exactly the quoted text". */
  replacement: string | null;
}

export const emptyDraft: ComposerDraft = { mode: 'comment', text: '', replacement: null };

/**
 * Does this draft hold anything a misclick would destroy?
 *
 * Whitespace does not count — a stray space should not wedge the composer
 * onto text the author has moved on from. An edited replacement does,
 * even with no rationale typed: in suggest mode the replacement *is* the
 * work. A replacement that still matches its quote is untouched, whether
 * it arrived as null or as the quote typed back in by hand.
 */
export function draftHasContent(draft: ComposerDraft, quote: string): boolean {
  if (draft.text.trim().length > 0) return true;
  return draft.mode === 'suggest' && draft.replacement !== null && draft.replacement !== quote;
}
