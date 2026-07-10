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
