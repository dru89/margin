import { useEffect } from 'react';
import { useStore } from '@/store';
import { Welcome } from '@/components/Welcome';
import { Explorer } from '@/components/Explorer';
import { Toolbar } from '@/components/Toolbar';
import { EditorPane } from '@/components/EditorPane';
import { Preview } from '@/components/Preview';
import { Sidebar } from '@/components/Sidebar';
import { AgentBar } from '@/components/AgentBar';

export function App() {
  const doc = useStore((s) => s.doc);
  const mode = useStore((s) => s.mode);
  const init = useStore((s) => s.init);

  useEffect(() => init(), [init]);

  // Drop a markdown file anywhere to open it (Netscope window rules apply).
  useEffect(() => {
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      for (const file of e.dataTransfer?.files ?? []) {
        if (/\.(md|markdown|mdx|txt)$/i.test(file.name)) {
          void window.margin.openPath(window.margin.pathForFile(file));
        }
      }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  if (!doc) return <Welcome />;

  return (
    <div className="app">
      <Toolbar />
      <div className="workspace">
        <Explorer />
        <main className="document">{mode === 'write' ? <EditorPane /> : <Preview />}</main>
        <Sidebar />
      </div>
      <AgentBar />
    </div>
  );
}
