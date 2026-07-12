import { useStore } from '@/store';

/** Shown when the file changed on disk while the editor has unsaved edits. */
export function ConflictBar() {
  const diskConflict = useStore((s) => s.diskConflict);
  const resolveConflict = useStore((s) => s.resolveConflict);
  if (!diskConflict) return null;
  return (
    <div className="conflict-bar">
      <span className="status-chip status-warn">
        <span className="dot" /> Changed on disk
      </span>
      <span className="conflict-text">
        This file was edited outside Margin while you have unsaved changes.
      </span>
      <span className="conflict-actions">
        <button className="btn" onClick={() => void resolveConflict('reload')}>
          Reload theirs
        </button>
        <button className="btn btn-primary" onClick={() => void resolveConflict('keep')}>
          Keep mine
        </button>
      </span>
    </div>
  );
}
