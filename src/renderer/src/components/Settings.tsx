import { useCallback, useEffect, useState } from 'react';
import type { GdocsAuthStatus } from '@shared/types';
import { useStore } from '@/store';

/**
 * App settings overlay (menu Settings… / Cmd-,). Two sections: General
 * (projects folder) and Google Docs (OAuth client + connection). Auth
 * state lives in the main process; this screen pulls once on open and
 * then follows gdocsAuthChanged pushes.
 */
export function Settings() {
  const open = useStore((s) => s.settingsOpen);
  const close = useStore((s) => s.setSettingsOpen);
  const [status, setStatus] = useState<GdocsAuthStatus | null>(null);
  const [projectsDir, setProjectsDir] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState('');

  useEffect(() => {
    if (!open) return;
    setError(null);
    void window.margin.gdocsStatus().then(setStatus);
    void window.margin.getAppSettings().then((s) => setProjectsDir(s.projectsDir));
    return window.margin.onGdocsAuthChanged(setStatus);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  const importPasted = useCallback(async () => {
    setError(null);
    const result = await window.margin.gdocsImportClient(pasteText);
    if (result.ok) {
      setPasting(false);
      setPasteText('');
    } else {
      setError(result.error ?? 'Could not read that client JSON.');
    }
  }, [pasteText]);

  if (!open) return null;

  const hasClient = status !== null && status.clientSource !== 'none';

  return (
    <div className="settings-overlay" onClick={() => close(false)}>
      <div
        className="settings-modal"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-header">
          <h2>Settings</h2>
          <button className="btn btn-ghost" onClick={() => close(false)} aria-label="Close">
            ✕
          </button>
        </header>

        <section className="settings-section">
          <h3>General</h3>
          <div className="settings-row">
            <div>
              <div className="settings-label">Projects folder</div>
              <div className="settings-detail">{projectsDir}</div>
            </div>
            <button
              className="btn"
              onClick={() =>
                void window.margin.chooseProjectsDir().then((s) => setProjectsDir(s.projectsDir))
              }
            >
              Change…
            </button>
          </div>
        </section>

        <section className="settings-section">
          <h3>Google Docs</h3>

          <div className="settings-row">
            <div>
              <div className="settings-label">Connection</div>
              <div className="settings-detail">
                {status === null
                  ? 'Checking…'
                  : status.connecting
                    ? 'Waiting for approval in your browser… Blocked or stuck? Your organization may require a different OAuth client — import it below, then retry.'
                    : status.connected
                      ? 'Connected — Margin can sync documents it creates or opens.'
                      : hasClient
                        ? 'Not connected.'
                        : 'No OAuth client configured — import one below to enable sync.'}
              </div>
            </div>
            {status?.connecting ? (
              <button className="btn" onClick={() => void window.margin.gdocsCancelConnect()}>
                Cancel
              </button>
            ) : status?.connected ? (
              <button className="btn" onClick={() => void window.margin.gdocsDisconnect()}>
                Disconnect
              </button>
            ) : (
              <button
                className="btn btn-primary"
                disabled={!hasClient}
                onClick={() => void window.margin.gdocsConnect()}
              >
                Connect Google
              </button>
            )}
          </div>

          <div className="settings-row">
            <div>
              <div className="settings-label">OAuth client</div>
              <div className="settings-detail">
                {status === null
                  ? '…'
                  : status.clientSource === 'file'
                    ? status.clientPath
                    : status.clientSource === 'default'
                      ? 'Using Margin’s built-in client.'
                      : 'None. Import the JSON downloaded from Google Cloud Console (Desktop app credential), or paste one a colleague shared.'}
              </div>
            </div>
            <div className="settings-actions">
              <button
                className="btn"
                onClick={() => {
                  setError(null);
                  void window.margin.gdocsImportClient().then((r) => {
                    if (!r.ok) setError(r.error ?? 'Import failed.');
                  });
                }}
              >
                Import file…
              </button>
              <button className="btn btn-ghost" onClick={() => setPasting((p) => !p)}>
                Paste JSON
              </button>
            </div>
          </div>

          {pasting && (
            <div className="settings-paste">
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder='{"installed": {"client_id": "…", "client_secret": "…"}}'
                rows={5}
                spellCheck={false}
              />
              <div className="settings-actions">
                <button
                  className="btn btn-primary"
                  disabled={pasteText.trim() === ''}
                  onClick={() => void importPasted()}
                >
                  Save client
                </button>
              </div>
            </div>
          )}

          {error && <div className="settings-error">{error}</div>}

          <p className="settings-footnote">
            Margin only requests the <code>drive.file</code> scope: it can touch documents it
            creates or that you explicitly open with it, and nothing else in your Drive.
          </p>
        </section>
      </div>
    </div>
  );
}
