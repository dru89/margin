import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type { ChangeDesc } from '@codemirror/state';
import type { AgentStatus, Anchor, DocState, ReviewData, WorkspaceState } from '@shared/types';
import { makeAnchor } from '@shared/anchors';
import { applyReplacement } from './editorBridge';

export type ViewMode = 'write' | 'preview';

interface MarginState {
  doc: DocState | null;
  content: string;
  review: ReviewData | null;
  mode: ViewMode;
  agent: AgentStatus;
  activity: string[];
  selection: { from: number; to: number } | null;
  activeAnchorId: string | null;
  composerAnchor: { from: number; to: number; quote: string } | null;
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
  setActiveAnchor: (id: string | null) => void;
  openComposer: () => void;
  closeComposer: () => void;
  addComment: (text: string) => void;
  replyToThread: (threadId: string, text: string) => void;
  setThreadStatus: (threadId: string, status: 'open' | 'resolved') => void;
  acceptSuggestion: (id: string) => void;
  rejectSuggestion: (id: string, comment?: string) => void;
  save: () => Promise<void>;
  reviewModel: string | undefined;
  setReviewModel: (model: string | undefined) => void;
  sidebarTab: 'review' | 'discussion';
  setSidebarTab: (tab: 'review' | 'discussion') => void;
  addDiscussionMessage: (text: string) => void;
  submit: () => Promise<void>;
  cancelReview: () => Promise<void>;
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
    mode: 'write',
    agent: { phase: 'idle', detail: '' },
    activity: [],
    selection: null,
    activeAnchorId: null,
    composerAnchor: null,
    dirty: false,
    workspace: null,
    explorerOpen: true,

    loadWorkspace: async () => {
      const workspace = await window.margin.getWorkspace();
      set({ workspace });
    },

    toggleExplorer: () => set((s) => ({ explorerOpen: !s.explorerOpen })),

    switchToFile: async (path) => {
      const { doc, save } = get();
      if (!doc || doc.filePath === path) return;
      await save(); // flush before the window switches documents
      await window.margin.openInWindow(path);
    },

    init: () => {
      if (initialized) return;
      initialized = true;

      const load = (doc: DocState) =>
        set({
          doc,
          content: doc.content,
          review: doc.review,
          agent: { phase: 'idle', detail: '' },
          activity: [],
          selection: null,
          activeAnchorId: null,
          composerAnchor: null,
          dirty: false,
        });

      void window.margin.getDoc().then((doc) => {
        if (doc) {
          load(doc);
          void get().loadWorkspace();
        }
      });
      window.margin.onDocLoaded((doc) => {
        load(doc);
        void get().loadWorkspace();
      });
      window.margin.onReviewUpdated((review) => set({ review }));
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
      window.margin.onMenuTogglePreview(() =>
        set((s) => ({ mode: s.mode === 'write' ? 'preview' : 'write' })),
      );
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
            suggestions: review.suggestions.map((s) =>
              s.status === 'pending' ? { ...s, anchor: mapAnchor(s.anchor) } : s,
            ),
          },
        });
      }
      set({ content, dirty: true });
      scheduleSave();
    },

    setSelection: (selection) => set({ selection }),
    setActiveAnchor: (activeAnchorId) => set({ activeAnchorId }),

    openComposer: () => {
      const { selection, content } = get();
      if (!selection || selection.from === selection.to) return;
      set({
        composerAnchor: {
          from: selection.from,
          to: selection.to,
          quote: content.slice(selection.from, selection.to),
        },
      });
    },

    closeComposer: () => set({ composerAnchor: null }),

    addComment: (text) => {
      const { composerAnchor, content } = get();
      if (!composerAnchor || !text.trim()) return;
      updateReview((r) => ({
        ...r,
        comments: [
          ...r.comments,
          {
            id: nanoid(8),
            author: 'user' as const,
            createdAt: new Date().toISOString(),
            text: text.trim(),
            anchor: makeAnchor(content, composerAnchor.from, composerAnchor.to),
            replies: [],
            status: 'open' as const,
          },
        ],
      }));
      set({ composerAnchor: null });
    },

    replyToThread: (threadId, text) => {
      if (!text.trim()) return;
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
                    text: text.trim(),
                    createdAt: new Date().toISOString(),
                  },
                ],
              }
            : c,
        ),
      }));
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
      if (!s.anchor.orphaned) {
        // Dispatching through the editor keeps every other anchor mapped correctly.
        applyReplacement(s.anchor.from, s.anchor.to, s.replacement);
      }
      updateReview((r) => ({
        ...r,
        suggestions: r.suggestions.map((x) =>
          x.id === id ? { ...x, status: 'accepted' as const } : x,
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

    reviewModel: undefined,
    setReviewModel: (reviewModel) => set({ reviewModel }),
    sidebarTab: 'review',
    setSidebarTab: (sidebarTab) => set({ sidebarTab }),

    addDiscussionMessage: (text) => {
      if (!text.trim()) return;
      updateReview((r) => ({
        ...r,
        discussion: [
          ...r.discussion,
          {
            id: nanoid(8),
            author: 'user' as const,
            text: text.trim(),
            createdAt: new Date().toISOString(),
            round: r.round + 1, // sent with the next round
            pending: true,
          },
        ],
      }));
    },

    submit: async () => {
      const { doc, content, review, reviewModel } = get();
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
      await window.margin.submitReview(content, refreshed, reviewModel);
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
