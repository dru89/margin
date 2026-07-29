import { useEffect, useRef, useState } from 'react';
import { useLocked, useStore } from '@/store';
import { draftHasContent } from '@shared/composer';
import { History } from '@/components/History';
import { ModelPicker } from '@/components/ModelPicker';
import { GdocsMenu } from '@/components/GdocsMenu';

const ellipsize = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

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
  const modelPref = useStore((s) => s.modelPref);
  const setModelPref = useStore((s) => s.setModelPref);
  // Select stable references; derive arrays after (fresh arrays from a
  // zustand selector re-render forever — React #185).
  const discussion = useStore((s) => s.discussion);
  const workspace = useStore((s) => s.workspace);
  const removeDiscussionMessage = useStore((s) => s.removeDiscussionMessage);
  const composerAnchor = useStore((s) => s.composerAnchor);
  const composerDraft = useStore((s) => s.composerDraft);
  const openRevisions = useStore((s) => s.openRevisions);
  const queued = discussion.filter((m) => m.pending);
  const modifiedDocs = workspace?.files.filter((f) => f.modified && f.kind === 'markdown') ?? [];
  // The quote it is attached to, when the composer holds work that will not
  // travel with this round — nothing when it is empty or closed.
  const unfinished =
    composerAnchor && draftHasContent(composerDraft, composerAnchor.quote)
      ? ellipsize(composerAnchor.quote, 32)
      : null;
  const [submitOpen, setSubmitOpen] = useState(false);
  /** Initialize was clicked and the repo still isn't there — git is missing. */
  const [gitUnavailable, setGitUnavailable] = useState(false);
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
          // Keep focus in the editor: without this the button steals it on
          // mousedown, the selection clears, and the click that follows has
          // nothing left to comment on (#91).
          onMouseDown={(e) => e.preventDefault()}
          onClick={openComposer}
        >
          + Comment
        </button>
        <History inGitRepo={doc.inGitRepo} />
        <GdocsMenu />
        {!doc.inGitRepo && (
          <button
            className="status-chip status-warn"
            title={
              gitUnavailable
                ? 'Margin could not run git. Install it to enable checkpoints and history.'
                : 'Checkpoints are disabled without a git repository.'
            }
            // A click that changes nothing has to say why. Without this the
            // button simply did nothing when git was missing (#145).
            onClick={() => void window.margin.gitInit().then((ok) => setGitUnavailable(!ok))}
          >
            {gitUnavailable ? 'Git not available' : 'No repo · Initialize'}
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
              <ModelPicker value={modelPref} onChange={setModelPref} />
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
              {/* Said before the button rather than after it: a round is
                  where Margin asks for a folder (spec §4), and being
                  asked is less jarring than being surprised. */}
              {!doc.hasProject && (
                <p className="manifest-unfinished">
                  Claude works in a project — you’ll pick a folder for this one first.
                </p>
              )}
              {/* Submission is never blocked by an open draft (spec §8): a
                  disabled primary action would have to explain itself, and
                  this list already exists to say what travels. */}
              {unfinished && (
                <p className="manifest-unfinished">
                  Your unfinished comment on “{unfinished}” isn’t included.
                </p>
              )}
              {/* An open edit box cannot survive the round — what it is
                  changing becomes history, so the box closes and the typing
                  goes with it. Said here, before that happens. */}
              {openRevisions.length > 0 && (
                <p className="manifest-unfinished">
                  {openRevisions.length === 1
                    ? 'An edit you haven’t saved will be discarded; the original wording goes with this round.'
                    : `${openRevisions.length} edits you haven’t saved will be discarded; the original wording goes with this round.`}
                </p>
              )}
              <div className="card-actions">
                <button className="btn btn-primary" onClick={doSubmit}>
                  Send round {nextRound}
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
