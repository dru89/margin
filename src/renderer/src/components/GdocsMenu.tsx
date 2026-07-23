import { useEffect, useRef, useState } from 'react';
import { useLocked, useStore } from '@/store';

/**
 * The Google Docs chip in the toolbar: share-to-create, push, open,
 * unlink. Push failures surface inline — a moved Doc asks before
 * pushing anyway (spec's conflict rule); pending suggested edits are a
 * refusal with a pointer into Docs.
 */
export function GdocsMenu() {
  const sync = useStore((s) => s.gdocsSync);
  const save = useStore((s) => s.save);
  const openSettings = useStore((s) => s.setSettingsOpen);
  const locked = useLocked();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!sync) return null;

  const reset = () => {
    setError(null);
    setConflict(false);
    setNote(null);
  };

  const share = async () => {
    reset();
    await save();
    const result = await window.margin.gdocsShareCreate();
    if (result.error) setError(result.error);
    else setNote('Created and linked.');
  };

  const push = async (force: boolean) => {
    reset();
    await save();
    const result = await window.margin.gdocsPushDoc(force);
    if (result.conflict) setConflict(true);
    else if (result.error) setError(result.error);
    else
      setNote(
        result.regions === 0
          ? 'Already up to date — nothing to push.'
          : `Pushed — ${result.regions} section${result.regions === 1 ? '' : 's'} updated.`,
      );
  };

  const suggestionRefusal = error !== null && /pending suggested edits/.test(error);

  return (
    <div className="submit-wrap" ref={wrapRef}>
      <button
        className={`status-chip ${sync.linked ? 'status-neutral' : 'status-muted'}`}
        title="Google Docs"
        onClick={() => {
          reset();
          setOpen(!open);
        }}
      >
        {sync.busy ? 'Docs…' : sync.linked ? 'Docs ✓' : 'Docs'}
      </button>
      {open && (
        <div className="popover gdocs-popover">
          {!sync.connected ? (
            <>
              <p className="gdocs-note">
                Connect a Google account in Settings to share documents to Google Docs.
              </p>
              <button
                className="btn"
                onClick={() => {
                  setOpen(false);
                  openSettings(true);
                }}
              >
                Open Settings
              </button>
            </>
          ) : !sync.linked ? (
            <>
              <p className="gdocs-note">
                Create a Google Doc from this document and keep it linked for future pushes.
              </p>
              <button
                className="btn btn-primary"
                disabled={sync.busy || locked}
                onClick={() => void share()}
              >
                {sync.busy ? 'Creating…' : 'Share to Google Docs'}
              </button>
            </>
          ) : (
            <>
              <div className="gdocs-row">
                <button
                  className="btn btn-primary"
                  disabled={sync.busy || locked}
                  onClick={() => void push(false)}
                >
                  {sync.busy ? 'Pushing…' : 'Push to Google Docs'}
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => sync.docUrl && void window.margin.openUrl(sync.docUrl)}
                >
                  Open ↗
                </button>
              </div>
              {sync.lastSyncAt && (
                <p className="gdocs-note">
                  Last pushed {new Date(sync.lastSyncAt).toLocaleString()}. Only changed blocks
                  are rewritten; comments on unchanged text survive.
                </p>
              )}
              {conflict && (
                <div className="gdocs-warn">
                  <p>
                    The Google Doc changed since the last push — collaborators may have edited
                    it. Pushing will make it match this markdown, overwriting their text
                    changes in edited blocks.
                  </p>
                  <button className="btn btn-danger" disabled={sync.busy} onClick={() => void push(true)}>
                    Push anyway
                  </button>
                </div>
              )}
              {error && (
                <div className="gdocs-warn">
                  <p>{error}</p>
                  {suggestionRefusal && sync.docUrl && (
                    <button
                      className="btn"
                      onClick={() => void window.margin.openUrl(sync.docUrl!)}
                    >
                      Resolve in Google Docs ↗
                    </button>
                  )}
                </div>
              )}
              {note && !error && !conflict && <p className="gdocs-note">{note}</p>}
              <button
                className="btn btn-ghost gdocs-unlink"
                disabled={sync.busy}
                onClick={() => void window.margin.gdocsUnlink()}
              >
                Unlink (keeps the Doc)
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
