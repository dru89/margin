import { useState } from 'react';
import { useStore } from '@/store';

export function AgentBar() {
  const agent = useStore((s) => s.agent);
  const activity = useStore((s) => s.activity);
  const cancelReview = useStore((s) => s.cancelReview);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);

  if (agent.phase === 'idle') return null;
  if ((agent.phase === 'done' || agent.phase === 'error') && dismissed === agent.detail) return null;

  return (
    <footer className={`agent-bar agent-${agent.phase}`}>
      <div className="agent-line">
        {agent.phase === 'running' && <span className="spinner" />}
        {agent.phase === 'done' && <span className="agent-icon">✓</span>}
        {agent.phase === 'error' && <span className="agent-icon">✕</span>}
        <span className="agent-detail">{agent.detail}</span>
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
        <div className="agent-log">
          {activity.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </footer>
  );
}
