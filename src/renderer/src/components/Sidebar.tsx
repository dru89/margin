import { useEffect, useMemo, useRef, useState } from 'react';
import type { Anchor, CommentThread, Suggestion } from '@shared/types';
import { useLocked, useStore } from '@/store';
import {
  countThreads,
  isUnread,
  latestExternalRound,
  latestActivity,
  suggestionNeedsYou,
  suggestionState,
  threadNeedsYou,
  threadState,
  type ThreadState,
} from '@shared/reviewState';
import { revealRange } from '@/editorBridge';
import { wordDiff } from '@shared/worddiff';
import { DiscussionDock } from '@/components/DiscussionDock';
import { MentionTextarea } from '@/components/MentionTextarea';
import { Md } from '@/components/Md';

function AuthorChip({ author, collaborator }: { author: 'user' | 'agent'; collaborator?: string }) {
  if (collaborator) return <span className="chip chip-collab">{collaborator}</span>;
  return <span className={`chip chip-${author}`}>{author === 'user' ? 'You' : 'Claude'}</span>;
}

function Quote({ text, orphaned }: { text: string; orphaned?: boolean }) {
  return (
    <blockquote className={`card-quote${orphaned ? ' card-quote-orphaned' : ''}`}>
      “{text.length > 90 ? `${text.slice(0, 89)}…` : text}”
      {orphaned && <span className="orphan-note">text no longer found</span>}
    </blockquote>
  );
}

