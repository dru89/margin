import { useEffect, useMemo, useState } from 'react';
import type { RecentFile } from '@shared/types';
import { ProjectSetup } from '@/components/ProjectSetup';

/** Recents deduped to their project folders — the unit is the project, not the file. */
interface RecentProject {
  root: string;
  name: string;
  /** Most recently opened file in this project — what a click reopens. */
  filePath: string;
}

export function Welcome() {
  const [recents, setRecents] = useState<RecentFile[]>([]);
  const [settingUp, setSettingUp] = useState(false);
  const isMac = navigator.userAgent.includes('Mac');

  useEffect(() => {
    void window.margin.getRecents().then(setRecents);
  }, []);

  const projects = useMemo<RecentProject[]>(() => {
    const seen = new Map<string, RecentProject>();
    for (const r of recents) {
      const root = r.root ?? (r.path.slice(0, r.path.lastIndexOf('/')) || r.path);
      if (!seen.has(root)) {
        seen.set(root, { root, name: root.split('/').pop() || root, filePath: r.path });
      }
    }
    return [...seen.values()];
  }, [recents]);

  if (settingUp) {
    return (
      <div className="welcome">
        <div className="welcome-card welcome-card-setup">
          <h1 className="welcome-title">New project</h1>
          <ProjectSetup onBack={() => setSettingUp(false)} />
        </div>
      </div>
    );
  }

  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1 className="welcome-title">Margin</h1>
        <p className="welcome-tagline">
          Write in markdown. Comment in the margin.
          <br />
          Claude reviews in rounds — you decide what lands.
        </p>
        <div className="welcome-actions">
          <button className="btn btn-primary btn-lg" onClick={() => void window.margin.openFileDialog()}>
            Open a markdown file…
          </button>
          <button className="btn btn-ghost" onClick={() => setSettingUp(true)}>
            Start a new project with Claude…
          </button>
        </div>
        {projects.length > 0 && (
          <div className="welcome-recents">
            {projects.slice(0, 6).map((p) => (
              <button
                key={p.root}
                className="welcome-recent"
                title={p.root}
                onClick={() => void window.margin.openPath(p.filePath)}
              >
                <span className="welcome-recent-name">{p.name}</span>
                <span className="welcome-recent-path">{p.root}</span>
              </button>
            ))}
          </div>
        )}
        <p className="welcome-hint">
          <kbd>{isMac ? '⌘O' : 'Ctrl+O'}</kbd> to open · or drop a file anywhere
        </p>
      </div>
    </div>
  );
}
