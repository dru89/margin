import { useEffect, useState } from 'react';
import type { AdoptionOptions } from '@shared/types';
import { useStore } from '@/store';

const basename = (p: string): string => p.split('/').filter(Boolean).pop() ?? p;

/**
 * "Which folder is this project?" — the one prompt in the adoption path
 * (spec §5).
 *
 * **Two offers and an escape, not an OS folder picker.** A bare picker
 * asks the author to think about paths at the moment they are thinking
 * about writing, and lets them choose `/`. The document's own folder is
 * the default because it is right most of the time; the repository above
 * it is offered when it differs because that is the boundary someone
 * already drew around this work.
 *
 * It appears when an action needs a project — today that is submitting a
 * round, since a round writes agent notes and can stage proposals.
 * Confirming carries on with whatever asked.
 */
export function AdoptProject() {
  const prompt = useStore((s) => s.adoptPrompt);
  const error = useStore((s) => s.adoptError);
  const cancel = useStore((s) => s.cancelAdopt);
  const adopt = useStore((s) => s.adopt);
  const doc = useStore((s) => s.doc);
  const [options, setOptions] = useState<AdoptionOptions | null>(null);
  /** A folder found by browsing — a third option, once it exists. */
  const [browsed, setBrowsed] = useState<string | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!prompt) return;
    setBrowsed(null);
    setWorking(false);
    void window.margin.adoptionOptions().then((opts) => {
      setOptions(opts);
      setChoice(opts.parent ?? opts.gitRoot);
    });
  }, [prompt]);

  useEffect(() => {
    if (!prompt) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prompt, cancel]);

  if (!prompt || !doc) return null;

  const browse = async () => {
    const picked = await window.margin.chooseProjectFolder();
    if (!picked) return;
    setBrowsed(picked);
    setChoice(picked);
  };

  const confirm = async () => {
    if (!choice) return;
    setWorking(true);
    await adopt(choice);
    setWorking(false);
  };

  const rows: { path: string; note: string }[] = [];
  if (options?.parent) rows.push({ path: options.parent, note: 'This document’s folder' });
  if (options?.gitRoot) rows.push({ path: options.gitRoot, note: 'The repository it’s in' });
  if (browsed && !rows.some((r) => r.path === browsed)) {
    rows.push({ path: browsed, note: 'The folder you chose' });
  }

  return (
    <div className="settings-overlay" onMouseDown={cancel}>
      <div className="settings-modal adopt-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Which folder is this project?</h2>
        </div>
        <div className="settings-section">
          <p className="adopt-lede">
            Claude keeps its notes, your discussion, and what it learns about this work in
            the project folder. Your comments and edits are already saved beside{' '}
            <strong>{doc.fileName}</strong> — this is about everything else.
          </p>
          <div className="adopt-options">
            {rows.map((row) => (
              <label key={row.path} className={`adopt-option${choice === row.path ? ' on' : ''}`}>
                <input
                  type="radio"
                  name="adopt-root"
                  checked={choice === row.path}
                  onChange={() => setChoice(row.path)}
                />
                <span className="adopt-option-text">
                  <span className="adopt-name">{basename(row.path)}</span>
                  <span className="adopt-note">{row.note}</span>
                  <span className="adopt-path">{row.path}</span>
                </span>
              </label>
            ))}
          </div>
          <button className="btn btn-ghost adopt-browse" onClick={() => void browse()}>
            Choose another folder…
          </button>
          {error && <p className="adopt-error">{error}</p>}
          <p className="settings-detail adopt-footnote">
            Creates <code>margin.json</code> there. Nothing else in the folder changes.
          </p>
          <div className="card-actions">
            <button
              className="btn btn-primary"
              disabled={!choice || working}
              onClick={() => void confirm()}
            >
              {working ? 'Creating…' : 'Create project'}
            </button>
            <button className="btn" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
