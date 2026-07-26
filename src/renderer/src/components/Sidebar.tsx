import { useEffect, useMemo, useRef, useState } from 'react';
import type { Anchor, CommentThread, Suggestion } from '@shared/types';
import { useLocked, useStore } from '@/store';
import {
  countThreads,
  isUnread,
  latestExternalRound,
  latestActivity,
  linkSummary,
  linkedSuggestions,
  replyEditable,
  suggestionEditable,
  suggestionNeedsYou,
  suggestionState,
  threadEditable,
  threadNeedsYou,
  threadState,
  type ThreadState,
} from '@shared/reviewState';
import { centerOnPos, revealRange } from '@/editorBridge';
import { wordDiff } from '@shared/worddiff';
import { DiscussionDock } from '@/components/DiscussionDock';
import { MentionTextarea } from '@/components/MentionTextarea';
import { Md } from '@/components/Md';

function AuthorChip({ author, collaborator }: { author: 'user' | 'agent'; collaborator?: string }) {
  if (collaborator) return <span className="chip chip-collab">{collaborator}</span>;
  return <span className={`chip chip-${author}`}>{author === 'user' ? 'You' : 'Claude'}</span>;
}

function Quote({ text, orphaned }: { text: string; orphaned?: boolean }) {
  return (
    <blockquote className={`card-quote${orphaned ? ' card-quote-orphaned' : ''}`}>
      “{text.length > 90 ? `${text.slice(0, 89)}…` : text}”
      {orphaned && <span className="orphan-note">text no longer found</span>}
    </blockquote>
  );
}

/** "¶ <nearest heading above the anchor>" — the spec's card locator. */
function locatorFor(content: string, from: number): string {
  const before = content.slice(0, Math.max(0, from));
  const match = [...before.matchAll(/^#{1,6}\s+(.+)$/gm)].pop();
  const label = match ? match[1].trim() : 'top';
  return `¶ ${label.length > 24 ? `${label.slice(0, 23)}…` : label}`;
}

/** Shared pair-state classes + hover/click wiring for anchored cards. */
/**
 * A round stamp, shown only when the item predates the round being drafted
 * (spec §3). A stamp on everything is noise — in round 5, "Round 5" says
 * nothing the state has not already said.
 */
function RoundStamp({ round, at }: { round: number; at?: string }) {
  const current = useStore((s) => s.review?.round ?? 0);
  if (round >= current) return null;
  const when = at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null;
  return (
    <span className="rnd" title={`Round ${round}${when ? ` · ${when}` : ''}`}>
      Round {round}
    </span>
  );
}

/** The same words the summary bar uses, so the two never disagree. */
const STATE_LABEL: Record<ThreadState, string> = {
  draft: 'Not sent',
  awaiting: 'Awaiting reply',
  unread: 'Unread',
  read: '',
  settled: 'Resolved',
};

/**
 * One message in a thread: the author chip introduces what it wrote.
 *
 * A message the author has not sent yet can be rewritten or taken back in
 * place (spec §8, #89) — `onSave` present is what says so. Everything else
 * is a record of something that was said, and reads as one.
 */
function Message({
  author,
  collaborator,
  round,
  at,
  text,
  docs,
  editing,
  onEdit,
  onSave,
  onCancel,
  onDelete,
  deleteTitle,
}: {
  author: 'user' | 'agent';
  collaborator?: string;
  round: number;
  at?: string;
  text: string;
  docs?: boolean;
  /** Owned by the thread, so only one message in it is ever open. */
  editing?: boolean;
  onEdit?: () => void;
  onSave?: (text: string) => void;
  onCancel?: () => void;
  onDelete?: () => void;
  deleteTitle?: string;
}) {
  const [value, setValue] = useState(text);

  const save = () => {
    if (!value.trim()) return;
    onSave?.(value);
  };
  const start = () => {
    setValue(text); // whatever is stored now, not what was typed and abandoned
    onEdit?.();
  };

  return (
    <div className="thread-msg" onClick={editing ? (e) => e.stopPropagation() : undefined}>
      <div className="thread-msg-head">
        <AuthorChip author={author} collaborator={collaborator} />
        {docs && <span className="chip chip-source">Docs</span>}
        <RoundStamp round={round} at={at} />
        {onSave && !editing && (
          <span className="msg-tools">
            <button
              className="btn btn-ghost"
              title="Edit this — it hasn’t been sent yet"
              onClick={(e) => {
                e.stopPropagation();
                start();
              }}
            >
              Edit
            </button>
            {onDelete && (
              <button
                className="btn btn-ghost"
                title={deleteTitle ?? 'Delete this — it hasn’t been sent yet'}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
              >
                Delete
              </button>
            )}
          </span>
        )}
      </div>
      {/* `onSave` can disappear underneath an open editor — a round starts,
          or the round the message belongs to is submitted. It closes rather
          than offering a Save that would be refused. */}
      {editing && onSave ? (
        <div className="msg-edit">
          <MentionTextarea
            autoFocus
            value={value}
            onChange={setValue}
            onSubmit={save}
            onEscape={onCancel}
          />
          <div className="card-actions">
            <button className="btn btn-primary" disabled={!value.trim()} onClick={save}>
              Save
            </button>
            <button className="btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <Md text={text} />
      )}
    </div>
  );
}

/**
 * Tell the submit popover an edit box is open here (spec §8).
 *
 * Pass a key while editing, a falsy value otherwise. Unmounting counts as
 * closing — a card can be filtered out from under an open editor.
 */
function useRevisionOpen(key: string | null | false): void {
  const setRevisionOpen = useStore((s) => s.setRevisionOpen);
  useEffect(() => {
    if (!key) return;
    setRevisionOpen(key, true);
    return () => setRevisionOpen(key, false);
  }, [key, setRevisionOpen]);
}

/**
 * The edits that answer a thread (spec §7).
 *
 * Pending ones are work and get a row each; several collapse under one
 * expandable summary rather than becoming a stack of chips. Decided ones
 * are a record, not a call to action, so they shrink to one muted line —
 * kept rather than removed, because that line is the evidence the author
 * would resolve the thread on. Deciding them never resolves it.
 */
function LinkedEdits({ threadId }: { threadId: string }) {
  const suggestions = useStore((s) => s.review?.suggestions);
  const [expanded, setExpanded] = useState(false);
  const { pending, accepted, rejected } = useMemo(
    () => linkSummary(suggestions ?? [], threadId),
    [suggestions, threadId],
  );
  if (pending.length === 0 && accepted + rejected === 0) return null;

  // "1 accepted" on its own says nothing about what — it has to name
  // edits and keep the ↳ so it reads as the same family as the rows
  // above it, only settled.
  const edits = (n: number) => `${n} ${n === 1 ? 'edit' : 'edits'}`;
  const decided =
    accepted > 0 && rejected > 0
      ? `↳ ${accepted} accepted, ${rejected} rejected`
      : accepted > 0
        ? `↳ ${edits(accepted)} accepted`
        : rejected > 0
          ? `↳ ${edits(rejected)} rejected`
          : '';

  return (
    <div className="card-links">
      {pending.length === 1 && (
        <PointerRow id={pending[0].id} anchor={pending[0].anchor}>
          ↳ answered by an edit to “{brief(pending[0].anchor.quote)}”
        </PointerRow>
      )}
      {pending.length > 1 && !expanded && (
        <button
          className="pointer-row"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(true);
          }}
        >
          ↳ answered by {pending.length} edits
        </button>
      )}
      {pending.length > 1 &&
        expanded &&
        pending.map((s) => (
          <PointerRow key={s.id} id={s.id} anchor={s.anchor}>
            ↳ “{brief(s.anchor.quote)}”
          </PointerRow>
        ))}
      {decided && <p className="card-links-decided">{decided}</p>}
    </div>
  );
}

