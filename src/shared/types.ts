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

/**
 * A message in the document-level discussion — framing, goals, general
 * feedback that isn't anchored to a text range. User messages are composed
 * any time and sent with the next review round (`pending` until then); the
 * agent's closing message each round is posted here as its reply.
 */
export interface DiscussionMessage {
  id: string;
  author: Author;
  text: string;
  createdAt: string;
  /** The round this message was part of. */
  round: number;
  /** Composed but not yet submitted with a round. */
  pending?: boolean;
}

export interface ReviewData {
  version: 1;
  /** Basename of the document this review belongs to. */
  document: string;
  /** Monotonically increasing review-round counter. */
  round: number;
  comments: CommentThread[];
  suggestions: Suggestion[];
  discussion: DiscussionMessage[];
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

export interface WorkspaceFile {
  path: string;
  /** Path relative to the workspace root. */
  rel: string;
  name: string;
  /** Containing directory relative to root; '' at root. */
  dir: string;
  /** Markdown opens in Margin; anything else opens in its native app. */
  kind: 'markdown' | 'other';
  openComments: number;
  pendingSuggestions: number;
  /** Differs from HEAD (git status), including untracked. */
  modified: boolean;
}

export interface WorkspaceState {
  root: string;
  rootName: string;
  files: WorkspaceFile[];
}

export interface RecentFile {
  path: string;
  name: string;
  openedAt: string;
}

export function emptyReview(documentName: string): ReviewData {
  return {
    version: 1,
    document: documentName,
    round: 0,
    comments: [],
    suggestions: [],
    discussion: [],
  };
}
