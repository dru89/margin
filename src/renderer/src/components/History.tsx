import { useState } from 'react';
import { useLocked } from '@/store';

interface LogEntry {
  hash: string;
  date: string;
  message: string;
}

/**
 * Git history for the current document (checkpoints + any other commits).
 * Restore checkpoints the current state first, then checks out the doc and
 * its sidecar from the chosen commit — always reversible via the next entry.
 */
export function History({ inGitRepo }: { inGitRepo: boolean }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const locked = useLocked();

  const toggle = async () => {
    if (!open) setEntries(await window.margin.gitLog());
    setOpen(!open);
    setConfirming(null);
  };

  const restore = async (hash: string) => {
    setOpen(false);
    setConfirming(null);
    await window.margin.gitRestore(hash);
  };

  if (!inGitRepo) return null;

  return (
    <div className="submit-wrap">
      <button className="btn btn-ghost" title="Document history (git log)" onClick={() => void toggle()}>
        History
      </button>
      {open && (
        <div className="popover history-popover">
          {entries === null && <p className="hint">Loading…</p>}
          {entries?.length === 0 && <p className="hint">No commits touch this file yet.</p>}
          {entries?.map((e, i) => (
            <div key={e.hash} className="history-row">
              <span className="history-msg">{e.message}</span>
              <span className="history-meta">
                <code>{e.hash}</code> · {new Date(e.date).toLocaleString()}
                {i > 0 &&
                  (confirming === e.hash ? (
                    <>
                      {' '}
                      · <button className="btn btn-ghost history-restore" disabled={locked} onClick={() => void restore(e.hash)}>
                        Confirm restore
                      </button>
                      <button className="btn btn-ghost" onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      {' '}
                      · <button
                        className="btn btn-ghost history-restore"
                        disabled={locked}
                        title="Checkpoint current state, then restore this version"
                        onClick={() => setConfirming(e.hash)}
                      >
                        Restore
                      </button>
                    </>
                  ))}
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