/** Shorten a quote for a pointer row — enough to say *where*, not what. */
const brief = (text: string, max = 30) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/**
 * A row pointing at the card's counterpart (spec §7, #100).
 *
 * Clicking jumps; hovering lights the counterpart card *and* its text in
 * the document, because it raises the same hover the pair already uses.
 * That is the "glance for free, jump when you want the detail" half of
 * the design — you see the relationship without leaving where you are.
 */
function PointerRow({
  id,
  anchor,
  children,
  muted,
}: {
  id: string;
  anchor: Anchor;
  children: React.ReactNode;
  muted?: boolean;
}) {
  const focusAnchor = useStore((s) => s.focusAnchor);
  const setHoveredAnchor = useStore((s) => s.setHoveredAnchor);
  return (
    <button
      className={`pointer-row${muted ? ' pointer-row-muted' : ''}`}
      onMouseEnter={() => setHoveredAnchor(id)}
      onMouseLeave={() => setHoveredAnchor(null)}
      onClick={(e) => {
        e.stopPropagation();
        focusAnchor(id);
        if (!anchor.orphaned) revealRange(anchor.from, anchor.to);
      }}
    >
      {children}
    </button>
  );
}

function usePair(
  id: string,
  anchor: { from: number; to: number; orphaned?: boolean },
  /** Counterpart card ids, so focusing one end lights the other (spec §7). */
  linkedIds: string[] = [],
) {
  const focusAnchor = useStore((s) => s.focusAnchor);
  const setHoveredAnchor = useStore((s) => s.setHoveredAnchor);
  const active = useStore((s) => s.activeAnchorId === id);
  const hot = useStore((s) => s.hoveredAnchorId === id);
  // Booleans, not the matching ids: a selector returning a fresh array
  // re-renders forever (React #185).
  const linkActive = useStore(
    (s) => s.activeAnchorId !== null && linkedIds.includes(s.activeAnchorId),
  );
  const linkHot = useStore(
    (s) => s.hoveredAnchorId !== null && linkedIds.includes(s.hoveredAnchorId),
  );
  return {
    classes: `${active ? ' pair-active' : ''}${hot ? ' pair-hot' : ''}${
      !active && (linkActive || linkHot) ? ' pair-linked' : ''
    }`,
    props: {
      onMouseEnter: () => setHoveredAnchor(id),
      onMouseLeave: () => setHoveredAnchor(null),
      // The third entry point. All of them — a card, marked text, a
      // round-header jump — raise the same request, so the pair lights up
      // at both ends whichever end was clicked.
      onClick: () => {
        focusAnchor(id);
        if (!anchor.orphaned) revealRange(anchor.from, anchor.to);
      },
    },
  };
}

