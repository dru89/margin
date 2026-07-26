import type { Author, CommentThread, Reply, Suggestion } from '@shared/types';

/**
 * Review state, derived from round stamps — never stored.
 *
 * Storing these would mean two sources of truth and a migration every
 * time a rule changes. Everything here is a pure function of the review
 * data plus the current round (`ReviewData.round`), which increments at
 * the top of `submitReview`.
 *
 * That increment point is what makes "unsent" computable. The author's
 * work always carries the round it was written in, and submitting moves
 * the counter past it — so a thing the author wrote whose round still
 * equals the current one has not been through a round yet. The agent's
 * output for round N also carries N and stays that way until the next
 * submit, which is why authorship is part of the test and not just the
 * number.
 *
 * See docs/specs/review-surface.md §2.
 */

export type ThreadState = 'draft' | 'awaiting' | 'unread' | 'read' | 'settled';
export type SuggestionState = 'draft' | 'pending' | 'decided';

/** One message's worth of activity, from the thread body or a reply. */
interface Activity {
  author: Author;
  round: number;
  /** Written by someone other than the author of this review. */
  external: boolean;
}

function threadActivity(t: CommentThread): Activity {
  return {
    author: t.author,
    round: t.round,
    // An imported thread was written by a collaborator on the linked Doc.
    // It is attributed to 'user' because it isn't the agent's, but it is
    // not the author's own writing either.
    external: t.author === 'agent' || t.provenance === 'imported',
  };
}

function replyActivity(r: Reply): Activity {
  return {
    author: r.author,
    round: r.round,
    // `collaborator` is set only on replies pulled down from the Doc.
    // A reply the author sends *to* the Doc carries driveReplyId alone,
    // so that is not a usable marker here.
    external: r.author === 'agent' || r.collaborator !== undefined,
  };
}

/**
 * The most recent activity on a thread. Replies are appended in order and
 * rounds only move forward, so the last element is the latest — no sort.
 */
export function latestActivity(t: CommentThread): Activity {
  return t.replies.length > 0
    ? replyActivity(t.replies[t.replies.length - 1])
    : threadActivity(t);
}

/** The highest round on which someone else acted in this thread. */
export function latestExternalRound(t: CommentThread): number | null {
  let round: number | null = null;
  const all = [threadActivity(t), ...t.replies.map(replyActivity)];
  for (const a of all) {
    if (a.external && (round === null || a.round > round)) round = a.round;
  }
  return round;
}

/** Someone else has spoken since the author last looked at this thread. */
export function isUnread(t: CommentThread): boolean {
  if (t.status === 'resolved') return false;
  const external = latestExternalRound(t);
  if (external === null) return false;
  return external > (t.seenRound ?? -1);
}

export function threadState(t: CommentThread, currentRound: number): ThreadState {
  if (t.status === 'resolved') return 'settled';
  const last = latestActivity(t);
  // The author's own last word wins over unread. Answering a thread is
  // proof of having read it, and a thread carrying an unsent reply needs
  // to say so — reporting it as unread hides the reply and keeps asking
  // for attention already given. `markSeen` on reply keeps the stored
  // marker honest too; this ordering is what makes the derivation right
  // even for data that arrived without it.
  if (!last.external) {
    return last.round >= currentRound ? 'draft' : 'awaiting';
  }
  if (isUnread(t)) return 'unread';
  return 'read';
}

export function suggestionState(s: Suggestion, currentRound: number): SuggestionState {
  if (s.status !== 'pending') return 'decided';
  if (s.author !== 'agent' && s.round >= currentRound) return 'draft';
  return 'pending';
}

/** Advance a thread's seen marker to whatever has been said in it. */
export function markSeen(t: CommentThread): CommentThread {
  const external = latestExternalRound(t);
  if (external === null || external <= (t.seenRound ?? -1)) return t;
  return { ...t, seenRound: external };
}

/**
 * Is this thread waiting on the author?
 *
 * True whenever the last word came from someone else — the agent, or a
 * collaborator on a linked Doc. Note that *reading* a thread does not
 * settle it: looking is not responding.
 *
 * This is deliberately a different question from `isUnread`. Unread is
 * about what is new and changes the moment the author looks; "needs you"
 * is about what is outstanding and changes only when they act. A filter
 * built on unread rearranges itself as it is read, which is what made
 * cards vanish mid-click.
 */
