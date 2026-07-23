import { useEffect, useRef, useState } from 'react';
import { useLocked, useStore } from '@/store';
import { History } from '@/components/History';
import { GdocsMenu } from '@/components/GdocsMenu';

export function Toolbar() {
  const doc = useStore((s) => s.doc);
  const review = useStore((s) => s.review);
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const selection = useStore((s) => s.selection);
  const previewQuote = useStore((s) => s.previewQuote);
  const openComposer = useStore((s) => s.openComposer);
  const submit = useStore((s) => s.submit);
  const dirty = useStore((s) => s.dirty);
  const locked = useLocked();
  const reviewModel = useStore((s) => s.reviewModel);
  const setReviewModel = useStore((s) => s.setReviewModel);
  // Select stable references; derive arrays after (fresh arrays from a
  // zustand selector re-render forever — React #185).
  const discussion = useStore((s) => s.discussion);
  const workspace = useStore((s) => s.workspace);
  const removeDiscussionMessage = useStore((s) => s.removeDiscussionMessage);
  const queued = discussion.filter((m) => m.pending);
  const modifiedDocs = workspace?.files.filter((f) => f.modified && f.kind === 'markdown') ?? [];
  const [submitOpen, setSubmitOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => window.margin.onMenuSubmit(() => setSubmitOpen(true)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        openComposer();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openComposer]);

  const doSubmit = () => {
    setSubmitOpen(false);
    void submit();
  };

  if (!doc) return null;
  const nextRound = (review?.round ?? 0) + 1;

  return (
    <header className="toolbar">
      <div className="toolbar-left">
        <button
          className="btn btn-ghost"
          title="Toggle file explorer"
          onClick={useStore.getState().toggleExplorer}
        >
          ☰
        </button>
        <span className="doc-title">{doc.fileName}</span>
        {dirty && <span className="dirty-dot" title="Unsaved changes" />}
        {review && review.round > 0 && (
          <span className="status-chip status-neutral">Round {review.round}</span>
        )}
      </div>
      <div className="toolbar-right">
        <div className="mode-toggle" role="tablist">
          <button
            className={`btn btn-toggle${mode === 'write' ? ' on' : ''}`}
            onClick={() => setMode('write')}
          >
            Write
          </button>
          <button
            className={`btn btn-toggle${mode === 'preview' ? ' on' : ''}`}
            onClick={() => setMode('preview')}
          >
            Preview
          </button>
        </div>
        <span className="tb-divider" />
        <button
          className="btn btn-ghost"
          disabled={locked || (mode === 'write' ? !selection : !previewQuote)}
          title="Comment on selection (Cmd/Ctrl+M)"
          onClick={openComposer}
        >
          + Comment
        </button>
        <History inGitRepo={doc.inGitRepo} />
        <GdocsMenu />
        {!doc.inGitRepo && (
          <button
            className="status-chip status-warn"
            title="Checkpoints are disabled without a git repository."
            onClick={() => void window.margin.gitInit()}
          >
            No repo · Initialize
          </button>
        )}
        <span className="tb-divider" />
        <div className="submit-wrap">
          <button
            className="btn btn-primary"
            disabled={locked}
            onClick={() => setSubmitOpen(!submitOpen)}
          >
            Submit for review
            {queued.length > 0 && <span className="queue-count">+{queued.length}</span>}
          </button>
          {submitOpen && (
            <div className="popover" ref={popoverRef}>
              <label className="model-row">
                Model
                <select
                  value={reviewModel ?? ''}
                  onChange={(e) => setReviewModel(e.target.value || undefined)}
                >
                  <option value="">Claude Code default</option>
                  <option value="opus">Opus</option>
                  <option value="sonnet">Sonnet</option>
                  <option value="haiku">Haiku</option>
                </select>
              </label>
              <h4 className="sidebar-heading popover-manifest-head">Goes with this round</h4>
              {modifiedDocs.length > 0 && (
                <p className="manifest-files">
                  Your edits · {modifiedDocs.map((f) => f.name).join(', ')}
                </p>
              )}
              {queued.map((m) => (
                <div key={m.id} className="queued-item">
                  <span className="queued-text">{m.text}</span>
                  <button
                    className="remove"
                    title="Remove queued message"
                    onClick={() => removeDiscussionMessage(m.id)}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {modifiedDocs.length === 0 && queued.length === 0 && (
                <p className="manifest-files">Comments and review state for {doc.fileName}.</p>
              )}
              <div className="card-actions">
                <button className="btn btn-primary" onClick={doSubmit}>
                  Send round {nextRound} →
                </button>
                <button className="btn" onClick={() => setSubmitOpen(false)}>
                  Cancel
                </button>
              </div>
              <p className="popover-hint">
                Queued messages only travel with a round — nothing is sent live.
              </p>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
