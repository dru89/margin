import { promises as fs } from 'fs';
import path from 'path';
import type { BrowserWindow } from 'electron';
import type { AgentStatus, DocState, ReviewData } from '@shared/types';
import { IPC } from '@shared/ipc';
import { loadReview, saveReview } from './reviewStore';
import { commitCheckpoint, isInRepo } from './git';
import { runReviewTurn, type ActiveTurn } from './agent';

/**
 * One open document, owned by one window. The renderer owns content and
 * review state while the user is editing; the main process takes ownership
 * during an agent review turn (the renderer locks itself while `agentRunning`).
 */
export class DocumentSession {
  private activeTurn: ActiveTurn | null = null;

  private constructor(
    public readonly filePath: string,
    public content: string,
    public review: ReviewData,
    public inGitRepo: boolean,
    private readonly win: BrowserWindow,
  ) {}

  static async open(filePath: string, win: BrowserWindow): Promise<DocumentSession> {
    const content = await fs.readFile(filePath, 'utf8');
    const review = await loadReview(filePath, content);
    const inRepo = await isInRepo(filePath);
    return new DocumentSession(filePath, content, review, inRepo, win);
  }

  get fileName(): string {
    return path.basename(this.filePath);
  }

  toDocState(): DocState {
    return {
      filePath: this.filePath,
      fileName: this.fileName,
      content: this.content,
      review: this.review,
      inGitRepo: this.inGitRepo,
    };
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
  async submitReview(
    content: string,
    review: ReviewData,
    note: string | undefined,
    model?: string,
  ): Promise<void> {
    if (this.activeTurn) throw new Error('A review is already running');
    await this.saveContent(content);
    await this.setReview(review);

    this.review.round += 1;
    await saveReview(this.filePath, this.review);

    if (this.inGitRepo) {
      try {
        await commitCheckpoint(this.filePath, `Review round ${this.review.round}: submitted`);
      } catch (err) {
        // A failed checkpoint shouldn't block the review; surface it as activity.
        this.sendToRenderer(IPC.agentActivity, `git checkpoint failed: ${String(err)}`);
      }
    }

    this.setAgentStatus({ phase: 'running', detail: 'Starting review…' });
    try {
      const turn = await runReviewTurn(
        this,
        note,
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
      if (this.inGitRepo) {
        try {
          await commitCheckpoint(this.filePath, `Review round ${this.review.round}: agent review`);
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
  sessions.set(webContentsId, session);
}

export function dropSession(webContentsId: number): void {
  sessions.delete(webContentsId);
}

export function findSessionByPath(filePath: string): DocumentSession | undefined {
  for (const s of sessions.values()) if (s.filePath === filePath) return s;
  return undefined;
}
