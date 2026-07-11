import { useEffect, useMemo } from 'react';
import type { WorkspaceFile } from '@shared/types';
import { useLocked, useStore } from '@/store';

function FileRow({ file, active }: { file: WorkspaceFile; active: boolean }) {
  const switchToFile = useStore((s) => s.switchToFile);
  const locked = useLocked();
  const attention = file.openComments + file.pendingSuggestions;
  const isMd = file.kind === 'markdown';
  return (
    <button
      className={`explorer-file${active ? ' on' : ''}${isMd ? '' : ' explorer-file-other'}`}
      disabled={locked}
      title={isMd ? file.rel : `${file.rel} — opens in its default app`}
      onClick={() =>
        void (isMd ? switchToFile(file.path) : window.margin.openExternal(file.path))
      }
    >
      {file.modified ? <span className="explorer-dot" title="Modified since last commit" /> : <span className="explorer-dot-spacer" />}
      <span className="explorer-name">{file.name}</span>
      {attention > 0 && (
        <span className="explorer-badge" title={`${file.openComments} open comments, ${file.pendingSuggestions} pending suggestions`}>
          {attention}
        </span>
      )}
    </button>
  );
}

export function Explorer() {
  const workspace = useStore((s) => s.workspace);
  const doc = useStore((s) => s.doc);
  const explorerOpen = useStore((s) => s.explorerOpen);
  const loadWorkspace = useStore((s) => s.loadWorkspace);

  // Refresh badges when the window regains focus (files change outside).
  useEffect(() => {
    const onFocus = () => void loadWorkspace();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadWorkspace]);

  const groups = useMemo(() => {
    const byDir = new Map<string, WorkspaceFile[]>();
    for (const f of workspace?.files ?? []) {
      const list = byDir.get(f.dir) ?? [];
      list.push(f);
      byDir.set(f.dir, list);
    }
    return [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [workspace]);

  if (!explorerOpen || !workspace) return null;

  return (
    <nav className="explorer">
      <div className="explorer-head" title={workspace.root}>
        {workspace.rootName}
      </div>
      {groups.map(([dir, files]) => (
        <div key={dir || '.'} className="explorer-group">
          {dir && <div className="explorer-dir">{dir}</div>}
          {files.map((f) => (
            <FileRow key={f.path} file={f} active={f.path === doc?.filePath} />
          ))}
        </div>
      ))}
    </nav>
  );
}
