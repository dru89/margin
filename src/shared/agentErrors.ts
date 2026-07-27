/**
 * What a failed review round means, and what the author can do about it
 * (#79, #106).
 *
 * The SDK's error text is written for whoever is reading a stack trace,
 * not for someone who has just lost a turn — "Failed to authenticate:
 * OAuth session expired and could not be refreshed" says nothing about
 * the one action that fixes it. This turns the raw text into a sentence
 * with a next step in it, and a judgement about whether running the same
 * round again is worth trying.
 */

export type FailureKind = 'auth' | 'network' | 'cancelled' | 'unknown';

export interface AgentFailure {
  kind: FailureKind;
  /** One line, addressed to the author, with the next step in it. */
  message: string;
  /** Is running this same round again likely to get further? */
  retryable: boolean;
}

/**
 * A concrete network signal — a DNS or socket failure, not the word
 * "network" appearing in prose.
 *
 * Checked *before* authentication, deliberately. Losing the connection
 * while a token is being refreshed produces an error that mentions both,
 * and of the two causes the connection is the one the author can see and
 * act on. Getting this backwards sends someone to re-run `/login` over a
 * dropped Wi-Fi connection.
 */
const NETWORK =
  /\b(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|fetch failed|socket hang up|network error|getaddrinfo|offline)\b/i;

const AUTH = /(oauth|authenticat\w*|unauthori[sz]ed|forbidden|401|403|credential|api[- ]key|log ?in|token expired)/i;

const CANCELLED = /\b(cancell?ed|aborted|AbortError)\b/i;

export function classifyAgentError(raw: string): AgentFailure {
  const text = raw || 'The round failed for an unknown reason.';

  if (CANCELLED.test(text)) {
    return { kind: 'cancelled', message: 'Round cancelled.', retryable: true };
  }
  if (NETWORK.test(text)) {
    return {
      kind: 'network',
      message: 'Margin could not reach Claude. Check your connection, then try the round again.',
      retryable: true,
    };
  }
  if (AUTH.test(text)) {
    return {
      kind: 'auth',
      // The fix is outside Margin, so the message has to name it. Margin
      // has no way to sign in on the author's behalf.
      message:
        'Your Claude login has expired. Sign in again by running “claude /login” in a terminal, then try the round again.',
      retryable: true,
    };
  }
  return { kind: 'unknown', message: text, retryable: true };
}

/**
 * A cheap shape of the review, used to tell whether a round that failed
 * had produced anything before it did.
 *
 * Counts rather than content: a round either added replies, threads or
 * suggestions, or it left no trace worth keeping. Deciding *that* is what
 * makes a rollback safe — see DECISIONS §71.
 */
export function reviewOutputSize(review: {
  comments: { replies: unknown[] }[];
  suggestions: unknown[];
}): number {
  return (
    review.comments.length +
    review.suggestions.length +
    review.comments.reduce((n, c) => n + c.replies.length, 0)
  );
}