function Composer() {
  const composerAnchor = useStore((s) => s.composerAnchor);
  const draft = useStore((s) => s.composerDraft);
  const setDraft = useStore((s) => s.setComposerDraft);
  const focusKey = useStore((s) => s.composerFocus);
  const addComment = useStore((s) => s.addComment);
  const addSuggestion = useStore((s) => s.addSuggestion);
  const closeComposer = useStore((s) => s.closeComposer);
  const cardRef = useRef<HTMLDivElement>(null);
  // A refused re-target is a "take me back to what you were writing", so it
  // behaves like every other jump: both ends of the pair centered, eased
  // into place, and pulsed. Anything quieter leaves the reader looking for
  // a draft that is off-screen at the other end of a long sidebar.
  useEffect(() => {
    if (!focusKey) return;
    const anchor = useStore.getState().composerAnchor;
    if (anchor && !anchor.orphaned) centerOnPos(anchor.from);
    requestAnimationFrame(() => {
      focusCard(cardRef.current);
      pulsePendingAnchor();
    });
  }, [focusKey]);
  if (!composerAnchor) return null;

  const { mode, text } = draft;
  const effectiveReplacement = draft.replacement ?? composerAnchor.quote;
  const submit = () => {
    if (mode === 'comment') addComment(text);
    else addSuggestion(effectiveReplacement, text);
  };
  const canSubmit =
    mode === 'comment' ? text.trim().length > 0 : effectiveReplacement !== composerAnchor.quote;

  return (
    <div className="card card-composer" ref={cardRef}>
      <div className="composer-modes">
        <button
          className={`btn btn-toggle${mode === 'comment' ? ' on' : ''}`}
          onClick={() => setDraft({ mode: 'comment' })}
        >
          Comment
        </button>
        <button
          className={`btn btn-toggle${mode === 'suggest' ? ' on' : ''}`}
          onClick={() => setDraft({ mode: 'suggest' })}
        >
          Suggest
        </button>
      </div>
      {/* The text can be edited out from under an open composer. Saying so
          beats committing a comment about words that are no longer there. */}
      {mode === 'comment' || composerAnchor.orphaned ? (
        <Quote text={composerAnchor.quote} orphaned={composerAnchor.orphaned} />
      ) : null}
      {mode === 'suggest' && !composerAnchor.orphaned && (
        <textarea
          className="composer-replacement"
          value={effectiveReplacement}
          onChange={(e) => setDraft({ replacement: e.target.value })}
        />
      )}
      <MentionTextarea
        autoFocus
        focusKey={focusKey}
        value={text}
        placeholder={mode === 'comment' ? 'Comment for Claude…' : 'Why? (optional)'}
        onChange={(text) => setDraft({ text })}
        onSubmit={() => canSubmit && submit()}
        onEscape={closeComposer}
      />
      <div className="card-actions">
        <button className="btn btn-primary" disabled={!canSubmit} onClick={submit}>
          {mode === 'comment' ? 'Comment' : 'Suggest'}
        </button>
        <button className="btn" onClick={closeComposer}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function SuggestionCard({ suggestion }: { suggestion: Suggestion }) {
  const locked = useLocked();
  const content = useStore((s) => s.content);
  const accept = useStore((s) => s.acceptSuggestion);
  const reject = useStore((s) => s.rejectSuggestion);
  const editSuggestion = useStore((s) => s.editSuggestion);
  const deleteSuggestion = useStore((s) => s.deleteSuggestion);
  const comments = useStore((s) => s.review?.comments);
  const answers = suggestion.inReplyTo
    ? comments?.find((c) => c.id === suggestion.inReplyTo)
    : undefined;
  const pair = usePair(
    suggestion.id,
    suggestion.anchor,
    suggestion.inReplyTo ? [suggestion.inReplyTo] : [],
  );
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [editing, setEditing] = useState<{ replacement: string; note: string } | null>(null);
  useRevisionOpen(editing !== null && suggestion.id);

  const currentRound = useStore((s) => s.review?.round ?? 0);
  const state = suggestionState(suggestion, currentRound);
  const editable = !locked && suggestionEditable(suggestion, currentRound);
  const deletion = suggestion.replacement === '';

  const saveEdit = () => {
    if (!editing) return;
    editSuggestion(suggestion.id, { replacement: editing.replacement, note: editing.note });
    setEditing(null);
  };

  // Only what changes, rather than the whole clause struck and re-inserted
  // (#98). Both strings are already stored — this is presentation.
  const parts = wordDiff(suggestion.anchor.quote, suggestion.replacement);

  return (
    <div
      id={`card-${suggestion.id}`}
      className={`card card-suggestion state-${state}${pair.classes}`}
      aria-label="suggestion"
      {...pair.props}
    >
      <div className="card-head">
        {/* The operation is named here and shown in the diff; the leading
            edge is state, and only state (spec §6). */}
        <span className="state-label">
          <span className={deletion ? 'op-del' : 'op-edit'}>{deletion ? 'Deletion' : 'Edit'}</span>
          {state === 'draft' && ' · not sent'}
        </span>
        {suggestion.anchor.orphaned && <span className="badge">Text gone</span>}
        <span className="card-locator">{locatorFor(content, suggestion.anchor.from)}</span>
        <RoundStamp round={suggestion.round} at={suggestion.createdAt} />
      </div>
      {/* Beside the author chip, where a thread's draft controls are —
          managing the item, as against deciding on it below (spec §8). */}
      <div className="thread-msg-head">
        <AuthorChip author={suggestion.author} />
        {editable && !editing && (
          <span className="msg-tools">
            <button
              className="btn btn-ghost"
              title="Edit this edit — it hasn’t been sent yet"
              onClick={(e) => {
                e.stopPropagation();
                setEditing({ replacement: suggestion.replacement, note: suggestion.note ?? '' });
              }}
            >
              Edit
            </button>
            <button
              className="btn btn-ghost"
              title="Delete this edit — it hasn’t been sent yet"
              onClick={(e) => {
                e.stopPropagation();
                deleteSuggestion(suggestion.id);
              }}
            >
              Delete
            </button>
          </span>
        )}
      </div>
      {editing ? (
        <div className="msg-edit" onClick={(e) => e.stopPropagation()}>
          <Quote text={suggestion.anchor.quote} orphaned={suggestion.anchor.orphaned} />
          <textarea
            className="composer-replacement"
            autoFocus
            value={editing.replacement}
            placeholder="Replacement text (empty deletes the quoted text)"
            onChange={(e) => setEditing({ ...editing, replacement: e.target.value })}
          />
          <MentionTextarea
            value={editing.note}
            placeholder="Why? (optional)"
            onChange={(note) => setEditing({ ...editing, note })}
            onSubmit={saveEdit}
            onEscape={() => setEditing(null)}
          />
          <div className="card-actions">
            <button className="btn btn-primary" onClick={saveEdit}>
              Save
            </button>
            <button className="btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="card-diff">
          {parts.map((p, i) => (
            <span
              key={i}
              className={p.kind === 'del' ? 'diff-del' : p.kind === 'ins' ? 'diff-ins' : undefined}
            >
              {p.text}
            </span>
          ))}
        </p>
      )}
      {suggestion.note && !editing && <Md text={suggestion.note} />}
      {/* What this edit is an answer to. A link the agent set, rather than
          the sentence "see my thread reply" it used to write instead. */}
      {answers && !editing && (
        <PointerRow id={answers.id} anchor={answers.anchor}>
          ↳ answers “{brief(answers.text, 42)}”
        </PointerRow>
      )}
      {suggestion.anchor.orphaned && (
        <p className="orphan-note">anchor text no longer found — accept is disabled</p>
      )}
      {editing ? null : !rejecting ? (
        <div className="card-actions">
          <button
            className="btn btn-primary"
            disabled={locked || suggestion.anchor.orphaned}
            onClick={(e) => {
              e.stopPropagation();
              accept(suggestion.id);
            }}
          >
            Accept
          </button>
          <button
            className="btn btn-reject"
            disabled={locked}
            onClick={(e) => {
              e.stopPropagation();
              setRejecting(true);
            }}
          >
            Reject
          </button>
        </div>
      ) : (
        <div className="card-reject" onClick={(e) => e.stopPropagation()}>
          <MentionTextarea
            autoFocus
            value={rejectNote}
            placeholder="Why? (optional — Claude reads this next round)"
            onChange={setRejectNote}
            onSubmit={() => reject(suggestion.id, rejectNote)}
            onEscape={() => setRejecting(false)}
          />
          <div className="card-actions">
            <button className="btn btn-danger" onClick={() => reject(suggestion.id, rejectNote)}>
              Reject
            </button>
            <button className="btn" onClick={() => setRejecting(false)}>
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ThreadCard({ thread }: { thread: CommentThread }) {
  const locked = useLocked();
  const replyTo = useStore((s) => s.replyToThread);
  const editComment = useStore((s) => s.editComment);
  const deleteComment = useStore((s) => s.deleteComment);
  const editReply = useStore((s) => s.editReply);
  const deleteReply = useStore((s) => s.deleteReply);
  const setThreadStatus = useStore((s) => s.setThreadStatus);
  const suggestions = useStore((s) => s.review?.suggestions);
  const linkedIds = useMemo(
    () => linkedSuggestions(suggestions ?? [], thread.id).map((s) => s.id),
    [suggestions, thread.id],
  );
  const pair = usePair(thread.id, thread.anchor, linkedIds);
  const [reply, setReply] = useState('');
  // 'body', or a reply id. One at a time, and the reply box steps aside
  // while it is open — two composers in one card is a guess about which
  // one Save belongs to.
  const [editingId, setEditingId] = useState<string | null>(null);
  useRevisionOpen(editingId && `${thread.id}:${editingId}`);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [sendingToDoc, setSendingToDoc] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const imported = thread.provenance === 'imported';
  const addDocReply = useStore((s) => s.addDocReply);
  const currentRound = useStore((s) => s.review?.round ?? 0);
  const state = threadState(thread, currentRound);
  const bodyEditable = threadEditable(thread, currentRound);
  const last = latestActivity(thread);
  const [expanded, setExpanded] = useState(false);
  // Past four messages, keep the opening and the last two; fold the rest.
  // Folding by age instead would hide the question in a two-message thread
  // — the very thing the reply is answering.
  const hidden = expanded || thread.replies.length + 1 <= 4 ? 0 : thread.replies.length - 2;
  const shownReplies = hidden > 0 ? thread.replies.slice(hidden) : thread.replies;

  const sendReply = () => {
    replyTo(thread.id, reply);
    setReply('');
  };

  const sendReplyOnDoc = async () => {
    if (!thread.driveCommentId) return;
    setSendingToDoc(true);
    setDocError(null);
    const result = await window.margin.gdocsReplyOnDoc(thread.driveCommentId, reply);
    setSendingToDoc(false);
    if (result.error) {
      setDocError(result.error);
      return;
    }
    addDocReply(thread.id, reply, result.driveReplyId!);
    setReply('');
  };

  return (
    <div
      id={`card-${thread.id}`}
      className={`card card-comment state-${state}${pair.classes}`}
      aria-label="comment thread"
      // focusAnchor already clears unread — clicking a thread is a
      // deliberate "I'm looking at this" (spec §4).
      {...pair.props}
    >
      <div className="card-head card-head-split">
        {/* The facts wrap among themselves; Resolve keeps the corner. A
            long state label next to a badge used to push it onto a line of
            its own, so a card said more about its own width than its
            state. */}
        <span className="card-facts">
          {/* Always mounted so clearing unread fades rather than snaps. */}
          <span className={`unread-dot${state === 'unread' ? '' : ' is-gone'}`} aria-hidden="true" />
          {STATE_LABEL[state] && <span className="state-label">{STATE_LABEL[state]}</span>}
          {thread.anchor.orphaned && <span className="badge">Text gone</span>}
          {imported && <span className="chip chip-source" title="Imported from the linked Google Doc">Docs</span>}
          <RoundStamp round={last.round} at={thread.createdAt} />
        </span>
        {imported ? (
          <span className="resolve-wrap">
            <button
              className="btn btn-ghost"
              disabled={locked}
              title="Resolve thread"
              onClick={(e) => {
                e.stopPropagation();
                setResolveOpen(!resolveOpen);
              }}
            >
              ✓ Resolve
            </button>
            {resolveOpen && (
              <span className="popover resolve-popover" onClick={(e) => e.stopPropagation()}>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setResolveOpen(false);
                    setThreadStatus(thread.id, 'resolved');
                  }}
                >
                  Resolve in Margin only
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setResolveOpen(false);
                    setThreadStatus(thread.id, 'resolved');
                    void window.margin
                      .gdocsResolveOnDoc(thread.driveCommentId!)
                      .then((r) => r.error && setDocError(r.error));
                  }}
                >
                  Resolve here and on the Doc
                </button>
              </span>
            )}
          </span>
        ) : (
          <button
            className="btn btn-ghost"
            disabled={locked}
            title="Resolve thread"
            onClick={(e) => {
              e.stopPropagation();
              setThreadStatus(thread.id, 'resolved');
            }}
          >
            ✓ Resolve
          </button>
        )}
      </div>
      <Quote text={thread.anchor.quote} orphaned={thread.anchor.orphaned} />
      {/* Oldest first, the order the conversation happened in (spec §3). */}
      <Message
        author={thread.author}
        collaborator={thread.collaborator}
        round={thread.round}
        at={thread.createdAt}
        text={thread.text}
        editing={editingId === 'body'}
        onEdit={() => setEditingId('body')}
        onCancel={() => setEditingId(null)}
        onSave={
          bodyEditable && !locked
            ? (t) => {
                editComment(thread.id, t);
                setEditingId(null);
              }
            : undefined
        }
        onDelete={bodyEditable && !locked ? () => deleteComment(thread.id) : undefined}
        deleteTitle={
          thread.replies.length > 0
            ? 'Delete this comment and its replies — none of it has been sent'
            : 'Delete this comment — it hasn’t been sent yet'
        }
      />
      {/* The middle folds, never the ends: the first message is the
          question and the last is where things stand (spec §3). */}
      {hidden > 0 && !expanded && (
        <button
          className="thread-fold"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(true);
          }}
        >
          <span className="thread-fold-line" />
          {hidden} earlier {hidden === 1 ? 'reply' : 'replies'}
          <span className="thread-fold-line" />
        </button>
      )}
      {shownReplies.map((r) => {
        const editable = !locked && replyEditable(r, currentRound);
        return (
          <Message
            key={r.id}
            author={r.author}
            collaborator={r.collaborator}
            round={r.round}
            at={r.createdAt}
            text={r.text}
            docs={!!r.driveReplyId && !r.collaborator}
            editing={editingId === r.id}
            onEdit={() => setEditingId(r.id)}
            onCancel={() => setEditingId(null)}
            onSave={
              editable
                ? (t) => {
                    editReply(thread.id, r.id, t);
                    setEditingId(null);
                  }
                : undefined
            }
            onDelete={editable ? () => deleteReply(thread.id, r.id) : undefined}
            deleteTitle="Delete this reply — it hasn’t been sent yet"
          />
        );
      })}
      <LinkedEdits threadId={thread.id} />
      <div
        className="card-replybox"
        hidden={editingId !== null}
        onClick={(e) => e.stopPropagation()}
      >
        <MentionTextarea
          value={reply}
          placeholder="Reply…"
          onChange={setReply}
          onSubmit={sendReply}
        />
        {reply.trim() && (
          <button className="btn btn-primary" disabled={locked} onClick={sendReply}>
            Reply
          </button>
        )}
        {imported && reply.trim() && (
          <button
            className="btn"
            disabled={locked || sendingToDoc}
            title="Send this exact text as a reply on the Google Doc thread, under your account"
            onClick={() => void sendReplyOnDoc()}
          >
            {sendingToDoc ? 'Sending…' : 'Reply on Doc'}
          </button>
        )}
      </div>
      {imported && (
        <p className="gdocs-shadow-note">
          Replies stay in Margin unless sent with “Reply on Doc”.
        </p>
      )}
      {docError && <p className="gdocs-doc-error">{docError}</p>}
    </div>
  );
}