/** "¶ <nearest heading above the anchor>" — the spec's card locator. */
function locatorFor(content: string, from: number): string {
  const before = content.slice(0, Math.max(0, from));
  const match = [...before.matchAll(/^#{1,6}\s+(.+)$/gm)].pop();
  const label = match ? match[1].trim() : 'top';
  return `¶ ${label.length > 24 ? `${label.slice(0, 23)}…` : label}`;
}

/** Shared pair-state classes + hover/click wiring for anchored cards. */
/**
 * A round stamp, shown only when the item predates the round being drafted
 * (spec §3). A stamp on everything is noise — in round 5, "Round 5" says
 * nothing the state has not already said.
 */
function RoundStamp({ round, at }: { round: number; at?: string }) {
  const current = useStore((s) => s.review?.round ?? 0);
  if (round >= current) return null;
  const when = at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null;
  return (
    <span className="rnd" title={`Round ${round}${when ? ` · ${when}` : ''}`}>
      Round {round}
    </span>
  );
}

/** The same words the summary bar uses, so the two never disagree. */
const STATE_LABEL: Record<ThreadState, string> = {
  draft: 'Not sent',
  awaiting: 'Awaiting reply',
  unread: 'Unread',
  read: '',
  settled: 'Resolved',
};

/** One message in a thread: the author chip introduces what it wrote. */
function Message({
  author,
  collaborator,
  round,
  at,
  text,
  docs,
}: {
  author: 'user' | 'agent';
  collaborator?: string;
  round: number;
  at?: string;
  text: string;
  docs?: boolean;
}) {
  return (
    <div className="thread-msg">
      <div className="thread-msg-head">
        <AuthorChip author={author} collaborator={collaborator} />
        {docs && <span className="chip chip-source">Docs</span>}
        <RoundStamp round={round} at={at} />
      </div>
      <Md text={text} />
    </div>
  );
}

function usePair(id: string, anchor: { from: number; to: number; orphaned?: boolean }) {
  const setActiveAnchor = useStore((s) => s.setActiveAnchor);
  const setHoveredAnchor = useStore((s) => s.setHoveredAnchor);
  const active = useStore((s) => s.activeAnchorId === id);
  const hot = useStore((s) => s.hoveredAnchorId === id);
  return {
    classes: `${active ? ' pair-active' : ''}${hot ? ' pair-hot' : ''}`,
    props: {
      onMouseEnter: () => setHoveredAnchor(id),
      onMouseLeave: () => setHoveredAnchor(null),
      onClick: () => {
        setActiveAnchor(id);
        if (!anchor.orphaned) revealRange(anchor.from, anchor.to);
      },
    },
  };
}

function Composer() {
  const composerAnchor = useStore((s) => s.composerAnchor);
  const addComment = useStore((s) => s.addComment);
  const addSuggestion = useStore((s) => s.addSuggestion);
  const closeComposer = useStore((s) => s.closeComposer);
  const [mode, setMode] = useState<'comment' | 'suggest'>('comment');
  const [text, setText] = useState('');
  const [replacement, setReplacement] = useState<string | null>(null);
  if (!composerAnchor) return null;

  const effectiveReplacement = replacement ?? composerAnchor.quote;
  const submit = () => {
    if (mode === 'comment') addComment(text);
    else addSuggestion(effectiveReplacement, text);
    setText('');
    setReplacement(null);
  };
  const canSubmit =
    mode === 'comment' ? text.trim().length > 0 : effectiveReplacement !== composerAnchor.quote;

  return (
    <div className="card card-composer">
      <div className="composer-modes">
        <button
          className={`btn btn-toggle${mode === 'comment' ? ' on' : ''}`}
          onClick={() => setMode('comment')}
        >
          Comment
        </button>
        <button
          className={`btn btn-toggle${mode === 'suggest' ? ' on' : ''}`}
          onClick={() => setMode('suggest')}
        >
          Suggest
        </button>
      </div>
      {mode === 'comment' ? (
        <Quote text={composerAnchor.quote} />
      ) : (
        <textarea
          className="composer-replacement"
          value={effectiveReplacement}
          onChange={(e) => setReplacement(e.target.value)}
        />
      )}
      <MentionTextarea
        autoFocus
        value={text}
        placeholder={mode === 'comment' ? 'Comment for Claude…' : 'Why? (optional)'}
        onChange={setText}
        onSubmit={() => canSubmit && submit()}
        onEscape={closeComposer}
      />
      <div className="card-actions">
        <button className="btn btn-primary" disabled={!canSubmit} onClick={submit}>
          {mode === 'comment' ? 'Comment' : 'Suggest'}
        </button>
        <button className="btn" onClick={closeComposer}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function SuggestionCard({ suggestion }: { suggestion: Suggestion }) {
  const locked = useLocked();
  const content = useStore((s) => s.content);
  const accept = useStore((s) => s.acceptSuggestion);
  const reject = useStore((s) => s.rejectSuggestion);
  const pair = usePair(suggestion.id, suggestion.anchor);
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState('');

  const currentRound = useStore((s) => s.review?.round ?? 0);
  const state = suggestionState(suggestion, currentRound);
  const deletion = suggestion.replacement === '';

  // Only what changes, rather than the whole clause struck and re-inserted
  // (#98). Both strings are already stored — this is presentation.
  const parts = wordDiff(suggestion.anchor.quote, suggestion.replacement);

  return (
    <div
      id={`card-${suggestion.id}`}
      className={`card card-suggestion state-${state}${pair.classes}`}
      aria-label="suggestion"
      {...pair.props}
    >
      <div className="card-head">
        {/* The operation is named here and shown in the diff; the leading
            edge is state, and only state (spec §6). */}
        <span className="state-label">
          <span className={deletion ? 'op-del' : 'op-edit'}>{deletion ? 'Deletion' : 'Edit'}</span>
          {state === 'draft' && ' · not sent'}
        </span>
        {suggestion.anchor.orphaned && <span className="badge">Text gone</span>}
        <span className="card-locator">{locatorFor(content, suggestion.anchor.from)}</span>
        <RoundStamp round={suggestion.round} at={suggestion.createdAt} />
      </div>
      <div className="thread-msg-head">
        <AuthorChip author={suggestion.author} />
      </div>
      <p className="card-diff">
        {parts.map((p, i) => (
          <span
            key={i}
            className={p.kind === 'del' ? 'diff-del' : p.kind === 'ins' ? 'diff-ins' : undefined}
          >
            {p.text}
          </span>
        ))}
      </p>
      {suggestion.note && <Md text={suggestion.note} />}
      {suggestion.anchor.orphaned && (
        <p className="orphan-note">anchor text no longer found — accept is disabled</p>
      )}
      {!rejecting ? (
        <div className="card-actions">
          <button
            className="btn btn-primary"
            disabled={locked || suggestion.anchor.orphaned}
            onClick={(e) => {
              e.stopPropagation();
              accept(suggestion.id);
            }}
          >
            Accept
          </button>
          <button
            className="btn btn-reject"
            disabled={locked}
            onClick={(e) => {
              e.stopPropagation();
              setRejecting(true);
            }}
          >
            Reject
          </button>
        </div>
      ) : (
        <div className="card-reject" onClick={(e) => e.stopPropagation()}>
          <MentionTextarea
            autoFocus
            value={rejectNote}
            placeholder="Why? (optional — Claude reads this next round)"
            onChange={setRejectNote}
            onSubmit={() => reject(suggestion.id, rejectNote)}
            onEscape={() => setRejecting(false)}
          />
          <div className="card-actions">
            <button className="btn btn-danger" onClick={() => reject(suggestion.id, rejectNote)}>
              Reject
            </button>
            <button className="btn" onClick={() => setRejecting(false)}>
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ThreadCard({ thread }: { thread: CommentThread }) {
  const locked = useLocked();
  const replyTo = useStore((s) => s.replyToThread);
  const setThreadStatus = useStore((s) => s.setThreadStatus);
  const pair = usePair(thread.id, thread.anchor);
  const [reply, setReply] = useState('');
  const [resolveOpen, setResolveOpen] = useState(false);
  const [sendingToDoc, setSendingToDoc] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const imported = thread.provenance === 'imported';
  const addDocReply = useStore((s) => s.addDocReply);
  const currentRound = useStore((s) => s.review?.round ?? 0);
  const markThreadSeen = useStore((s) => s.markThreadSeen);
  const state = threadState(thread, currentRound);
  const last = latestActivity(thread);
  const [expanded, setExpanded] = useState(false);
  // Past four messages, keep the opening and the last two; fold the rest.
  // Folding by age instead would hide the question in a two-message thread
  // — the very thing the reply is answering.
  const hidden = expanded || thread.replies.length + 1 <= 4 ? 0 : thread.replies.length - 2;
  const shownReplies = hidden > 0 ? thread.replies.slice(hidden) : thread.replies;

  const sendReply = () => {
    replyTo(thread.id, reply);
    setReply('');
  };

  const sendReplyOnDoc = async () => {
    if (!thread.driveCommentId) return;
    setSendingToDoc(true);
    setDocError(null);
    const result = await window.margin.gdocsReplyOnDoc(thread.driveCommentId, reply);
    setSendingToDoc(false);
    if (result.error) {
      setDocError(result.error);
      return;
    }
    addDocReply(thread.id, reply, result.driveReplyId!);
    setReply('');
  };

  return (
    <div
      id={`card-${thread.id}`}
      className={`card card-comment state-${state}${pair.classes}`}
      aria-label="comment thread"
      {...pair.props}
      onClick={() => {
        // Clicking a thread is a deliberate "I'm looking at this", and it
        // already focuses the anchor — so it is what clears unread (spec §4).
        pair.props.onClick();
        markThreadSeen(thread.id);
      }}
    >
      <div className="card-head">
        {/* Always mounted so clearing unread fades rather than snaps. */}
        <span className={`unread-dot${state === 'unread' ? '' : ' is-gone'}`} aria-hidden="true" />
        {STATE_LABEL[state] && <span className="state-label">{STATE_LABEL[state]}</span>}
        {thread.anchor.orphaned && <span className="badge">Text gone</span>}
        {imported && <span className="chip chip-source" title="Imported from the linked Google Doc">Docs</span>}
        <RoundStamp round={last.round} at={thread.createdAt} />
        {imported ? (
          <span className="resolve-wrap">
            <button
              className="btn btn-ghost"
              disabled={locked}
              title="Resolve thread"
              onClick={(e) => {
                e.stopPropagation();
                setResolveOpen(!resolveOpen);
              }}
            >
              ✓ Resolve
            </button>
            {resolveOpen && (
              <span className="popover resolve-popover" onClick={(e) => e.stopPropagation()}>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setResolveOpen(false);
                    setThreadStatus(thread.id, 'resolved');
                  }}
                >
                  Resolve in Margin only
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setResolveOpen(false);
                    setThreadStatus(thread.id, 'resolved');
                    void window.margin
                      .gdocsResolveOnDoc(thread.driveCommentId!)
                      .then((r) => r.error && setDocError(r.error));
                  }}
                >
                  Resolve here and on the Doc
                </button>
              </span>
            )}
          </span>
        ) : (
          <button
            className="btn btn-ghost"
            disabled={locked}
            title="Resolve thread"
            onClick={(e) => {
              e.stopPropagation();
              setThreadStatus(thread.id, 'resolved');
            }}
          >
            ✓ Resolve
          </button>
        )}
      </div>
      <Quote text={thread.anchor.quote} orphaned={thread.anchor.orphaned} />
      {/* Oldest first, the order the conversation happened in (spec §3). */}
      <Message
        author={thread.author}
        collaborator={thread.collaborator}
        round={thread.round}
        at={thread.createdAt}
        text={thread.text}
      />
      {/* The middle folds, never the ends: the first message is the
          question and the last is where things stand (spec §3). */}
      {hidden > 0 && !expanded && (
        <button
          className="thread-fold"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(true);
          }}
        >
          <span className="thread-fold-line" />
          {hidden} earlier {hidden === 1 ? 'reply' : 'replies'}
          <span className="thread-fold-line" />
        </button>
      )}
      {shownReplies.map((r) => (
        <Message
          key={r.id}
          author={r.author}
          collaborator={r.collaborator}
          round={r.round}
          at={r.createdAt}
          text={r.text}
          docs={!!r.driveReplyId && !r.collaborator}
        />
      ))}
      <div className="card-replybox" onClick={(e) => e.stopPropagation()}>
        <MentionTextarea
          value={reply}
          placeholder="Reply…"
          onChange={setReply}
          onSubmit={sendReply}
        />
        {reply.trim() && (
          <button className="btn btn-primary" disabled={locked} onClick={sendReply}>
            Reply
          </button>
        )}
        {imported && reply.trim() && (
          <button
            className="btn"
            disabled={locked || sendingToDoc}
            title="Send this exact text as a reply on the Google Doc thread, under your account"
            onClick={() => void sendReplyOnDoc()}
          >
            {sendingToDoc ? 'Sending…' : 'Reply on Doc'}
          </button>
        )}
      </div>
      {imported && (
        <p className="gdocs-shadow-note">
          Replies stay in Margin unless sent with “Reply on Doc”.
        </p>
      )}
      {docError && <p className="gdocs-doc-error">{docError}</p>}
    </div>
  );
}

/**
 * Take the reader to a card: center it, mark the passage in the document,
 * and pulse the card so it is obvious which one arrived.
 *
 * Imperative on purpose. Driving this from an effect keyed on the active
 * id means clicking the same jump twice does nothing, because the state
 * never changes — and the pulse cannot be a class either, since the state
 * change that comes with focusing rewrites the card's className and would
 * strip it. A Web Animations call survives both.
 */
function focusCard(id: string): void {
  const el = document.getElementById(`card-${id}`);
  if (!el) return;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
  if (still) return;
  const pulse = () => {
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--user').trim();
    // Grows in, then dissolves at full width rather than shrinking back —
    // a ring collapsing to nothing is what made this read as a cut. The
    // color is soft and the exit is long; the eye should catch it without
    // being snapped at.
    el.animate(
      [
        { boxShadow: `0 0 0 0px ${accent}00`, easing: 'ease-out' },
        { boxShadow: `0 0 0 5px ${accent}59`, offset: 0.3, easing: 'ease-in-out' },
        { boxShadow: `0 0 0 5px ${accent}00` },
      ],
      { duration: 1500 },
    );
  };
  // Wait for the smooth scroll to land. Firing both at once means the pulse
  // peaks while the card is still traveling — usually off-screen — and is
  // over before it arrives.
  const scroller = el.closest('.review-scroll');
  if (!scroller) return pulse();
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    scroller.removeEventListener('scrollend', run);
    pulse();
  };
  scroller.addEventListener('scrollend', run, { once: true });
  window.setTimeout(run, 700); // in case the card was already in place
}

/**
 * What the last completed round produced, with a way into each piece
 * (spec §5, #103).
 *
 * A turn writes to two surfaces: prose lands in the project discussion
 * dock, per-thread replies and suggestions land here. Claude ends up
 * writing "see my thread reply" and the reply is somewhere else — so the
 * prose stays where it is, and this gives the sidebar its own record that
 * a turn happened, with jump links.
 *
 * It clears itself once every item in it has been dealt with, so it never
 * has to be dismissed to get out of the way.
 */
const MAX_JUMPS = 3;

function RoundHeader({
  filtered,
  onToggleFilter,
}: {
  filtered: boolean;
  onToggleFilter: () => void;
}) {
  const review = useStore((s) => s.review);
  const setActiveAnchor = useStore((s) => s.setActiveAnchor);
  const markThreadSeen = useStore((s) => s.markThreadSeen);
  const [dismissed, setDismissed] = useState<number | null>(null);

  const round = review?.round ?? 0;
  const answered = (review?.comments ?? []).filter(
    (c) => c.status === 'open' && latestExternalRound(c) === round,
  );
  const proposed = (review?.suggestions ?? []).filter(
    (s) => s.round === round && s.author === 'agent',
  );
  const outstanding =
    answered.some((c) => isUnread(c)) || proposed.some((s) => s.status === 'pending');

  if (round === 0 || dismissed === round || !outstanding) return null;

  // One list, document order — the same rule the sidebar itself follows.
  const items: Array<CommentThread | Suggestion> = [...answered, ...proposed.filter((s) => s.status === 'pending')]
    .sort((a, b) => a.anchor.from - b.anchor.from);
  const shown = items.slice(0, MAX_JUMPS);
  const rest = items.length - shown.length;

  const go = (id: string, anchor: Anchor, seen?: string) => {
    setActiveAnchor(id);
    if (seen) markThreadSeen(seen);
    // Mark the passage in the document too — a jump that only moves the
    // sidebar leaves the reader to find the text themselves.
    if (!anchor.orphaned) revealRange(anchor.from, anchor.to);
    // After the state change has rendered, so the card is there to scroll to.
    requestAnimationFrame(() => focusCard(id));
  };
  const parts = [
    answered.length > 0 && `replied to ${answered.length} ${answered.length === 1 ? 'thread' : 'threads'}`,
    proposed.length > 0 && `proposed ${proposed.length} ${proposed.length === 1 ? 'edit' : 'edits'}`,
  ].filter(Boolean);

  return (
    <div className="round-header">
      <div className="round-header-top">
        <strong>Round {round}</strong>
        <button
          className="round-dismiss"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={() => setDismissed(round)}
        >
          ✕
        </button>
      </div>
      <p>Claude {parts.join(' and ')}.</p>
      <div className="round-jumps">
        {shown.map((it) => (
          <button
            key={it.id}
            className="round-jump"
            onClick={() => go(it.id, it.anchor, 'replies' in it ? it.id : undefined)}
          >
            ↳ “{it.anchor.quote.length > 26 ? `${it.anchor.quote.slice(0, 25)}…` : it.anchor.quote}”
          </button>
        ))}
        {/* No attempt to rank: a turn can answer a dozen threads and nothing
            in the data says which matters most. Document order, capped, and
            the rest handed to the filter that already exists for this. */}
        {rest > 0 && (
          // Shares state with the All / Need you pair rather than silently
          // setting it: a control that changes something elsewhere and then
          // looks unchanged leaves no way back that the reader can see.
          <button
            className={`round-jump round-jump-more${filtered ? ' on' : ''}`}
            aria-pressed={filtered}
            onClick={onToggleFilter}
          >
            +{rest} more — review all
          </button>
        )}
      </div>
    </div>
  );
}

export function Sidebar() {
  const review = useStore((s) => s.review);
  const setThreadStatus = useStore((s) => s.setThreadStatus);
  const undoDecision = useStore((s) => s.undoDecision);
  const locked = useLocked();
  const [showArchive, setShowArchive] = useState(false);
  const archiveRef = useRef<HTMLElement>(null);
  // Opening the fold at the floor of the pane would otherwise reveal the
  // items below the fold — bring its heading up to the top instead, as far
  // as the scroll allows. Instant, not animated: this is a disclosure, and
  // a glide here reads as more ceremony than the action deserves.
  useEffect(() => {
    if (showArchive) archiveRef.current?.scrollIntoView({ block: 'start' });
  }, [showArchive]);
  const activeAnchorId = useStore((s) => s.activeAnchorId);

  // Bring the focused card into view when an editor highlight is clicked.
  useEffect(() => {
    if (!activeAnchorId) return;
    document
      .getElementById(`card-${activeAnchorId}`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeAnchorId]);

  const currentRound = review?.round ?? 0;
  const [onlyNeedsYou, setOnlyNeedsYou] = useState(false);

  const { pendingSuggestions, openThreads, archived, counts } = useMemo(() => {
    const comments = review?.comments ?? [];
    const suggestions = review?.suggestions ?? [];
    const open = comments.filter((c) => c.status === 'open');
    const pending = suggestions.filter((s) => s.status === 'pending');
    const c = countThreads(comments, currentRound);
    return {
      // Document order, always. The filter narrows the list; it never
      // reorders it, so a card stays where the document put it (spec §4).
      pendingSuggestions: [...pending].sort((a, b) => a.anchor.from - b.anchor.from),
      openThreads: [...open].sort((a, b) => a.anchor.from - b.anchor.from),
      archived: {
        threads: comments.filter((x) => x.status === 'resolved'),
        suggestions: suggestions.filter((x) => x.status !== 'pending'),
      },
      counts: {
        ...c,
        // Everything outstanding, threads and undecided suggestions alike —
        // both are someone waiting on the author.
        needsYou:
          open.filter((t) => threadNeedsYou(t, currentRound)).length +
          pending.filter((s) => suggestionNeedsYou(s, currentRound)).length,
        draft:
          c.draft + pending.filter((s) => suggestionState(s, currentRound) === 'draft').length,
      },
    };
  }, [review, currentRound]);

  const archivedCount = archived.threads.length + archived.suggestions.length;
  // The card being read stays put even once it stops qualifying, so the list
  // never moves out from under a click.
  const keep = (id: string, qualifies: boolean) => qualifies || id === activeAnchorId;
  // Threads and suggestions are one list in document order. Two sections
  // meant a comment on the first paragraph sat below a suggestion on the
  // ninth, which is not what a margin does (spec §4).
  const shown: Array<CommentThread | Suggestion> = [
    ...(onlyNeedsYou
      ? openThreads.filter((t) => keep(t.id, threadNeedsYou(t, currentRound)))
      : openThreads),
    ...(onlyNeedsYou
      ? pendingSuggestions.filter((s) => keep(s.id, suggestionNeedsYou(s, currentRound)))
      : pendingSuggestions),
  ].sort((a, b) => a.anchor.from - b.anchor.from);

  return (
    <aside className="sidebar">
      {/* Facts on top, the filter beneath them (spec §4). */}
      {(openThreads.length > 0 || pendingSuggestions.length > 0 || archivedCount > 0) && (
        <div className="review-summary">
          <div className="review-counts">
            {counts.needsYou > 0 && <span><b>{counts.needsYou}</b> need you</span>}
            {counts.draft > 0 && <span><b>{counts.draft}</b> not sent</span>}
            {counts.awaiting > 0 && <span><b>{counts.awaiting}</b> awaiting reply</span>}
            {archivedCount > 0 && <span><b>{archivedCount}</b> resolved</span>}
          </div>
          {counts.needsYou > 0 && (
            <div className="review-filters">
              <button
                className={`btn btn-toggle${onlyNeedsYou ? '' : ' on'}`}
                onClick={() => setOnlyNeedsYou(false)}
              >
                All
              </button>
              <button
                className={`btn btn-toggle${onlyNeedsYou ? ' on' : ''}`}
                onClick={() => setOnlyNeedsYou(true)}
              >
                Need you
              </button>
            </div>
          )}
        </div>
      )}
      <div className="review-scroll">
        <RoundHeader filtered={onlyNeedsYou} onToggleFilter={() => setOnlyNeedsYou(!onlyNeedsYou)} />
        <Composer />
        {pendingSuggestions.length === 0 && openThreads.length === 0 && (
          <div className="sidebar-empty">
            <div className="empty-glyph">¶</div>
            <p>Nothing to review yet.</p>
            <p className="hint">
              Claude's suggestions and your threads appear here after you submit a round.
            </p>
          </div>
        )}
        {shown.length > 0 && (
          <section>
            {shown.map((it) =>
              'replies' in it ? (
                <ThreadCard key={it.id} thread={it} />
              ) : (
                <SuggestionCard key={it.id} suggestion={it} />
              ),
            )}
          </section>
        )}
        {onlyNeedsYou && shown.length === 0 && (
          <p className="hint sidebar-filtered-empty">
            Nothing waiting on you.{' '}
            <button className="linkish" onClick={() => setOnlyNeedsYou(false)}>Show everything</button>
          </p>
        )}
        {archivedCount > 0 && (
          <section className="review-archive" ref={archiveRef}>
            <button
              className="btn btn-ghost sidebar-archive-toggle"
              onClick={() => setShowArchive(!showArchive)}
            >
              {showArchive ? '▾' : '▸'} Resolved & decided · {archivedCount}
            </button>
            {showArchive && (
              <div className="archive">
                {archived.suggestions.map((s) => (
                  <div key={s.id} className={`card card-archived status-${s.status}`}>
                    <div className="card-head">
                      <AuthorChip author={s.author} />
                      <span className="card-locator">{s.status}</span>
                      {/* A decision is undone as a decision — Cmd-Z would only
                          revert the text half and leave the review claiming it
                          landed (#128). */}
                      <button
                        className="btn btn-ghost undo-decision"
                        disabled={locked}
                        title="Put this back to pending"
                        onClick={() => undoDecision(s.id)}
                      >
                        Undo
                      </button>
                    </div>
                    <Quote text={s.anchor.quote} />
                    {s.decisionComment && <Md text={`“${s.decisionComment}”`} />}
                  </div>
                ))}
                {archived.threads.map((c) => (
                  <div key={c.id} className="card card-archived">
                    <div className="card-head">
                      <AuthorChip author={c.author} />
                      <button className="btn btn-ghost" onClick={() => setThreadStatus(c.id, 'open')}>
                        Reopen
                      </button>
                    </div>
                    <Md text={c.text} />
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
      <DiscussionDock />
    </aside>
  );
}
