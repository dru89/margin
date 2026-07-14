import { useEffect, useRef, useState } from 'react';
import type { ProjectProposal, SetupMessage } from '@shared/types';
import { Md } from '@/components/Md';

/**
 * The welcome-screen "start a new project" conversation. Each send runs one
 * fresh agent turn (transcript rides in the prompt, like review rounds).
 * The agent's propose_project result renders as a card; one confirm
 * materializes folder + files + git repo, and the transcript seeds the
 * project discussion.
 */
export function ProjectSetup({ onBack }: { onBack: () => void }) {
  const [transcript, setTranscript] = useState<SetupMessage[]>([]);
  const [proposal, setProposal] = useState<ProjectProposal | null>(null);
  const [projectsDir, setProjectsDir] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.margin.getProjectsDir().then(setProjectsDir);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [transcript, proposal, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const next: SetupMessage[] = [...transcript, { author: 'user', text }];
    setTranscript(next);
    setInput('');
    setBusy(true);
    setError(null);
    try {
      const result = await window.margin.setupMessage(next);
      setTranscript([...next, { author: 'agent', text: result.reply }]);
      if (result.proposal) setProposal(result.proposal);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTranscript(next); // keep the user's message; they can retry
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!proposal || busy) return;
    setBusy(true);
    setError(null);
    try {
      // The window switches to the new document via docLoaded.
      await window.margin.createProject(proposal, transcript);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="setup">
      <div className="setup-thread">
        {transcript.length === 0 && (
          <p className="setup-intro">
            Tell Claude what you want to write — a proposal, a design doc, a talk. It will sketch a
            starting structure; nothing is created until you confirm.
          </p>
        )}
        {transcript.map((m, i) => (
          <div key={i} className={`setup-msg setup-msg-${m.author}`}>
            <span className="setup-who">{m.author === 'user' ? 'You' : 'Claude'}</span>
            <Md text={m.text} />
          </div>
        ))}
        {proposal && (
          <div className="setup-card">
            <div className="setup-card-title">{proposal.title}</div>
            <div className="setup-card-desc">{proposal.description}</div>
            <div className="setup-card-path">
              {projectsDir}/{proposal.folderName}/
            </div>
            <ul className="setup-card-files">
              {proposal.files.map((f) => (
                <li key={f.path}>{f.path}</li>
              ))}
            </ul>
            <div className="setup-card-actions">
              <button className="btn btn-primary" disabled={busy} onClick={() => void create()}>
                Create project
              </button>
              <span className="setup-card-hint">or keep talking to adjust it</span>
            </div>
          </div>
        )}
        {busy && <div className="setup-busy">Claude is thinking…</div>}
        {error && <p className="proposal-error">{error}</p>}
        <div ref={endRef} />
      </div>
      <div className="setup-compose">
        <textarea
          className="setup-input"
          placeholder={transcript.length === 0 ? 'What are we writing?' : 'Reply…'}
          value={input}
          rows={2}
          disabled={busy}
          autoFocus
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="setup-compose-row">
          <button className="btn btn-ghost" onClick={onBack}>
            Back
          </button>
          <button className="btn btn-primary" disabled={busy || !input.trim()} onClick={() => void send()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