/**
 * Take the reader to a card: center it, mark the passage in the document,
 * and pulse the card so it is obvious which one arrived.
 *
 * Imperative on purpose. Driving this from an effect keyed on the active
 * id means clicking the same jump twice does nothing, because the state
 * never changes — and the pulse cannot be a class either, since the state
 * change that comes with focusing rewrites the card's className and would
 * strip it. A Web Animations call survives both.
 */
/** A brief ring, in the accent, that survives a re-render (see focusCard). */
function pulse(el: Element): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--user').trim();
  el.animate(
    [
      { boxShadow: `0 0 0 0px ${accent}00`, easing: 'ease-out' },
      { boxShadow: `0 0 0 5px ${accent}59`, offset: 0.3, easing: 'ease-in-out' },
      { boxShadow: `0 0 0 5px ${accent}00` },
    ],
    { duration: 1500 },
  );
}

/** The marked text in the document, so both ends of a focus behave alike. */
function pulseAnchorText(id: string): void {
  for (const el of document.querySelectorAll(
    `.cm-editor .anchor[data-anchor-id="${CSS.escape(id)}"]`,
  )) {
    pulse(el);
  }
}

/** The open composer's subject, which carries no id of its own yet. */
function pulsePendingAnchor(): void {
  for (const el of document.querySelectorAll('.cm-editor .anchor-pending')) pulse(el);
}

