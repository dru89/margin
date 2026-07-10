import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store';

/**
 * Document-level conversation: framing, goals, general feedback. User
 * messages queue ("pending") and are sent with the next review round; the
 * agent's closing message each round appears here as its reply.
 */
export function Discussion() {
  const review = useStore((s) => s.review);
  const addDiscussionMessage = useStore((s) => s.addDiscussionMessage);
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  const messages = review?.discussion ?? [];

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  const send = () => {
    addDiscussionMessage(text);
    setText('');
  };

  return (
    <div className="discussion">
      {messages.length === 0 && (
        <div className="sidebar-empty">
          <p>No discussion yet.</p>
          <p className="hint">
            Set the stage here — what this document is, who it's for, what good looks like.
            Messages are sent with your next review round.
          </p>
        </div>
      )}
      <div className="discussion-thread">
        {messages.map((m) => (
          <div key={m.id} className={`msg msg-${m.author}`}>
            <div className="msg-head">
              <span className={`chip chip-${m.author}`}>{m.author === 'user' ? 'You' : 'Claude'}</span>
              {m.pending ? (
                <span className="msg-queued">queued for round {m.round}</span>
              ) : (
                <span className="msg-round">round {m.round}</span>
              )}
            </div>
            <p className="msg-text">{m.text}</p>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="discussion-composer">
        <textarea
          value={text}
          placeholder="Message for the next round… (Cmd/Ctrl+Enter to queue)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
          }}
        />
        <button className="btn btn-primary" disabled={!text.trim()} onClick={send}>
          Queue message
        </button>
      </div>
    </div>
  );
}
