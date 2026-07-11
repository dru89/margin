import { useEffect, useRef, useState } from 'react';
import { useLocked, useStore } from '@/store';
import { History } from '@/components/History';

export function Toolbar() {
  const doc = useStore((s) => s.doc);
  const review = useStore((s) => s.review);
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const selection = useStore((s) => s.selection);
  const openComposer = useStore((s) => s.openComposer);
  const submit = useStore((s) => s.submit);
  const dirty = useStore((s) => s.dirty);
  const locked = useLocked();

  const reviewModel = useStore((s) => s.reviewModel);
  const setReviewModel = useStore((s) => s.setReviewModel);
  const setSidebarTab = useStore((s) => s.setSidebarTab);
  const queuedCount = useStore((s) => s.discussion.filter((m) => m.pending).length);
  const [submitOpen, setSubmitOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = window.margin.onMenuSubmit(() => setSubmitOpen(true));
    return unsub;
  }, []);

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
        {review && review.round > 0 && <span className="round-badge">Round {review.round}</span>}
        {!doc.inGitRepo && (
          <button
            className="btn btn-ghost git-warn"
            title="No git repository — checkpoints are disabled. Click to run git init."
            onClick={() => void window.margin.gitInit()}
          >
            ⚠ no repo
          </button>
        )}
      </div>
      <div className="toolbar-right">
        <button
          className="btn"
          disabled={!selection || locked || mode !== 'write'}
          title="Comment on selection (Cmd/Ctrl+M)"
          onClick={openComposer}
        >
          + Comment
        </button>
        <History inGitRepo={doc.inGitRepo} />
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
        <div className="submit-wrap">
          <button className="btn btn-primary" disabled={locked} onClick={() => setSubmitOpen(!submitOpen)}>
            Submit for review
          </button>
          {submitOpen && (
            <div className="popover" ref={popoverRef}>
              <p className="submit-summary">
                {queuedCount > 0
                  ? `${queuedCount} queued discussion message${queuedCount === 1 ? '' : 's'} will be sent with this round.`
                  : 'No queued discussion messages.'}{' '}
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setSidebarTab('discussion');
                    setSubmitOpen(false);
                  }}
                >
                  Write one
                </button>
              </p>
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
              <div className="card-actions">
                <button className="btn btn-primary" onClick={doSubmit}>
                  Start round {(review?.round ?? 0) + 1}
                </button>
                <button className="btn" onClick={() => setSubmitOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