function focusCard(el: HTMLElement | null): void {
  if (!el) return;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
  if (still) return;
  const run = () => pulse(el);
  // Wait for the smooth scroll to land. Firing both at once means the pulse
  // peaks while the card is still traveling — usually off-screen — and is
  // over before it arrives.
  const scroller = el.closest('.review-scroll');
  if (!scroller) return run();
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    scroller.removeEventListener('scrollend', once);
    run();
  };
  scroller.addEventListener('scrollend', once, { once: true });
  window.setTimeout(once, 700); // in case the card was already in place
}

/**
 * What the last completed round produced, with a way into each piece
 * (spec §5, #103).
 *
 * A turn writes to two surfaces: prose lands in the project discussion
 * dock, per-thread replies and suggestions land here. Claude ends up
 * writing "see my thread reply" and the reply is somewhere else — so the
 * prose stays where it is, and this gives the sidebar its own record that
 * a turn happened, with jump links.
 *
 * It clears itself once every item in it has been dealt with, so it never
 * has to be dismissed to get out of the way.
 */
const MAX_JUMPS = 3;

function RoundHeader({
  filtered,
  onToggleFilter,
}: {
  filtered: boolean;
  onToggleFilter: () => void;
}) {
  const review = useStore((s) => s.review);
  const focusAnchor = useStore((s) => s.focusAnchor);
  const [dismissed, setDismissed] = useState<number | null>(null);

  const round = review?.round ?? 0;
  const answered = (review?.comments ?? []).filter(
    (c) => c.status === 'open' && latestExternalRound(c) === round,
  );
  const proposed = (review?.suggestions ?? []).filter(
    (s) => s.round === round && s.author === 'agent',
  );
  const outstanding =
    answered.some((c) => isUnread(c)) || proposed.some((s) => s.status === 'pending');

  if (round === 0 || dismissed === round || !outstanding) return null;

  // One list, document order — the same rule the sidebar itself follows.
  const items: Array<CommentThread | Suggestion> = [...answered, ...proposed.filter((s) => s.status === 'pending')]
    .sort((a, b) => a.anchor.from - b.anchor.from);
  const shown = items.slice(0, MAX_JUMPS);
  const rest = items.length - shown.length;

  const go = (id: string, anchor: Anchor) => {
    focusAnchor(id);
    // Mark the passage in the document too — a jump that only moves the
    // sidebar leaves the reader to find the text themselves.
    if (!anchor.orphaned) revealRange(anchor.from, anchor.to);
  };
  const parts = [
    answered.length > 0 && `replied to ${answered.length} ${answered.length === 1 ? 'thread' : 'threads'}`,
    proposed.length > 0 && `proposed ${proposed.length} ${proposed.length === 1 ? 'edit' : 'edits'}`,
  ].filter(Boolean);

  return (
    <div className="round-header">
      <div className="round-header-top">
        <strong>Round {round}</strong>
        <button
          className="round-dismiss"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={() => setDismissed(round)}
        >
          ✕
        </button>
      </div>
      <p>Claude {parts.join(' and ')}.</p>
      <div className="round-jumps">
        {shown.map((it) => (
          <button
            key={it.id}
            className="round-jump"
            onClick={() => go(it.id, it.anchor)}
          >
            ↳ “{it.anchor.quote.length > 26 ? `${it.anchor.quote.slice(0, 25)}…` : it.anchor.quote}”
          </button>
        ))}
        {/* No attempt to rank: a turn can answer a dozen threads and nothing
            in the data says which matters most. Document order, capped, and
            the rest handed to the filter that already exists for this. */}
        {rest > 0 && (
          // Shares state with the All / Need you pair rather than silently
          // setting it: a control that changes something elsewhere and then
          // looks unchanged leaves no way back that the reader can see.
          <button
            className={`round-jump round-jump-more${filtered ? ' on' : ''}`}
            aria-pressed={filtered}
            onClick={onToggleFilter}
          >
            +{rest} more — review all
          </button>
        )}
      </div>
    </div>
  );
}