export function threadNeedsYou(t: CommentThread, currentRound: number): boolean {
  const state = threadState(t, currentRound);
  return state === 'unread' || state === 'read';
}

/** A suggestion waits on the author whenever it is undecided and not theirs. */
export function suggestionNeedsYou(s: Suggestion, currentRound: number): boolean {
  return suggestionState(s, currentRound) === 'pending' && s.author === 'agent';
}

/**
 * Editability (spec §8, #89).
 *
 * A thing is editable while it is still the author's own unsent draft, and
 * read-only the moment it is history. Three conditions, all necessary:
 *
 * - **It is the author's writing.** The agent's output and a collaborator's
 *   Doc comment are records of what someone else said; editing them would
 *   be rewriting the other half of the conversation.
 * - **It belongs to the round being composed.** Submitting is what makes
 *   something sent, and the round counter moves past it at that moment.
 * - **It has not been published anywhere else.** A reply sent with "Reply
 *   on Doc" already exists on the Doc under the author's name. Editing the
 *   local copy would silently disagree with it, and the Doc is the copy
 *   other people are reading.
 */
export function threadEditable(t: CommentThread, currentRound: number): boolean {
  if (t.status === 'resolved') return false;
  return !threadActivity(t).external && t.round >= currentRound && t.driveCommentId === undefined;
}

export function replyEditable(r: Reply, currentRound: number): boolean {
  return !replyActivity(r).external && r.round >= currentRound && r.driveReplyId === undefined;
}

/** Draft is already exactly this rule for suggestions — pending, mine, unsent. */
export function suggestionEditable(s: Suggestion, currentRound: number): boolean {
  return suggestionState(s, currentRound) === 'draft';
}

/**
 * Links between a comment and the edits that answer it (spec §7, #100).
 *
 * All derived from `Suggestion.inReplyTo`, the only place the link is
 * stored. Each of these returns a fresh array — never call one from
 * inside a zustand selector, or the renderer re-renders forever
 * (React #185). Derive after selecting.
 */
export function linkedSuggestions(suggestions: Suggestion[], threadId: string): Suggestion[] {
  return suggestions.filter((s) => s.inReplyTo === threadId);
}

export function linkedThread(
  comments: CommentThread[],
  suggestion: Suggestion,
): CommentThread | undefined {
  return suggestion.inReplyTo
    ? comments.find((c) => c.id === suggestion.inReplyTo)
    : undefined;
}

export interface LinkSummary {
  /** Still asking something of the author. */
  pending: Suggestion[];
  accepted: number;
  rejected: number;
}

/**
 * How a thread's linked edits stand.
 *
 * Pending and decided are split because they read differently: pending
 * rows are work, and decided ones are a record. Deciding every linked
 * edit deliberately does not resolve the thread — the edits being
 * handled is not evidence the comment is answered — so the decided
 * count stays visible as the evidence the author would resolve *on*.
 */
export function linkSummary(suggestions: Suggestion[], threadId: string): LinkSummary {
  const linked = linkedSuggestions(suggestions, threadId);
  return {
    pending: linked.filter((s) => s.status === 'pending'),
    accepted: linked.filter((s) => s.status === 'accepted').length,
    rejected: linked.filter((s) => s.status === 'rejected').length,
  };
}

/**
 * Validate an agent-supplied `in_reply_to` before it is stored.
 *
 * The agent writes this id, so it is untrusted input in the same sense
 * an agent-supplied path is. The check is deliberately narrow: reject
 * only what would be *false* — an id naming no thread in this document.
 * A link to a resolved thread is unusual but true, and refusing it would
 * throw away a correct edit over a judgement call that is the author's.
 */
export function validateInReplyTo(
  comments: CommentThread[],
  id: string | undefined,
): { threadId?: string } | { error: string } {
  if (id === undefined || id === '') return {};
  return comments.some((c) => c.id === id)
    ? { threadId: id }
    : { error: `no comment thread with id ${id} on this document` };
}

export interface ReviewCounts {
  unread: number;
  draft: number;
  awaiting: number;
  read: number;
  settled: number;
}

/** Counts for the summary bar (spec §4). */
export function countThreads(threads: CommentThread[], currentRound: number): ReviewCounts {
  const counts: ReviewCounts = { unread: 0, draft: 0, awaiting: 0, read: 0, settled: 0 };
  for (const t of threads) counts[threadState(t, currentRound)] += 1;
  return counts;
}
