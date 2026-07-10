import { useEffect, useRef, useState } from 'react';
import { useLocked, useStore } from '@/store';

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

  const [submitOpen, setSubmitOpen] = useState(false);
  const [note, setNote] = useState('');
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
    void submit(note.trim() || undefined);
    setNote('');
  };

  if (!doc) return null;

  return (
    <header className="toolbar">
      <div className="toolbar-left">
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
              <textarea
                autoFocus
                value={note}
                placeholder="Optional note for this round — what should Claude focus on?"
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doSubmit();
                  if (e.key === 'Escape') setSubmitOpen(false);
                }}
              />
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
