import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type { ChangeDesc } from '@codemirror/state';
import type {
  AgentStatus,
  Anchor,
  DiscussionMessage,
  DocState,
  GdocsSyncState,
  ModelPreference,
  ReviewData,
  WorkspaceState,
} from '@shared/types';
import { makeAnchor, resolveQuote } from '@shared/anchors';
import {
  markSeen,
  replyEditable,
  suggestionEditable,
  threadEditable,
} from '@shared/reviewState';
import { draftHasContent, emptyDraft, type ComposerDraft } from '@shared/composer';
import { applyReplacement, formatTableAtCaret } from './editorBridge';

export type ViewMode = 'write' | 'preview';

interface MarginState {
  doc: DocState | null;
  content: string;
  review: ReviewData | null;
  discussion: DiscussionMessage[];
  mode: ViewMode;
  agent: AgentStatus;
  activity: string[];
  selection: { from: number; to: number } | null;
  activeAnchorId: string | null;
  composerAnchor: { from: number; to: number; quote: string; orphaned?: boolean } | null;
  /**
   * What is typed in the composer. Lifted out of the component because two
   * other places have to see it: the re-target rule, which refuses to move
   * a composer holding work, and the submit popover, which says an
   * unfinished comment isn't traveling with the round (spec §8).
   */
  composerDraft: ComposerDraft;
  setComposerDraft: (patch: Partial<ComposerDraft>) => void;
  /**
   * Bumped when a re-target is refused, to pull focus to the composer.
   * A counter rather than a flag: the second refused click has to move
   * focus too, and setting the same value twice is not a state change.
   */
  composerFocus: number;
  /**
   * Edit boxes currently open on already-staged items, by key.
   *
   * Only the submit popover reads this. A revision is uncommitted work
   * like a composer draft, but unlike the composer it cannot survive the
   * round — the item it modifies becomes history, the box closes, and the
   * typing goes with it. So the popover has to name it *before* that
   * happens, which means someone has to know it exists (spec §8).
   */
  openRevisions: string[];
  setRevisionOpen: (key: string, open: boolean) => void;
  dirty: boolean;
  workspace: WorkspaceState | null;
  explorerOpen: boolean;

