import { promises as fs, watch, type FSWatcher } from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import type { BrowserWindow } from 'electron';
import type {
  AgentStatus,
  DiscussionData,
  DiscussionMessage,
  DocState,
  ReviewData,
} from '@shared/types';
import { IPC } from '@shared/ipc';
import { loadReview, saveReview } from './reviewStore';
import { loadDiscussion, saveDiscussion } from './discussionStore';
import { findWorkspaceRoot } from './workspace';
import { commitCheckpoint, isInRepo } from './git';
import { runReviewTurn, type ActiveTurn } from './agent';

/**
 * One open document, owned by one window. The renderer owns content and
 * review state while the user is editing; the main process takes ownership
 * during an agent review turn (the renderer locks itself while `agentRunning`).
 */
export class DocumentSession {
  private activeTurn: ActiveTurn | null = null;
  private watchers: FSWatcher[] = [];
  private watchDebounce: ReturnType<typeof setTimeout> | null = null;
  /** Ids of discussion messages submitted with the round in flight. */
  public lastSubmittedMessageIds: Set<string> = new Set();
  /** Renderer-reported caret context, consumed by the native context menu. */
  public caretInTable = false;

  private constructor(
    public readonly filePath: string,
    public readonly workspaceRoot: string,
    public content: string,
    public review: ReviewData,
    public discussion: DiscussionData,
    public inGitRepo: boolean,
    private readonly win: BrowserWindow,
  ) {}

  static async open(filePath: string, win: BrowserWindow): Promise<DocumentSession> {
    const content = await fs.readFile(filePath, 'utf8');
    const review = await loadReview(filePath, content);
    const inRepo = await isInRepo(filePath);
    const root = await findWorkspaceRoot(filePath);
    // Migrate any legacy per-doc discussion into the project-scoped store.
    const discussion = await loadDiscussion(root, review.discussion);
    const session = new DocumentSession(filePath, root, content, review, discussion, inRepo, win);
    session.startWatching();
    return session;
  }

  /**
   * Watch for external changes: the document itself (watch the directory —
   * editors save via atomic rename, which kills single-file watchers) and
   * the project discussion (another Margin window may write it).
   */
  private startWatching(): void {
    try {
      const dir = path.dirname(this.filePath);
      const base = path.basename(this.filePath);
      this.watchers.push(
        watch(dir, (_event, filename) => {
          if (filename === base) this.onExternalChange();
        }),
      );
    } catch {
      /* watching is best-effort */
    }
    try {
      const discussionDir = path.join(this.workspaceRoot, '.margin');
      this.watchers.push(
        watch(discussionDir, (_event, filename) => {
          if (filename === 'discussion.json') this.onExternalChange();
        }),
      );
    } catch {
      /* .margin/ may not exist yet — created on first save; doc watcher covers the common case */
    }
  }

  dispose(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
  }

  private onExternalChange(): void {
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.watchDebounce = setTimeout(() => void this.checkExternalChange(), 250);
  }

  private async checkExternalChange(): Promise<void> {
    // Discussion: reload and push if it differs (last writer wins; both
    // windows converge instead of silently diverging).
    try {
      const raw = await fs.readFile(
        path.join(this.workspaceRoot, '.margin', 'discussion.json'),
        'utf8',
      );
      const onDisk = JSON.parse(raw) as DiscussionData;
      if (JSON.stringify(onDisk.messages) !== JSON.stringify(this.discussion.messages)) {
        this.discussion = onDisk;
        this.sendToRenderer(IPC.discussionUpdated, this.discussion.messages);
      }
    } catch {
      /* no discussion file yet */
    }

    // Document: our own saves write session.content first, so identical
    // content means the event was ours (or a no-op) — ignore it.
    let onDisk: string;
    try {
      onDisk = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return; // transient (atomic rename mid-flight) — next event will catch up
    }
    if (onDisk === this.content) return;
    if (this.activeTurn) return; // never interrupt a running round
    // The renderer knows whether it has unsaved edits; it either reloads
    // immediately or shows the conflict banner.
    this.sendToRenderer(IPC.docChangedOnDisk);
  }

  get fileName(): string {
    return path.basename(this.filePath);
  }

  toDocState(): DocState {
    return {
      filePath: this.filePath,
      fileName: this.fileName,
      loadedAt: Date.now(),
      content: this.content,
      review: this.review,
      discussion: this.discussion.messages,
      workspaceRoot: this.workspaceRoot,
      inGitRepo: this.inGitRepo,
    };
  }

  get agentNotesPath(): string {
    return path.join(this.workspaceRoot, '.margin', 'agent-notes.md');
  }

  async readAgentNotes(): Promise<string> {
    try {
      return await fs.readFile(this.agentNotesPath, 'utf8');
    } catch {
      return '';
    }
  }

