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
  /** Display name when this reply came from (or was sent to) the linked Google Doc. */
  collaborator?: string;
  /** Drive reply id — presence means it exists on the Doc (merge key). */
  driveReplyId?: string;
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
  /** 'imported' = from the linked Google Doc (read-down; replies stay local
   * unless explicitly sent via Reply on Doc). Absent = local. */
  provenance?: 'local' | 'imported';
  /** Drive comment id on imported threads (merge key + reply target). */
  driveCommentId?: string;
  /** Collaborator display name on imported threads. */
  collaborator?: string;
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
  /** Legacy (pre project-scope): the per-document round it was sent with. */
  round?: number;
  /** Composed but not yet submitted with a round. */
  pending?: boolean;
}

/** Project-scoped discussion, stored at <workspaceRoot>/.margin/discussion.json. */
export interface DiscussionData {
  version: 1;
  messages: DiscussionMessage[];
}

export interface ReviewData {
  version: 1;
  /** Basename of the document this review belongs to. */
  document: string;
  /** Monotonically increasing review-round counter. */
  round: number;
  comments: CommentThread[];
  suggestions: Suggestion[];
  /** Legacy location — discussion is project-scoped now (DiscussionData). */
  discussion: DiscussionMessage[];
}

export interface DocState {
  filePath: string;
  fileName: string;
  /** Bumps on every (re)load so the editor remounts even for the same path. */
  loadedAt: number;
  content: string;
  review: ReviewData;
  /** Project-scoped discussion (shared across all documents in the workspace). */
  discussion: DiscussionMessage[];
  workspaceRoot: string;
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
  /** Project skill names from <root>/.claude/skills/. */
  skills: string[];
  /** Path to the agent's notes file, when it exists (.margin/agent-notes.md). */
  agentNotesPath?: string;
  /** Agent file proposals (all statuses; the explorer shows pending ones). */
  proposals: FileProposal[];
}

export type ProposalStatus = 'pending' | 'accepted' | 'rejected';

/**
 * An agent-proposed new file. Content is staged at
 * `.margin/proposed/<path>` until the author accepts (file materializes at
 * `path`, folders created as needed) or rejects (staged content is removed;
 * the record survives so the agent respects the decision).
 */
export interface FileProposal {
  id: string;
  /** Intended location, relative to the workspace root. */
  path: string;
  /** The agent's rationale for creating this file. */
  note: string;
  createdAt: string;
  status: ProposalStatus;
  decidedAt?: string;
  /** Optional comment the author left when rejecting. */
  decisionComment?: string;
}

/** Project-scoped, stored at <workspaceRoot>/.margin/proposals.json. */
export interface ProposalsData {
  version: 1;
  proposals: FileProposal[];
}

/**
 * The card the agent produces during the new-project conversation. Nothing
 * is created until the author confirms; then the app makes the folder under
 * the projects directory, writes the seed files, and git-inits.
 */
export interface ProjectProposal {
  /** Folder name under the projects directory (single path segment). */
  folderName: string;
  title: string;
  description: string;
  files: { path: string; content: string }[];
}

/** One agent turn in the new-project conversation. */
export interface SetupReply {
  reply: string;
  proposal?: ProjectProposal;
}

export interface SetupMessage {
  author: Author;
  text: string;
}

export interface RecentFile {
  path: string;
  name: string;
  openedAt: string;
  /** Workspace root the file belongs to (absent on legacy entries). */
  root?: string;
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

/** Google Docs auth state shown in Settings (mirrors gdocs-sync's AuthStatus). */
export interface GdocsAuthStatus {
  /** Where the OAuth client comes from: an imported file, the app's built-in default, or nowhere. */
  clientSource: 'file' | 'default' | 'none';
  clientPath: string | null;
  connected: boolean;
  scopes: string[];
  /** An authorize() flow is waiting on browser consent. */
  connecting: boolean;
}

export interface AppSettingsState {
  projectsDir: string;
}

/** Google Docs link/push state for the focused document. */
export interface GdocsSyncState {
  linked: boolean;
  docUrl?: string;
  lastSyncAt?: string;
  busy: boolean;
  connected: boolean;
}
