export type Author = 'user' | 'agent';

/**
 * A text anchor. `from`/`to` are character offsets into the document as of the
 * last time the app touched this anchor. `quote` is the exact text the anchor
 * covered at that moment; `prefix`/`suffix` are short context windows used to
 * re-locate the anchor after the document changes outside the app.
 */
export interface Anchor {
  from: number;
  to: number;
  quote: string;
  prefix?: string;
  suffix?: string;
  /** Set when the anchor text can no longer be found in the document. */
  orphaned?: boolean;
}

export interface Reply {
  id: string;
  author: Author;
  text: string;
  createdAt: string;
}

export type ThreadStatus = 'open' | 'resolved';

export interface CommentThread {
  id: string;
  author: Author;
  createdAt: string;
  text: string;
  anchor: Anchor;
  replies: Reply[];
  status: ThreadStatus;
}

export type SuggestionStatus = 'pending' | 'accepted' | 'rejected';

export interface Suggestion {
  id: string;
  author: Author;
  createdAt: string;
  anchor: Anchor;
  /** Replacement text for the anchored range. Empty string = deletion. */
  replacement: string;
  /** The author's rationale for the change. */
  note?: string;
  status: SuggestionStatus;
  /** Optional comment left by the user when accepting/rejecting. */
  decisionComment?: string;
}

export interface ReviewData {
  version: 1;
  /** Basename of the document this review belongs to. */
  document: string;
  /** Monotonically increasing review-round counter. */
  round: number;
  comments: CommentThread[];
  suggestions: Suggestion[];
}

export interface DocState {
  filePath: string;
  fileName: string;
  content: string;
  review: ReviewData;
  /** True when the document lives inside a git repository. */
  inGitRepo: boolean;
}

export type AgentPhase = 'idle' | 'running' | 'done' | 'error';

export interface AgentStatus {
  phase: AgentPhase;
  /** Human-readable description of what the agent is doing / did. */
  detail: string;
}

export interface RecentFile {
  path: string;
  name: string;
  openedAt: string;
}

export function emptyReview(documentName: string): ReviewData {
  return { version: 1, document: documentName, round: 0, comments: [], suggestions: [] };
}
