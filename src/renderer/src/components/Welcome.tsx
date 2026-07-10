import { useEffect, useState } from 'react';
import type { RecentFile } from '@shared/types';

export function Welcome() {
  const [recents, setRecents] = useState<RecentFile[]>([]);

  useEffect(() => {
    void window.margin.getRecents().then(setRecents);
  }, []);

  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1 className="welcome-title">Margin</h1>
        <p className="welcome-tagline">
          Write in markdown. Comment in the margin.
          <br />
          Claude reviews in rounds — you decide what lands.
        </p>
        <button className="btn btn-primary btn-lg" onClick={() => void window.margin.openFileDialog()}>
          Open a markdown file…
        </button>
        {recents.length > 0 && (
          <div className="welcome-recents">
            {recents.slice(0, 6).map((r) => (
              <button
                key={r.path}
                className="welcome-recent"
                title={r.path}
                onClick={() => void window.margin.openPath(r.path)}
              >
                <span className="welcome-recent-name">{r.name}</span>
                <span className="welcome-recent-path">{r.path}</span>
              </button>
            ))}
          </div>
        )}
        <p className="welcome-hint">
          <kbd>⌘O</kbd> / <kbd>Ctrl+O</kbd> to open · or drop a file anywhere
        </p>
      </div>
    </div>
  );
}
