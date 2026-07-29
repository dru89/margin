import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store';

/** 32px status strip: one chip states the round's state, detail line beside it. */
export function AgentBar() {
  const agent = useStore((s) => s.agent);
  const peerRound = useStore((s) => s.peerRound);
  const round = useStore((s) => s.review?.round ?? 0);
  const activity = useStore((s) => s.activity);
  const cancelReview = useStore((s) => s.cancelReview);
  const submit = useStore((s) => s.submit);
  // Dismissal is per *occurrence*, cleared when the next round starts.
  // Keying it to the message text meant a second identical failure — the
  // retry that fails the same way, which is the likely one — stayed
  // hidden behind the first dismissal, so clicking Submit appeared to do
  // nothing at all.
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (agent.phase === 'running') setDismissed(false);
  }, [agent.phase]);
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Follow the tail only when the user is already at the bottom, so
  // scrolling back to read isn't yanked away (issue #105).
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [activity, showLog]);

  // A round in another window on this project. Shown, never locking:
  // that turn owns its own document's review, not this one's (spec §8).
  if (agent.phase === 'idle') {
    if (!peerRound?.running) return null;
    return (
      <footer className="agent-bar agent-peer">
        <div className="agent-line">
          <span className="status-chip status-agent">
            <span className="spinner" /> Working
          </span>
          <span className="agent-detail">
            Claude is reviewing {peerRound.document} in another window.
          </span>
        </div>
      </footer>
    );
  }
  if ((agent.phase === 'done' || agent.phase === 'error') && dismissed) return null;

  return (
    <footer className={`agent-bar agent-${agent.phase}`}>
      <div className="agent-line">
        {agent.phase === 'running' && (
          <span className="status-chip status-agent">
            <span className="spinner" /> Working
          </span>
        )}
        {agent.phase === 'done' && (
          <span className="status-chip status-agent">✓ Round {round} returned</span>
        )}
        {agent.phase === 'error' && (
          <span className="status-chip status-danger">
            {agent.failure?.rolledBack ? '✕ Round not sent' : '✕ Round failed'}
          </span>
        )}
        {activity.length > 0 ? (
          <button
            className="agent-detail agent-detail-button"
            title={showLog ? 'Hide the full log' : 'Show the full log'}
            onClick={() => setShowLog(!showLog)}
          >
            {agent.detail}
          </button>
        ) : (
          <span className="agent-detail">{agent.detail}</span>
        )}
        <span className="agent-actions">
          {activity.length > 0 && (
            <button className="btn btn-ghost" onClick={() => setShowLog(!showLog)}>
              {showLog ? 'Hide log' : 'Log'}
            </button>
          )}
          {/* Offered only when the round was put back: retrying then means
              exactly "send this again", the same act as the first attempt.
              After a partial round it would mean something else — a new
              round on top of work that already landed — so the author
              submits that themselves, deliberately. */}
          {agent.phase === 'error' && agent.failure?.rolledBack && agent.failure.retryable && (
            <button className="btn btn-ghost" onClick={() => void submit()}>
              Retry
            </button>
          )}
          {agent.phase === 'running' ? (
            <button className="btn btn-ghost" onClick={() => void cancelReview()}>
              Cancel
            </button>
          ) : (
            <button className="btn btn-ghost" onClick={() => setDismissed(true)}>
              Dismiss
            </button>
          )}
        </span>
      </div>
      {showLog && (
        <div className="agent-log" ref={logRef}>
          {activity.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </footer>
  );
}