  init: () => void;
  loadWorkspace: () => Promise<void>;
  toggleExplorer: () => void;
  switchToFile: (path: string) => Promise<void>;
  setMode: (mode: ViewMode) => void;
  handleDocChange: (content: string, changes: ChangeDesc) => void;
  setSelection: (sel: { from: number; to: number } | null) => void;
  /** Text selected in rendered preview (mapped to source by quote). */
  previewQuote: string | null;
  setPreviewQuote: (quote: string | null) => void;
  setActiveAnchor: (id: string | null) => void;
  openComposer: () => void;
  closeComposer: () => void;
  addComment: (text: string) => void;
  addSuggestion: (replacement: string, note?: string) => void;
  replyToThread: (threadId: string, text: string) => void;
  /**
   * Draft editing (spec §8, #89). Each of these is guarded by the matching
   * predicate in `@shared/reviewState` — the store is the last place that
   * can enforce it, since a card could go stale between render and click.
   */
  editComment: (threadId: string, text: string) => void;
  deleteComment: (threadId: string) => void;
  editReply: (threadId: string, replyId: string, text: string) => void;
  deleteReply: (threadId: string, replyId: string) => void;
  editSuggestion: (id: string, patch: { replacement?: string; note?: string }) => void;
  deleteSuggestion: (id: string) => void;
  editDiscussionMessage: (id: string, text: string) => void;
  /** Record a reply that was just sent to the linked Google Doc thread. */
  addDocReply: (threadId: string, text: string, driveReplyId: string) => void;
  setThreadStatus: (threadId: string, status: 'open' | 'resolved') => void;
  acceptSuggestion: (id: string) => void;
  rejectSuggestion: (id: string, comment?: string) => void;
  /** Put an accepted or rejected suggestion back to pending (#128). */
  undoDecision: (id: string) => void;
  /** Clear a thread's unread mark — the author has looked at it (spec §4). */
  markThreadSeen: (id: string) => void;
  /**
   * "Take me to this." Focuses the anchor, clears its unread mark, and asks
   * the sidebar to center and pulse the card. The counter makes a repeat
   * request observable — asking for the anchor you are already on has to
   * work, and setting the same id twice is not a state change (#103).
   */
  focusRequest: { id: string; n: number } | null;
  focusAnchor: (id: string) => void;
  save: () => Promise<void>;
  /** Model + effort for this project's rounds (cascade: project → app default). */
  modelPref: ModelPreference;
  setModelPref: (pref: ModelPreference) => void;
  /** Ask main for the effective preference, migrating the legacy key once. */
  resolveModelPref: (workspaceRoot: string) => Promise<void>;
  hoveredAnchorId: string | null;
  setHoveredAnchor: (id: string | null) => void;
  /** Discussion dock expanded/collapsed (persisted per workspace). */
  dockOpen: boolean;
  toggleDock: () => void;
  /** The file changed on disk while we have unsaved edits. */
  diskConflict: boolean;
  resolveConflict: (choice: 'reload' | 'keep') => Promise<void>;
  addDiscussionMessage: (text: string) => void;
  removeDiscussionMessage: (id: string) => void;
  /** Agent file proposal being viewed in the main pane (null = document). */
  viewingProposalId: string | null;
  openProposal: (id: string) => void;
  closeProposal: () => void;
  acceptProposal: (id: string) => Promise<void>;
  rejectProposal: (id: string, comment?: string) => Promise<void>;
  submit: () => Promise<void>;
  cancelReview: () => Promise<void>;
  /** Settings overlay (menu Settings… / Cmd-,). */
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  /** Google Docs link/push state for the open document. */
  gdocsSync: GdocsSyncState | null;
  refreshGdocsSync: () => Promise<void>;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;

/** Refresh quote/context on all anchors from current offsets before persisting. */
function refreshAnchors(review: ReviewData, content: string): ReviewData {
  const refresh = (a: Anchor): Anchor => {
    if (a.orphaned) return a;
    if (a.from < 0 || a.to > content.length || a.from >= a.to) return { ...a, orphaned: true };
    return makeAnchor(content, a.from, a.to);
  };
  return {
    ...review,
    comments: review.comments.map((c) => ({ ...c, anchor: refresh(c.anchor) })),
    suggestions: review.suggestions.map((s) =>
      s.status === 'pending' ? { ...s, anchor: refresh(s.anchor) } : s,
    ),
  };
}

/**
 * The anchor a committed draft carries. A composer whose text was deleted
 * while it was open commits as orphaned — the card says "text gone", which
 * is true, instead of silently claiming the words that moved into its
 * place.
 */
function anchorForDraft(
  content: string,
  composerAnchor: { from: number; to: number; quote: string; orphaned?: boolean },
): Anchor {
  return composerAnchor.orphaned
    ? { from: composerAnchor.from, to: composerAnchor.from, quote: composerAnchor.quote, orphaned: true }
    : makeAnchor(content, composerAnchor.from, composerAnchor.to);
}

export const useStore = create<MarginState>((set, get) => {
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void get().save(), 800);
  };

  const updateReview = (fn: (review: ReviewData) => ReviewData) => {
    const review = get().review;
    if (!review) return;
    set({ review: fn(review) });
    scheduleSave();
  };