export function Sidebar() {
  const review = useStore((s) => s.review);
  const setThreadStatus = useStore((s) => s.setThreadStatus);
  const undoDecision = useStore((s) => s.undoDecision);
  const locked = useLocked();
  const [showArchive, setShowArchive] = useState(false);
  const archiveRef = useRef<HTMLElement>(null);
  // Opening the fold at the floor of the pane would otherwise reveal the
  // items below the fold — bring its heading up to the top instead, as far
  // as the scroll allows. Instant, not animated: this is a disclosure, and
  // a glide here reads as more ceremony than the action deserves.
  useEffect(() => {
    if (showArchive) archiveRef.current?.scrollIntoView({ block: 'start' });
  }, [showArchive]);
  const activeAnchorId = useStore((s) => s.activeAnchorId);
  const focusRequest = useStore((s) => s.focusRequest);

  // Every "take me there" — a card, a round-header jump, or marked text in
  // the document — lands here, so all three behave the same.
  useEffect(() => {
    if (!focusRequest) return;
    const id = focusRequest.id;
    requestAnimationFrame(() => {
      focusCard(document.getElementById(`card-${id}`));
      // Both ends of the pair light up, whichever end was clicked.
      pulseAnchorText(id);
    });
  }, [focusRequest]);

  const currentRound = review?.round ?? 0;
  const [onlyNeedsYou, setOnlyNeedsYou] = useState(false);

  const { pendingSuggestions, openThreads, archived, counts } = useMemo(() => {
    const comments = review?.comments ?? [];
    const suggestions = review?.suggestions ?? [];
    const open = comments.filter((c) => c.status === 'open');
    const pending = suggestions.filter((s) => s.status === 'pending');
    const c = countThreads(comments, currentRound);
    return {
      // Document order, always. The filter narrows the list; it never
      // reorders it, so a card stays where the document put it (spec §4).
      pendingSuggestions: [...pending].sort((a, b) => a.anchor.from - b.anchor.from),
      openThreads: [...open].sort((a, b) => a.anchor.from - b.anchor.from),
      archived: {
        threads: comments.filter((x) => x.status === 'resolved'),
        suggestions: suggestions.filter((x) => x.status !== 'pending'),
      },
      counts: {
        ...c,
        // Everything outstanding, threads and undecided suggestions alike —
        // both are someone waiting on the author.
        needsYou:
          open.filter((t) => threadNeedsYou(t, currentRound)).length +
          pending.filter((s) => suggestionNeedsYou(s, currentRound)).length,
        draft:
          c.draft + pending.filter((s) => suggestionState(s, currentRound) === 'draft').length,
      },
    };
  }, [review, currentRound]);

  const archivedCount = archived.threads.length + archived.suggestions.length;
  // The card being read stays put even once it stops qualifying, so the list
  // never moves out from under a click.
  const keep = (id: string, qualifies: boolean) => qualifies || id === activeAnchorId;
  // Threads and suggestions are one list in document order. Two sections
  // meant a comment on the first paragraph sat below a suggestion on the
  // ninth, which is not what a margin does (spec §4).
  const shown: Array<CommentThread | Suggestion> = [
    ...(onlyNeedsYou
      ? openThreads.filter((t) => keep(t.id, threadNeedsYou(t, currentRound)))
      : openThreads),
    ...(onlyNeedsYou
      ? pendingSuggestions.filter((s) => keep(s.id, suggestionNeedsYou(s, currentRound)))
      : pendingSuggestions),
  ].sort((a, b) => a.anchor.from - b.anchor.from);

  return (
    <aside className="sidebar">
      {/* Facts on top, the filter beneath them (spec §4). */}
      {(openThreads.length > 0 || pendingSuggestions.length > 0 || archivedCount > 0) && (
        <div className="review-summary">
          <div className="review-counts">
            {counts.needsYou > 0 && <span><b>{counts.needsYou}</b> need you</span>}
            {counts.draft > 0 && <span><b>{counts.draft}</b> not sent</span>}
            {counts.awaiting > 0 && <span><b>{counts.awaiting}</b> awaiting reply</span>}
            {archivedCount > 0 && <span><b>{archivedCount}</b> resolved</span>}
          </div>
          {counts.needsYou > 0 && (
            <div className="review-filters">
              <button
                className={`btn btn-toggle${onlyNeedsYou ? '' : ' on'}`}
                onClick={() => setOnlyNeedsYou(false)}
              >
                All
              </button>
              <button
                className={`btn btn-toggle${onlyNeedsYou ? ' on' : ''}`}
                onClick={() => setOnlyNeedsYou(true)}
              >
                Need you
              </button>
            </div>
          )}
        </div>
      )}
      <div className="review-scroll">
        <RoundHeader filtered={onlyNeedsYou} onToggleFilter={() => setOnlyNeedsYou(!onlyNeedsYou)} />
        <Composer />
        {pendingSuggestions.length === 0 && openThreads.length === 0 && (
          <div className="sidebar-empty">
            <div className="empty-glyph">¶</div>
            <p>Nothing to review yet.</p>
            <p className="hint">
              Claude's suggestions and your threads appear here after you submit a round.
            </p>
          </div>
        )}
        {shown.length > 0 && (
          <section>
            {shown.map((it) =>
              'replies' in it ? (
                <ThreadCard key={it.id} thread={it} />
              ) : (
                <SuggestionCard key={it.id} suggestion={it} />
              ),
            )}
          </section>
        )}
        {onlyNeedsYou && shown.length === 0 && (
          <p className="hint sidebar-filtered-empty">
            Nothing waiting on you.{' '}
            <button className="linkish" onClick={() => setOnlyNeedsYou(false)}>Show everything</button>
          </p>
        )}
        {archivedCount > 0 && (
          <section className="review-archive" ref={archiveRef}>
            <button
              className="btn btn-ghost sidebar-archive-toggle"
              onClick={() => setShowArchive(!showArchive)}
            >
              {showArchive ? '▾' : '▸'} Resolved & decided · {archivedCount}
            </button>
            {showArchive && (
              <div className="archive">
                {archived.suggestions.map((s) => (
                  <div key={s.id} className={`card card-archived status-${s.status}`}>
                    <div className="card-head">
                      <AuthorChip author={s.author} />
                      <span className="card-locator">{s.status}</span>
                      {/* A decision is undone as a decision — Cmd-Z would only
                          revert the text half and leave the review claiming it
                          landed (#128). */}
                      <button
                        className="btn btn-ghost undo-decision"
                        disabled={locked}
                        title="Put this back to pending"
                        onClick={() => undoDecision(s.id)}
                      >
                        Undo
                      </button>
                    </div>
                    <Quote text={s.anchor.quote} />
                    {s.decisionComment && <Md text={`“${s.decisionComment}”`} />}
                  </div>
                ))}
                {archived.threads.map((c) => (
                  <div key={c.id} className="card card-archived">
                    <div className="card-head">
                      <AuthorChip author={c.author} />
                      <button className="btn btn-ghost" onClick={() => setThreadStatus(c.id, 'open')}>
                        Reopen
                      </button>
                    </div>
                    <Md text={c.text} />
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
      <DiscussionDock />
    </aside>
  );
}
