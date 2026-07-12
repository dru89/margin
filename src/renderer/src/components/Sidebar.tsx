import { useEffect, useMemo, useState } from 'react';
import type { CommentThread, Suggestion } from '@shared/types';
import { useLocked, useStore } from '@/store';
import { revealRange } from '@/editorBridge';
import { DiscussionDock } from '@/components/DiscussionDock';
import { MentionTextarea } from '@/components/MentionTextarea';
import { Md } from '@/components/Md';

function AuthorChip({ author }: { author: 'user' | 'agent' }) {
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

  // One ellipsized context line: the tail of what lands (or leaves).
  const context = suggestion.replacement
    ? `→ …${suggestion.replacement.slice(-70)}`
    : `− …${suggestion.anchor.quote.slice(-70)}`;

  return (
    <div
      id={`card-${suggestion.id}`}
      className={`card card-suggestion${pair.classes}`}
      aria-label="suggestion"
      {...pair.props}
    >
      <div className="card-head">
        <AuthorChip author={suggestion.author} />
        <span className="card-locator">{locatorFor(content, suggestion.anchor.from)}</span>
      </div>
      <p className="card-context">{context}</p>
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

  const sendReply = () => {
    replyTo(thread.id, reply);
    setReply('');
  };

  return (
    <div
      id={`card-${thread.id}`}
      className={`card card-comment${pair.classes}`}
      aria-label="comment thread"
      {...pair.props}
    >
      <div className="card-head">
        <AuthorChip author={thread.author} />
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
      </div>
      <Quote text={thread.anchor.quote} orphaned={thread.anchor.orphaned} />
      <Md text={thread.text} />
      {thread.replies.map((r) => (
        <div key={r.id} className="reply">
          <AuthorChip author={r.author} />
          <Md text={r.text} />
        </div>
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
      </div>
    </div>
  );
}

export function Sidebar() {
  const review = useStore((s) => s.review);
  const setThreadStatus = useStore((s) => s.setThreadStatus);
  const [showArchive, setShowArchive] = useState(false);
  const activeAnchorId = useStore((s) => s.activeAnchorId);

  // Bring the focused card into view when an editor highlight is clicked.
  useEffect(() => {
    if (!activeAnchorId) return;
    document
      .getElementById(`card-${activeAnchorId}`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeAnchorId]);

  const { pendingSuggestions, openThreads, archived } = useMemo(() => {
    const comments = review?.comments ?? [];
    const suggestions = review?.suggestions ?? [];
    return {
      pendingSuggestions: suggestions
        .filter((s) => s.status === 'pending')
        .sort((a, b) => a.anchor.from - b.anchor.from),
      openThreads: comments
        .filter((c) => c.status === 'open')
        .sort((a, b) => a.anchor.from - b.anchor.from),
      archived: {
        threads: comments.filter((c) => c.status === 'resolved'),
        suggestions: suggestions.filter((s) => s.status !== 'pending'),
      },
    };
  }, [review]);

  const archivedCount = archived.threads.length + archived.suggestions.length;

  return (
    <aside className="sidebar">
      <div className="review-scroll">
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
        {pendingSuggestions.length > 0 && (
          <section>
            <h3 className="sidebar-heading">Suggestions · {pendingSuggestions.length}</h3>
            {pendingSuggestions.map((s) => (
              <SuggestionCard key={s.id} suggestion={s} />
            ))}
          </section>
        )}
        {openThreads.length > 0 && (
          <section>
            <h3 className="sidebar-heading">Comments · {openThreads.length}</h3>
            {openThreads.map((c) => (
              <ThreadCard key={c.id} thread={c} />
            ))}
          </section>
        )}
        {archivedCount > 0 && (
          <section>
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