  return {
    doc: null,
    content: '',
    review: null,
    discussion: [],
    mode: 'write',
    agent: { phase: 'idle', detail: '' },
    activity: [],
    selection: null,
    activeAnchorId: null,
    composerAnchor: null,
    dirty: false,
    workspace: null,
    explorerOpen: true,
    settingsOpen: false,
    gdocsSync: null,

    loadWorkspace: async () => {
      const workspace = await window.margin.getWorkspace();
      set({ workspace });
    },

    viewingProposalId: null,
    openProposal: (id) => set({ viewingProposalId: id }),
    closeProposal: () => set({ viewingProposalId: null }),

    acceptProposal: async (id) => {
      const absPath = await window.margin.acceptProposal(id);
      set({ viewingProposalId: null });
      await get().loadWorkspace();
      if (/\.(md|markdown|mdx)$/i.test(absPath)) await get().switchToFile(absPath);
    },

    rejectProposal: async (id, comment) => {
      await window.margin.rejectProposal(id, comment);
      set({ viewingProposalId: null });
      await get().loadWorkspace();
    },

    toggleExplorer: () => set((s) => ({ explorerOpen: !s.explorerOpen })),
    setSettingsOpen: (open) => set({ settingsOpen: open }),
    refreshGdocsSync: async () => set({ gdocsSync: await window.margin.gdocsSyncState() }),

    switchToFile: async (path) => {
      const { doc, save } = get();
      set({ viewingProposalId: null });
      if (!doc || doc.filePath === path) return;
      await save(); // flush before the window switches documents
      await window.margin.openInWindow(path);
    },

    init: () => {
      if (initialized) return;
      initialized = true;

      const load = (doc: DocState) =>
        set({
          dockOpen: localStorage.getItem(`margin-dock-open:${doc.workspaceRoot}`) === 'true',
          modelPref: {},
          doc,
          content: doc.content,
          review: doc.review,
          discussion: doc.discussion,
          agent: { phase: 'idle', detail: '' },
          activity: [],
          selection: null,
          activeAnchorId: null,
          composerAnchor: null,
          dirty: false,
          diskConflict: false,
          viewingProposalId: null,
        });

      void window.margin.getDoc().then((doc) => {
        if (doc) {
          load(doc);
          void get().loadWorkspace();
          void get().refreshGdocsSync();
          void get().resolveModelPref(doc.workspaceRoot);
        }
      });
      window.margin.onDocLoaded((doc) => {
        load(doc);
        void get().loadWorkspace();
        void get().refreshGdocsSync();
        void get().resolveModelPref(doc.workspaceRoot);
      });
      window.margin.onReviewUpdated((review) => set({ review }));
      window.margin.onDiscussionUpdated((discussion) => set({ discussion }));
      window.margin.onDocChangedOnDisk(() => {
        // Clean editor: adopt the external change silently (anchors
        // re-resolve on load). Dirty editor: the user decides.
        if (!get().dirty) void window.margin.reloadDoc();
        else set({ diskConflict: true });
      });
      window.margin.onAgentStatus((agent) => {
        set({ agent });
        if (agent.phase === 'done' || agent.phase === 'error') {
          set((s) => ({ activity: [...s.activity, agent.detail] }));
          void get().loadWorkspace();
        }
      });
      window.margin.onAgentActivity((detail) =>
        set((s) => ({ activity: [...s.activity.slice(-199), detail] })),
      );
      window.margin.onMenuSave(() => void get().save());
      window.margin.onMenuAddComment(() => get().openComposer());
      window.margin.onMenuFormatTable(() => {
        if (get().agent.phase !== 'running') formatTableAtCaret();
      });
      window.margin.onMenuTogglePreview(() =>
        set((s) => ({ mode: s.mode === 'write' ? 'preview' : 'write' })),
      );
      window.margin.onMenuOpenSettings(() => set({ settingsOpen: true }));
      window.margin.onGdocsSyncChanged((gdocsSync) => set({ gdocsSync }));
      // Fallback for when the page has focus and no native menu fires
      // (Linux without a menubar); open-only, so a menu-consumed
      // accelerator never double-toggles.
      window.addEventListener('keydown', (e) => {
        if (e.key === ',' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          set({ settingsOpen: true });
        }
      });
    },

    setMode: (mode) => set({ mode }),

    handleDocChange: (content, changes) => {
      const { review } = get();
      if (review) {
        const mapAnchor = (a: Anchor): Anchor => {
          if (a.orphaned) return a;
          const from = changes.mapPos(a.from, 1);
          const to = changes.mapPos(a.to, -1);
          if (to < from) return { ...a, from, to: from, orphaned: true };
          return { ...a, from, to };
        };
        set({
          review: {
            ...review,
            comments: review.comments.map((c) => ({ ...c, anchor: mapAnchor(c.anchor) })),
            suggestions: review.suggestions.map((s) => {
              if (s.status === 'pending') return { ...s, anchor: mapAnchor(s.anchor) };
              // An accepted edit stays undoable, so its landing site has to
              // follow the document too (#128).
              if (!s.applied) return s;
              const from = changes.mapPos(s.applied.from, 1);
              const to = changes.mapPos(s.applied.to, -1);
              return { ...s, applied: to < from ? undefined : { from, to } };
            }),
          },
        });
      }
      // The open composer's anchor moves with the text too. It used to be
      // safe to skip: any new selection re-targeted the composer, so it
      // rarely outlived an edit. It now stays put by design (spec §8), so
      // an unmapped offset would quietly re-point the draft at whatever
      // slid into its place — the very failure #121 is about.
      const composerAnchor = get().composerAnchor;
      if (composerAnchor) {
        const from = changes.mapPos(composerAnchor.from, 1);
        const to = changes.mapPos(composerAnchor.to, -1);
        set({
          composerAnchor:
            to <= from
              ? // The words are gone. Keep the draft and what it was about;
                // committing it says so rather than grabbing the neighbours.
                { ...composerAnchor, from, to: from, orphaned: true }
              : { from, to, quote: content.slice(from, to) },
        });
      }
      set({ content, dirty: true });
      scheduleSave();
    },

    setSelection: (selection) => set({ selection }),
    previewQuote: null,
    setPreviewQuote: (previewQuote) => set({ previewQuote }),
    setActiveAnchor: (activeAnchorId) => set({ activeAnchorId }),

    composerDraft: emptyDraft,
    setComposerDraft: (patch) => set({ composerDraft: { ...get().composerDraft, ...patch } }),
    composerFocus: 0,

    openRevisions: [],
    setRevisionOpen: (key, open) => {
      const current = get().openRevisions;
      const has = current.includes(key);
      if (has === open) return; // no churn, and no new array to re-render on
      set({ openRevisions: open ? [...current, key] : current.filter((k) => k !== key) });
    },

    openComposer: () => {
      const { selection, content, mode, previewQuote, composerAnchor, composerDraft } = get();
      // A composer holding work keeps its anchor and takes focus instead
      // (spec §8). Re-targeting it would silently re-point a comment at
      // text it wasn't written about; clearing it would throw away typed
      // work on a misclick. Both are worse than a click that visibly
      // lands somewhere else.
      if (composerAnchor && draftHasContent(composerDraft, composerAnchor.quote)) {
        set({ composerFocus: get().composerFocus + 1 });
        return;
      }
      if (mode === 'preview') {
        // Rendered text loses source offsets — re-locate the quote in the
        // source. Selections that cross markdown formatting won't resolve.
        const quote = previewQuote?.trim();
        const found = quote ? resolveQuote(content, quote) : null;
        if (!found) return;
        set({
          composerAnchor: { from: found.from, to: found.to, quote: content.slice(found.from, found.to) },
          // The mode survives a re-target; the replacement cannot — it was
          // a copy of the old quote and is now about different words.
          composerDraft: { ...composerDraft, replacement: null },
        });
        return;
      }
      if (!selection || selection.from === selection.to) return;
      set({
        composerAnchor: {
          from: selection.from,
          to: selection.to,
          quote: content.slice(selection.from, selection.to),
        },
        composerDraft: { ...composerDraft, replacement: null },
      });
    },

    closeComposer: () => set({ composerAnchor: null, composerDraft: emptyDraft }),

    addComment: (text) => {
      const { composerAnchor, content } = get();
      if (!composerAnchor || !text.trim()) return;
      // Focus the new thread so the sidebar's activeAnchorId effect
      // scrolls it into view instead of burying it (issue #88).
      const newId = nanoid(8);
      updateReview((r) => ({
        ...r,
        comments: [
          ...r.comments,
          {
            id: newId,
            author: 'user' as const,
            createdAt: new Date().toISOString(),
            round: r.round,
            text: text.trim(),
            anchor: anchorForDraft(content, composerAnchor),
            replies: [],
            status: 'open' as const,
          },
        ],
      }));
      set({ composerAnchor: null, composerDraft: emptyDraft, activeAnchorId: newId });
    },

    addSuggestion: (replacement, note) => {
      const { composerAnchor, content } = get();
      if (!composerAnchor || replacement === composerAnchor.quote) return;
      updateReview((r) => ({
        ...r,
        suggestions: [
          ...r.suggestions,
          {
            id: nanoid(8),
            author: 'user' as const,
            createdAt: new Date().toISOString(),
            round: r.round,
            anchor: anchorForDraft(content, composerAnchor),
            replacement,
            note: note?.trim() || undefined,
            status: 'pending' as const,
          },
        ],
      }));
      set({ composerAnchor: null, composerDraft: emptyDraft });
    },

    addDocReply: (threadId, text, driveReplyId) => {
      updateReview((r) => ({
        ...r,
        comments: r.comments.map((c) =>
          c.id === threadId
            ? {
                ...c,
                replies: [
                  ...c.replies,
                  {
                    id: nanoid(8),
                    author: 'user' as const,
                    text,
                    createdAt: new Date().toISOString(),
                    round: r.round,
                    driveReplyId,
                  },
                ],
              }
            : c,
        ),
      }));
    },

    replyToThread: (threadId, text) => {
      if (!text.trim()) return;
      updateReview((r) => ({
        ...r,
        comments: r.comments.map((c) =>
          c.id === threadId
            ? // Replying is proof of having read what came before it, so the
              // seen marker advances without waiting for a click.
              markSeen({
                ...c,
                replies: [
                  ...c.replies,
                  {
                    id: nanoid(8),
                    author: 'user' as const,
                    text: text.trim(),
                    createdAt: new Date().toISOString(),
                    round: r.round,
                  },
                ],
              })
            : c,
        ),
      }));
    },

    editComment: (threadId, text) => {
      const { review } = get();
      const t = review?.comments.find((c) => c.id === threadId);
      if (!t || !text.trim() || !threadEditable(t, review!.round)) return;
      updateReview((r) => ({
        ...r,
        comments: r.comments.map((c) => (c.id === threadId ? { ...c, text: text.trim() } : c)),
      }));
    },

    deleteComment: (threadId) => {
      const { review } = get();
      const t = review?.comments.find((c) => c.id === threadId);
      if (!t || !threadEditable(t, review!.round)) return;
      // Its own replies go with it. They can only be the author's, written
      // this round — anything else would have made the thread uneditable.
      updateReview((r) => ({ ...r, comments: r.comments.filter((c) => c.id !== threadId) }));
      if (get().activeAnchorId === threadId) set({ activeAnchorId: null });
    },

    editReply: (threadId, replyId, text) => {
      const { review } = get();
      const t = review?.comments.find((c) => c.id === threadId);
      const reply = t?.replies.find((r) => r.id === replyId);
      if (!reply || !text.trim() || !replyEditable(reply, review!.round)) return;
      updateReview((r) => ({
        ...r,
        comments: r.comments.map((c) =>
          c.id === threadId
            ? {
                ...c,
                replies: c.replies.map((x) => (x.id === replyId ? { ...x, text: text.trim() } : x)),
              }
            : c,
        ),
      }));
    },

    deleteReply: (threadId, replyId) => {
      const { review } = get();
      const t = review?.comments.find((c) => c.id === threadId);
      const reply = t?.replies.find((r) => r.id === replyId);
      if (!reply || !replyEditable(reply, review!.round)) return;
      updateReview((r) => ({
        ...r,
        comments: r.comments.map((c) =>
          c.id === threadId ? { ...c, replies: c.replies.filter((x) => x.id !== replyId) } : c,
        ),
      }));
    },

    editSuggestion: (id, patch) => {
      const { review } = get();
      const s = review?.suggestions.find((x) => x.id === id);
      if (!s || !suggestionEditable(s, review!.round)) return;
      updateReview((r) => ({
        ...r,
        suggestions: r.suggestions.map((x) =>
          x.id === id
            ? {
                ...x,
                replacement: patch.replacement ?? x.replacement,
                note: patch.note !== undefined ? patch.note.trim() || undefined : x.note,
              }
            : x,
        ),
      }));
    },

    deleteSuggestion: (id) => {
      const { review } = get();
      const s = review?.suggestions.find((x) => x.id === id);
      if (!s || !suggestionEditable(s, review!.round)) return;
      updateReview((r) => ({ ...r, suggestions: r.suggestions.filter((x) => x.id !== id) }));
      if (get().activeAnchorId === id) set({ activeAnchorId: null });
    },

    setThreadStatus: (threadId, status) => {
      updateReview((r) => ({
        ...r,
        comments: r.comments.map((c) => (c.id === threadId ? { ...c, status } : c)),
      }));
    },

    acceptSuggestion: (id) => {
      const { review } = get();
      const s = review?.suggestions.find((x) => x.id === id);
      if (!s || s.status !== 'pending') return;
      const applied = s.anchor.orphaned
        ? undefined
        : { from: s.anchor.from, to: s.anchor.from + s.replacement.length };
      if (!s.anchor.orphaned) {
        // Dispatching through the editor keeps every other anchor mapped
        // correctly. Off the undo stack: this is a decision, and Cmd-Z
        // reverting only its text half is what desynced the two (#128).
        applyReplacement(s.anchor.from, s.anchor.to, s.replacement, { addToHistory: false });
      }
      updateReview((r) => ({
        ...r,
        suggestions: r.suggestions.map((x) =>
          x.id === id ? { ...x, status: 'accepted' as const, applied } : x,
        ),
      }));
    },

    focusRequest: null,
    focusAnchor: (id) => {
      const prev = get().focusRequest;
      set({ activeAnchorId: id, focusRequest: { id, n: (prev?.id === id ? prev.n : 0) + 1 } });
      get().markThreadSeen(id);
    },

    markThreadSeen: (id) => {
      const { review } = get();
      const t = review?.comments.find((c) => c.id === id);
      if (!t || markSeen(t) === t) return; // nothing new to acknowledge
      updateReview((r) => ({
        ...r,
        comments: r.comments.map((c) => (c.id === id ? markSeen(c) : c)),
      }));
    },

    undoDecision: (id) => {
      const { review } = get();
      const s = review?.suggestions.find((x) => x.id === id);
      if (!s || s.status === 'pending') return;
      // An accepted edit is put back by restoring the text it replaced. The
      // applied range is remapped with every doc change, so this stays
      // correct however much the author has written since.
      if (s.status === 'accepted' && s.applied) {
        applyReplacement(s.applied.from, s.applied.to, s.anchor.quote, { addToHistory: false });
      }
      updateReview((r) => ({
        ...r,
        suggestions: r.suggestions.map((x) =>
          x.id === id
            ? { ...x, status: 'pending' as const, applied: undefined, decisionComment: undefined }
            : x,
        ),
      }));
    },

    rejectSuggestion: (id, comment) => {
      updateReview((r) => ({
        ...r,
        suggestions: r.suggestions.map((x) =>
          x.id === id
            ? { ...x, status: 'rejected' as const, decisionComment: comment?.trim() || undefined }
            : x,
        ),
      }));
    },

    save: async () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      const { doc, content, review } = get();
      if (!doc) return;
      const refreshed = review ? refreshAnchors(review, content) : null;
      if (refreshed) set({ review: refreshed });
      await window.margin.saveDoc(content);
      if (refreshed) await window.margin.updateReview(refreshed);
      set({ dirty: false });
    },

