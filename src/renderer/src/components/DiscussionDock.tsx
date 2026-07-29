import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store';
import { Md } from '@/components/Md';
import { MentionTextarea } from '@/components/MentionTextarea';

/** Rewrite a queued message in place; its own buffer, discarded on cancel. */
function QueuedEditor({
  text,
  onSave,
  onCancel,
}: {
  text: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(text);
  return (
    <div className="msg-edit">
      <MentionTextarea
        autoFocus
        value={value}
        onChange={setValue}
        onSubmit={() => value.trim() && onSave(value)}
        onEscape={onCancel}
      />
      <div className="card-actions">
        <button className="btn btn-primary" disabled={!value.trim()} onClick={() => onSave(value)}>
          Save
        </button>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The project discussion as a dock pinned to the sidebar's bottom edge
 * (spec §1): composer always visible, queued count always visible, expands
 * in place. Shared across every document in the workspace.
 */
export function DiscussionDock() {
  const messages = useStore((s) => s.discussion);
  // The discussion is project-scoped, so without a project there is
  // nowhere to keep it. Unavailable rather than inert: queueing a message
  // the author watched appear and then silently dropping it would be
  // worse than the accident this rule exists to stop (spec §4).
  const hasProject = useStore((s) => s.doc?.hasProject ?? true);
  const askToAdopt = useStore((s) => s.askToAdopt);
  const open = useStore((s) => s.dockOpen);
  const toggleDock = useStore((s) => s.toggleDock);
  const addDiscussionMessage = useStore((s) => s.addDiscussionMessage);
  const removeDiscussionMessage = useStore((s) => s.removeDiscussionMessage);
  const editDiscussionMessage = useStore((s) => s.editDiscussionMessage);
  const [text, setText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  // The submit popover names it too — a queued message is going with this
  // round, so an unsaved rewrite of it is about to be lost (spec §8).
  const setRevisionOpen = useStore((s) => s.setRevisionOpen);
  useEffect(() => {
    if (!editingId) return;
    const key = `discussion:${editingId}`;
    setRevisionOpen(key, true);
    return () => setRevisionOpen(key, false);
  }, [editingId, setRevisionOpen]);
  const [pulse, setPulse] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const queued = messages.filter((m) => m.pending);
  const latest = messages[messages.length - 1];

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: 'end' });
  }, [open, messages.length]);

  const send = () => {
    if (!text.trim()) return;
    addDiscussionMessage(text);
    setText('');
    if (!open) {
      // One wash pulse on the queued chip so the collapsed dock acknowledges.
      setPulse(true);
      setTimeout(() => setPulse(false), 320);
    }
  };

  return (
    <div className={`discussion-dock${open ? ' dock-open' : ''}`}>
      <div className="dock-head" onClick={toggleDock} role="button" aria-expanded={open}>
        <h3 className="sidebar-heading">Discussion</h3>
        {queued.length > 0 && (
          <span className={`status-chip status-warn${pulse ? ' chip-pulse' : ''}`}>
            {queued.length} queued
          </span>
        )}
        <span className="dock-chevron">▸</span>
      </div>

      {!open && latest && (
        <div className="dock-preview" title={latest.text}>
          {latest.author === 'user' ? 'You' : 'Claude'} · {latest.text}
        </div>
      )}

      {open && (
        <div className="dock-msgs">
          {messages.length === 0 && (
            <div className="sidebar-empty dock-empty">
              <div className="empty-glyph">§</div>
              <p>No discussion yet.</p>
              <p className="hint">
                Set the stage — what this project is, who it's for. Reference files as{' '}
                <code>@path</code>; messages send with your next round.
              </p>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`msg msg-${m.author}${m.pending ? ' msg-queued-card' : ''}`}>
              <div className="msg-head">
                <span className={`chip chip-${m.author}`}>
                  {m.author === 'user' ? 'You' : 'Claude'}
                </span>
                {m.pending ? (
                  <span className="msg-queued">
                    Queued{' '}
                    {/* Queued means unsent, so it can still be rewritten —
                        the asymmetry where it could only be deleted and
                        retyped had no justification (#89). */}
                    <button
                      className="queued-edit"
                      title="Edit queued message"
                      onClick={() => setEditingId(editingId === m.id ? null : m.id)}
                    >
                      Edit
                    </button>
                    <button
                      className="queued-remove"
                      title="Remove queued message"
                      onClick={() => removeDiscussionMessage(m.id)}
                    >
                      ✕
                    </button>
                  </span>
                ) : (
                  <span className="msg-round">
                    {new Date(m.createdAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                )}
              </div>
              {editingId === m.id ? (
                <QueuedEditor
                  text={m.text}
                  onSave={(next) => {
                    editDiscussionMessage(m.id, next);
                    setEditingId(null);
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <Md text={m.text} />
              )}
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}

      {!hasProject ? (
        <div className="dock-composer dock-no-project">
          <p>
            The discussion is shared across a project’s documents — choose a folder to start
            one.
          </p>
          <button className="btn" onClick={() => askToAdopt()}>
            Choose a folder…
          </button>
        </div>
      ) : (
        <div className="dock-composer">
          <MentionTextarea
            value={text}
            placeholder="Message for the next round…"
            onChange={setText}
            onSubmit={send}
          />
          <button
            className="btn"
            disabled={!text.trim()}
            onClick={send}
            title="Queue (Cmd/Ctrl+Enter)"
          >
            Queue
          </button>
        </div>
      )}
    </div>
  );
}
