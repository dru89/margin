import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { FileProposal } from '@shared/types';
import { useLocked, useStore } from '@/store';

/**
 * Review surface for an agent file proposal: the staged content rendered
 * read-only, with the one explicit act that makes the file real. Nothing
 * exists on disk (outside .margin/) until "Accept file".
 */
export function ProposalView({ id }: { id: string }) {
  const closeProposal = useStore((s) => s.closeProposal);
  const acceptProposal = useStore((s) => s.acceptProposal);
  const rejectProposal = useStore((s) => s.rejectProposal);
  const locked = useLocked();
  const [data, setData] = useState<{ proposal: FileProposal; content: string } | null>();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void window.margin.readProposal(id).then((d) => {
      if (live) setData(d);
    });
    return () => {
      live = false;
    };
  }, [id]);

  if (data === undefined) return <div className="proposal-view" />;
  if (data === null || data.proposal.status !== 'pending') {
    return (
      <div className="proposal-view">
        <div className="proposal-gone">
          This proposal has already been decided.
          <button className="btn btn-ghost" onClick={closeProposal}>
            Back to document
          </button>
        </div>
      </div>
    );
  }

  const { proposal, content } = data;
  const isMd = /\.(md|markdown|mdx)$/i.test(proposal.path);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="proposal-view">
      <header className="proposal-head">
        <div className="proposal-title">
          <span className="proposal-chip">proposed file</span>
          <span className="proposal-path">{proposal.path}</span>
        </div>
        <p className="proposal-note">{proposal.note}</p>
        <div className="proposal-actions">
          <button
            className="btn btn-primary"
            disabled={locked || busy}
            onClick={() => void act(() => acceptProposal(proposal.id))}
          >
            Accept file
          </button>
          <button
            className="btn btn-danger"
            disabled={locked || busy}
            onClick={() => void act(() => rejectProposal(proposal.id, comment))}
          >
            Reject
          </button>
          <input
            className="proposal-reject-comment"
            placeholder="Why not? (optional — Claude reads this)"
            value={comment}
            disabled={locked || busy}
            onChange={(e) => setComment(e.target.value)}
          />
          <button className="btn btn-ghost" onClick={closeProposal}>
            Back
          </button>
        </div>
        {error && <p className="proposal-error">{error}</p>}
      </header>
      <div className="proposal-body preview-body">
        {isMd ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        ) : (
          <pre className="proposal-raw">{content}</pre>
        )}
      </div>
    </div>
  );
}
