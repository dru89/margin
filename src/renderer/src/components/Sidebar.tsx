import { useMemo, useState } from 'react';
import type { CommentThread, Suggestion } from '@shared/types';
import { useLocked, useStore } from '@/store';
import { revealRange } from '@/editorBridge';

function AuthorChip({ author }: { author: 'user' | 'agent' }) {
  return <span className={`chip chip-${author}`}>{author === 'user' ? 'You' : 'Claude'}</span>;
}

function Quote({ text, orphaned }: { text: string; orphaned?: boolean }) {
  return (
    <blockquote className={`card-quote${orphaned ? ' card-quote-orphaned' : ''}`}>
      {text.length > 160 ? `${text.slice(0, 159)}…` : text}
      {orphaned && <span className="orphan-note">text no longer found</span>}
    </blockquote>
  );
}

function Composer() {
  const composerAnchor = useStore((s) => s.composerAnchor);
  const addComment = useStore((s) => s.addComment);
  const closeComposer = useStore((s) => s.closeComposer);
  const [text, setText] = useState('');
  if (!composerAnchor) return null;
  return (
    <div className="card card-composer">
      <Quote text={composerAnchor.quote} />
      <textarea
        autoFocus
        value={text}
        placeholder="Comment for Claude…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            addComment(text);
            setText('');
          }
          if (e.key === 'Escape') closeComposer();
        }}
      />
      <div className="card-actions">
        <button className="btn btn-primary" disabled={!text.trim()} onClick={() => { addComment(text); setText(''); }}>
          Comment
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
  const accept = useStore((s) => s.acceptSuggestion);
  const reject = useStore((s) => s.rejectSuggestion);
  const setActiveAnchor = useStore((s) => s.setActiveAnchor);
  const activeAnchorId = useStore((s) => s.activeAnchorId);
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const isActive = activeAnchorId === suggestion.id;

  return (
    <div
      className={`card card-suggestion${isActive ? ' card-active' : ''}`}
      onClick={() => {
        setActiveAnchor(suggestion.id);
        if (!suggestion.anchor.orphaned) revealRange(suggestion.anchor.from, suggestion.anchor.to);
      }}
    >
      <div className="card-head">
        <AuthorChip author={suggestion.author} />
        <span className="card-kind">suggests</span>
      </div>
      <div className="diff">
        <del>{suggestion.anchor.quote || '∅'}</del>
        <ins>{suggestion.replacement || '∅ (delete)'}</ins>
      </div>
      {suggestion.note && <p className="card-note">{suggestion.note}</p>}
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
            className="btn"
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
          <textarea
            autoFocus
            value={rejectNote}
            placeholder="Why? (optional — Claude reads this next round)"
            onChange={(e) => setRejectNote(e.target.value)}
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
  const setActiveAnchor = useStore((s) => s.setActiveAnchor);
  const activeAnchorId = useStore((s) => s.activeAnchorId);
  const [reply, setReply] = useState('');
  const isActive = activeAnchorId === thread.id;

  const sendReply = () => {
    replyTo(thread.id, reply);
    setReply('');
  };

  return (
    <div
      className={`card card-thread${isActive ? ' card-active' : ''}`}
      onClick={() => {
        setActiveAnchor(thread.id);
        if (!thread.anchor.orphaned) revealRange(thread.anchor.from, thread.anchor.to);
      }}
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
      <p className="card-note">{thread.text}</p>
      {thread.replies.map((r) => (
        <div key={r.id} className="reply">
          <AuthorChip author={r.author} />
          <p>{r.text}</p>
        </div>
      ))}
      <div className="card-replybox" onClick={(e) => e.stopPropagation()}>
        <textarea
          value={reply}
          placeholder="Reply…"
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendReply();
          }}
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
      <Composer />
      {pendingSuggestions.length === 0 && openThreads.length === 0 && (
        <div className="sidebar-empty">
          <p>No open threads.</p>
          <p className="hint">
            Select text and press <kbd>⌘M</kbd> / <kbd>Ctrl+M</kbd> to comment, or submit for a
            review round.
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
          <button className="btn btn-ghost sidebar-archive-toggle" onClick={() => setShowArchive(!showArchive)}>
            {showArchive ? '▾' : '▸'} Resolved & decided · {archivedCount}
          </button>
          {showArchive && (
            <div className="archive">
              {archived.suggestions.map((s) => (
                <div key={s.id} className={`card card-archived status-${s.status}`}>
                  <div className="card-head">
                    <AuthorChip author={s.author} />
                    <span className="card-kind">{s.status}</span>
                  </div>
                  <Quote text={s.anchor.quote} />
                  {s.decisionComment && <p className="card-note">“{s.decisionComment}”</p>}
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
                  <p className="card-note">{c.text}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </aside>
  );
}