    modelPref: {},
    resolveModelPref: async (workspaceRoot) => {
      const legacyKey = `margin-model:${workspaceRoot}`;
      const legacy = localStorage.getItem(legacyKey) ?? undefined;
      const pref = await window.margin.getProjectSettings(legacy);
      if (legacy) localStorage.removeItem(legacyKey);
      set({ modelPref: pref });
    },

    setModelPref: (pref) => {
      // Sticky per project: changing it at turn time becomes the
      // project's choice, stored in .margin/project.json so it travels
      // with the folder (Drew's cascade, DECISIONS §61).
      set({ modelPref: pref });
      void window.margin.setProjectSettings(pref);
    },
    hoveredAnchorId: null,
    setHoveredAnchor: (hoveredAnchorId) => set({ hoveredAnchorId }),
    diskConflict: false,
    resolveConflict: async (choice) => {
      set({ diskConflict: false });
      if (choice === 'reload') {
        set({ dirty: false }); // discard local edits deliberately
        await window.margin.reloadDoc();
      } else {
        await get().save(); // assert our version on disk
      }
    },

    dockOpen: false,
    toggleDock: () => {
      const { doc, dockOpen } = get();
      const next = !dockOpen;
      set({ dockOpen: next });
      if (doc) localStorage.setItem(`margin-dock-open:${doc.workspaceRoot}`, String(next));
    },

