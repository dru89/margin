import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store';

/** 32px status strip: one chip states the round's state, detail line beside it. */
export function AgentBar() {
  const agent = useStore((s) => s.agent);
  const round = useStore((s) => s.review?.round ?? 0);
  const activity = useStore((s) => s.activity);
  const cancelReview = useStore((s) => s.cancelReview);
  const [dismissed, setDismissed] = useState<string | null>(null);
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

  if (agent.phase === 'idle') return null;
  if ((agent.phase === 'done' || agent.phase === 'error') && dismissed === agent.detail) return null;

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
        {agent.phase === 'error' && <span className="status-chip status-danger">✕ Round failed</span>}
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
          {agent.phase === 'running' ? (
            <button className="btn btn-ghost" onClick={() => void cancelReview()}>
              Cancel
            </button>
          ) : (
            <button className="btn btn-ghost" onClick={() => setDismissed(agent.detail)}>
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
