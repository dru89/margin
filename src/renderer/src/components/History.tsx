import { useState } from 'react';

interface LogEntry {
  hash: string;
  date: string;
  message: string;
}

/** Read-only git history for the current document (checkpoints + any other commits). */
export function History({ inGitRepo }: { inGitRepo: boolean }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<LogEntry[] | null>(null);

  const toggle = async () => {
    if (!open) setEntries(await window.margin.gitLog());
    setOpen(!open);
  };

  if (!inGitRepo) return null;

  return (
    <div className="submit-wrap">
      <button className="btn" title="Document history (git log)" onClick={() => void toggle()}>
        History
      </button>
      {open && (
        <div className="popover history-popover">
          {entries === null && <p className="hint">Loading…</p>}
          {entries?.length === 0 && <p className="hint">No commits touch this file yet.</p>}
          {entries?.map((e) => (
            <div key={e.hash} className="history-row">
              <span className="history-msg">{e.message}</span>
              <span className="history-meta">
                <code>{e.hash}</code> · {new Date(e.date).toLocaleString()}
              </span>
            </div>
          ))}
          <div className="card-actions">
            <button className="btn" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