  /** The agent's persistent working memory — its single write surface. */
  async setAgentNotes(content: string): Promise<void> {
    await fs.mkdir(path.dirname(this.agentNotesPath), { recursive: true });
    await fs.writeFile(this.agentNotesPath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  }

  async setDiscussion(messages: DiscussionMessage[]): Promise<void> {
    this.discussion.messages = messages;
    await saveDiscussion(this.workspaceRoot, this.discussion);
  }

  async mutateDiscussion(fn: (d: DiscussionData) => void): Promise<void> {
    fn(this.discussion);
    await saveDiscussion(this.workspaceRoot, this.discussion);
    this.sendToRenderer(IPC.discussionUpdated, this.discussion.messages);
  }

  async saveContent(content: string): Promise<void> {
    this.content = content;
    await fs.writeFile(this.filePath, content, 'utf8');
  }

  async setReview(review: ReviewData): Promise<void> {
    this.review = review;
    await saveReview(this.filePath, review);
  }

  /** Mutate review state from the main process (agent tools) and notify the renderer. */
  async mutateReview(fn: (review: ReviewData) => void): Promise<void> {
    fn(this.review);
    await saveReview(this.filePath, this.review);
    this.sendToRenderer(IPC.reviewUpdated, this.review);
  }

  sendToRenderer(channel: string, ...args: unknown[]): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, ...args);
  }

  private setAgentStatus(status: AgentStatus): void {
    this.sendToRenderer(IPC.agentStatus, status);
  }

  /**
   * Submit the current state for an agent review round:
   * checkpoint via git, run the agent turn, checkpoint again.
   */
  async submitReview(content: string, review: ReviewData, model?: string): Promise<void> {
    if (this.activeTurn) throw new Error('A review is already running');
    await this.saveContent(content);
    await this.setReview(review);

    this.review.round += 1;
    await saveReview(this.filePath, this.review);
    // Queued project-discussion messages ride along with this round.
    this.lastSubmittedMessageIds = new Set(
      this.discussion.messages.filter((m) => m.pending).map((m) => m.id),
    );
    await this.mutateDiscussion((d) => {
      for (const m of d.messages) {
        if (m.pending) m.pending = false;
      }
    });
    this.sendToRenderer(IPC.reviewUpdated, this.review);

    if (this.inGitRepo) {
      try {
        await commitCheckpoint(
          this.filePath,
          `Review round ${this.review.round} (${this.fileName}): submitted`,
          [path.join(this.workspaceRoot, '.margin')],
        );
      } catch (err) {
        // A failed checkpoint shouldn't block the review; surface it as activity.
        this.sendToRenderer(IPC.agentActivity, `git checkpoint failed: ${String(err)}`);
      }
    }

    this.setAgentStatus({ phase: 'running', detail: 'Starting review…' });
    try {
      const turn = await runReviewTurn(
        this,
        {
          onActivity: (detail) => {
            this.setAgentStatus({ phase: 'running', detail });
            this.sendToRenderer(IPC.agentActivity, detail);
          },
        },
        model,
      );
      this.activeTurn = turn;
      const summary = await turn.done;
      // The agent's closing message is its reply in the project discussion.
      await this.mutateDiscussion((d) => {
        d.messages.push({
          id: nanoid(8),
          author: 'agent',
          text: summary,
          createdAt: new Date().toISOString(),
        });
      });
      if (this.inGitRepo) {
        try {
          await commitCheckpoint(
            this.filePath,
            `Review round ${this.review.round} (${this.fileName}): agent review`,
            [path.join(this.workspaceRoot, '.margin')],
          );
        } catch {
          /* nothing new to commit is fine */
        }
      }
      this.setAgentStatus({ phase: 'done', detail: summary });
    } catch (err) {
      this.setAgentStatus({ phase: 'error', detail: err instanceof Error ? err.message : String(err) });
    } finally {
      this.activeTurn = null;
    }
  }

  async cancelReview(): Promise<void> {
    await this.activeTurn?.cancel();
  }
}

/** Registry: webContents.id -> session. */
const sessions = new Map<number, DocumentSession>();

export function getSession(webContentsId: number): DocumentSession | undefined {
  return sessions.get(webContentsId);
}

export function setSession(webContentsId: number, session: DocumentSession): void {
  sessions.get(webContentsId)?.dispose(); // switching documents replaces the session
  sessions.set(webContentsId, session);
}

export function dropSession(webContentsId: number): void {
  sessions.get(webContentsId)?.dispose();
  sessions.delete(webContentsId);
}

export function findSessionByPath(filePath: string): DocumentSession | undefined {
  for (const s of sessions.values()) if (s.filePath === filePath) return s;
  return undefined;
}