    removeDiscussionMessage: (id) => {
      const discussion = get().discussion.filter((m) => !(m.id === id && m.pending));
      set({ discussion });
      void window.margin.updateDiscussion(discussion);
    },

    editDiscussionMessage: (id, text) => {
      // Queued only. Once a message has gone with a round it is a record of
      // what was said, the same rule the review sidecar follows (spec §8).
      if (!text.trim()) return;
      const discussion = get().discussion.map((m) =>
        m.id === id && m.pending ? { ...m, text: text.trim() } : m,
      );
      set({ discussion });
      void window.margin.updateDiscussion(discussion);
    },

    addDiscussionMessage: (text) => {
      if (!text.trim()) return;
      const discussion = [
        ...get().discussion,
        {
          id: nanoid(8),
          author: 'user' as const,
          text: text.trim(),
          createdAt: new Date().toISOString(),
          pending: true,
        },
      ];
      set({ discussion });
      void window.margin.updateDiscussion(discussion);
    },

    submit: async () => {
      const { doc, content, review, modelPref } = get();
      if (!doc || !review) return;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      const refreshed = refreshAnchors(review, content);
      set({
        review: refreshed,
        agent: { phase: 'running', detail: 'Submitting…' },
        activity: [],
        dirty: false,
      });
      await window.margin.submitReview(content, refreshed, modelPref.model, modelPref.effort);
    },

    cancelReview: async () => {
      await window.margin.cancelReview();
    },
  };
});

/** True while an agent round is running — the editor and review actions lock. */
export function useLocked(): boolean {
  return useStore((s) => s.agent.phase === 'running');
}
