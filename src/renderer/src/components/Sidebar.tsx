import { useEffect, useMemo, useState } from 'react';
import type { CommentThread, Suggestion } from '@shared/types';
import { useLocked, useStore } from '@/store';
import { revealRange } from '@/editorBridge';
import { Discussion } from '@/components/Discussion';
import { Md } from '@/components/Md';

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
  const addSuggestion = useStore((s) => s.addSuggestion);
  const closeComposer = useStore((s) => s.closeComposer);
  const [mode, setMode] = useState<'comment' | 'suggest'>('comment');
  const [text, setText] = useState('');
  const [replacement, setReplacement] = useState<string | null>(null);
  if (!composerAnchor) return null;

  const effectiveReplacement = replacement ?? composerAnchor.quote;
  const submit = () => {
    if (mode === 'comment') {
      addComment(text);
    } else {
      addSuggestion(effectiveReplacement, text);
    }
    setText('');
    setReplacement(null);
  };
  const canSubmit =
    mode === 'comment'
      ? text.trim().length > 0
      : effectiveReplacement !== composerAnchor.quote;

  return (
    <div className="card card-composer">
      <div className="sidebar-tabs composer-modes">
        <button className={`btn btn-toggle${mode === 'comment' ? ' on' : ''}`} onClick={() => setMode('comment')}>
          Comment
        </button>
        <button className={`btn btn-toggle${mode === 'suggest' ? ' on' : ''}`} onClick={() => setMode('suggest')}>
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
      <textarea
        autoFocus
        value={text}
        placeholder={mode === 'comment' ? 'Comment for Claude…' : 'Why? (optional)'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSubmit) submit();
          if (e.key === 'Escape') closeComposer();
        }}
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
  const accept = useStore((s) => s.acceptSuggestion);
  const reject = useStore((s) => s.rejectSuggestion);
  const setActiveAnchor = useStore((s) => s.setActiveAnchor);
  const activeAnchorId = useStore((s) => s.activeAnchorId);
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const isActive = activeAnchorId === suggestion.id;

  return (
    <div
      id={`card-${suggestion.id}`}
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
      {suggestion.note && <Md text={suggestion.note} />}
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
      id={`card-${thread.id}`}
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
      <Md text={thread.text} />
      {thread.replies.map((r) => (
        <div key={r.id} className="reply">
          <AuthorChip author={r.author} />
          <Md text={r.text} />
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
  const sidebarTab = useStore((s) => s.sidebarTab);
  const setSidebarTab = useStore((s) => s.setSidebarTab);
  const [showArchive, setShowArchive] = useState(false);
  const activeAnchorId = useStore((s) => s.activeAnchorId);
  const queuedCount = review?.discussion.filter((m) => m.pending).length ?? 0;

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
      <div className="sidebar-tabs" role="tablist">
        <button
          className={`btn btn-toggle${sidebarTab === 'review' ? ' on' : ''}`}
          onClick={() => setSidebarTab('review')}
        >
          Review
        </button>
        <button
          className={`btn btn-toggle${sidebarTab === 'discussion' ? ' on' : ''}`}
          onClick={() => setSidebarTab('discussion')}
        >
          Discussion{queuedCount > 0 ? ` · ${queuedCount}` : ''}
        </button>
      </div>
      {sidebarTab === 'discussion' ? (
        <Discussion />
      ) : (
        <>
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
                  <Md text={c.text} />
                </div>
              ))}
            </div>
          )}
        </section>
      )}
        </>
      )}
    </aside>
  );
}
