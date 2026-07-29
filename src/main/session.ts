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
import { classifyAgentError, reviewOutputSize } from '@shared/agentErrors';
import { IPC } from '@shared/ipc';
import { loadReview, saveReview } from './reviewStore';
import { loadDiscussion, saveDiscussion } from './discussionStore';
import { declaresProject, findProjectRoot, isInside } from './workspace';
import { saveProjectFile } from './projectFile';
import { acquireRoundLock } from './roundLock';
import { commitCheckpoint, isInRepo } from './git';
import { getAgent, type ActiveTurn } from './agents';

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
    public workspaceRoot: string,
    public content: string,
    public review: ReviewData,
    public discussion: DiscussionData,
    public inGitRepo: boolean,
    private readonly win: BrowserWindow,
    /**
     * Whether a folder actually declared itself a project (spec §3).
     * False means `workspaceRoot` is the document's folder standing in,
     * not somewhere anything project-scoped should be written.
     */
    public hasProject: boolean = true,
  ) {}

  /**
   * `explicitRoot` is the project this *window* is scoped to — set when
   * the author opened a folder, and carried along when the explorer
   * switches documents. It is what makes `book/` stay `book/` while
   * showing `chapter1/foo.md`, rather than the walk quietly re-rooting
   * the window on the nearer declaration (spec §1).
   *
   * It is verified rather than trusted: a root that does not declare
   * itself, or does not contain the document, falls back to the walk.
   */
  static async open(
    filePath: string,
    win: BrowserWindow,
    explicitRoot?: string,
  ): Promise<DocumentSession> {
    const content = await fs.readFile(filePath, 'utf8');
    const review = await loadReview(filePath, content);
    const inRepo = await isInRepo(filePath);
    const scoped =
      explicitRoot &&
      isInside(explicitRoot, path.dirname(filePath)) &&
      (await declaresProject(explicitRoot))
        ? explicitRoot
        : null;
    const declared = scoped ?? (await findProjectRoot(filePath));
    // The declared project, or the document's own folder as a working
    // root. `hasProject` is what tells the truth about which (spec §3).
    const root = declared ?? path.dirname(filePath);
    // Migrate any legacy per-doc discussion into the project-scoped store.
    // With no project there is nowhere to migrate *to*, and the legacy
    // messages stay in the sidecar until one exists.
    const discussion =
      declared !== null
        ? await loadDiscussion(root, review.discussion)
        : { version: 1 as const, messages: [] };
    const session = new DocumentSession(filePath, root, content, review, discussion, inRepo, win, declared !== null);
    session.startWatching();
    return session;
  }

  /**
   * Adopt `root` as this document's project: write `margin.json` and
   * re-scope the window to it (spec §5).
   *
   * **The act and the record are the same thing** — there is no adoption
   * that did not write the file, and no file written without adopting.
   *
   * Done in place rather than by reloading the document, because the
   * author is mid-something when they are asked: adoption is triggered by
   * submitting a round, and a reload would take the composer draft and
   * the editor's undo history with it.
   */
  async adopt(root: string): Promise<void> {
    await saveProjectFile(root, {});
    this.workspaceRoot = root;
    this.hasProject = true;
    this.discussion = await loadDiscussion(root, this.review.discussion);
    // The old watcher was pointed at a `.margin/` that was never going to
    // exist; the new root has one now.
    this.restartWatching();
    this.sendToRenderer(IPC.discussionUpdated, this.discussion.messages);
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

  private restartWatching(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    this.startWatching();
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
      hasProject: this.hasProject,
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

  /**
   * The last gate before project state reaches disk (spec §4, #169).
   *
   * Without a declaration `workspaceRoot` is the document's own folder,
   * and writing into it would create the `.margin/` that a later walk
   * reads back as a project — the accident this spec removes, arriving by
   * a different door. So the write is refused rather than redirected.
   *
   * It throws because by the time anything gets here the UI has already
   * failed: every affordance that would reach these is *unavailable*
   * without a project, since silently swallowing a queued message the
   * author watched appear would be worse than the accident.
   */
  private requireProject(what: string): void {
    if (!this.hasProject) {
      throw new Error(`${what} needs a project. Choose a folder for this document first.`);
    }
  }

  /** The agent's persistent working memory — its single write surface. */
  async setAgentNotes(content: string): Promise<void> {
    this.requireProject('The agent’s notes');
    await fs.mkdir(path.dirname(this.agentNotesPath), { recursive: true });
    await fs.writeFile(this.agentNotesPath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  }

  async setDiscussion(messages: DiscussionMessage[]): Promise<void> {
    this.requireProject('The discussion');
    this.discussion.messages = messages;
    await saveDiscussion(this.workspaceRoot, this.discussion);
  }

  async mutateDiscussion(fn: (d: DiscussionData) => void): Promise<void> {
    this.requireProject('The discussion');
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
    // Committed, so the project's other windows should show it — as a
    // count in their explorer, since one document is only ever open in
    // one window (spec §8).
    this.notifyPeersOfWrite();
  }

  /** Mutate review state from the main process (agent tools) and notify the renderer. */
  async mutateReview(fn: (review: ReviewData) => void): Promise<void> {
    fn(this.review);
    await saveReview(this.filePath, this.review);
    this.sendToRenderer(IPC.reviewUpdated, this.review);
    this.notifyPeersOfWrite();
  }

  sendToRenderer(channel: string, ...args: unknown[]): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, ...args);
  }

  private setAgentStatus(status: AgentStatus): void {
    this.sendToRenderer(IPC.agentStatus, status);
    // The other windows on this project are told a round is happening,
    // but through a *different* channel (spec §8, scenario 18).
    //
    // Not through `agentStatus`, which is what locks a window: the round
    // owns the review of *its* document, and a peer window is editing a
    // different one that the turn never touches. Locking it would be a
    // broader claim than the round actually makes, and the author would
    // watch an unrelated document go read-only for a minute.
    this.notifyPeers({
      running: status.phase === 'running',
      document: this.fileName,
    });
  }

  private notifyPeers(round: { running: boolean; document: string }): void {
    for (const peer of projectPeers(this)) peer.sendToRenderer(IPC.peerRound, round);
  }

  /**
   * Tell the project's other windows that committed state moved.
   *
   * An in-process nudge rather than a filesystem watcher on every
   * sidecar in the project: the writes that matter all originate here,
   * and a watcher per document would scale with the folder rather than
   * with what is actually open.
   */
  private notifyPeersOfWrite(): void {
    for (const peer of projectPeers(this)) peer.sendToRenderer(IPC.projectChanged);
  }

  /**
   * Submit the current state for an agent review round:
   * checkpoint via git, run the agent turn, checkpoint again.
   */
  async submitReview(
    content: string,
    review: ReviewData,
    model?: string,
    effort?: string,
  ): Promise<void> {
    // A round writes agent notes and can stage proposals, so it is the
    // moment the app asks for a project (spec §4). The renderer asks
    // before calling this; the guard is what makes that a rule rather
    // than a convention.
    this.requireProject('A review round');
    // Held against the *document*, so two windows reaching one file
    // through different paths cannot run two turns against one sidecar
    // (spec §7). Taken before anything is written, so a refusal costs
    // nothing — and released in the finally below however the turn ends.
    const lease = await acquireRoundLock(this.filePath);
    try {
      await this.runRound(content, review, model, effort);
    } finally {
      lease.release();
      this.activeTurn = null;
    }
  }

  private async runRound(
    content: string,
    review: ReviewData,
    model?: string,
    effort?: string,
  ): Promise<void> {
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

    // Measured after the counter moved and before the turn starts, so the
    // comparison in the catch below asks exactly one question: did this
    // turn put anything into the review?
    const outputBefore = reviewOutputSize(this.review);

    this.setAgentStatus({ phase: 'running', detail: 'Starting review…' });
    try {
      const turn = await getAgent().runReviewTurn(
        this,
        {
          onActivity: (detail) => {
            this.setAgentStatus({ phase: 'running', detail });
            this.sendToRenderer(IPC.agentActivity, detail);
          },
        },
        model,
        effort,
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
      const raw = err instanceof Error ? err.message : String(err);
      const failure = classifyAgentError(raw);
      // A round that produced nothing did not happen, and is put back the
      // way it was (#79, #106): the counter returns, and the discussion
      // messages that rode along go back into the queue. Otherwise the
      // author's drafts read as "awaiting reply" forever against a turn
      // that never answered, and their queued messages are gone with no
      // way to send them but retyping. Retry is then just Submit — there
      // is no second path to build or to explain.
      //
      // Partial output is kept instead. Replies and suggestions that did
      // land are real work, and a rollback would misstate them.
      const rolledBack = reviewOutputSize(this.review) === outputBefore;
      if (rolledBack) {
        this.review.round -= 1;
        await saveReview(this.filePath, this.review);
        await this.mutateDiscussion((d) => {
          for (const m of d.messages) {
            if (this.lastSubmittedMessageIds.has(m.id)) m.pending = true;
          }
        });
        this.lastSubmittedMessageIds = new Set();
        this.sendToRenderer(IPC.reviewUpdated, this.review);
      }
      this.setAgentStatus({
        phase: 'error',
        detail: failure.message,
        failure: { ...failure, rolledBack },
      });
      // The raw text is still worth having when the message above turns
      // out to be the wrong guess about what happened.
      this.sendToRenderer(IPC.agentActivity, `Round failed: ${raw}`);
    }
    // `activeTurn` and the document lock are both cleared by the caller's
    // finally, so an exception thrown outside this try still releases.
  }

  async cancelReview(): Promise<void> {
    await this.activeTurn?.cancel();
  }
}

/** Registry: webContents.id -> session. */
const sessions = new Map<number, DocumentSession>();

/**
 * Windows whose renderer is mid project-setup conversation. Opening a
 * file into one of these would discard the transcript (issue #82), so
 * openFile() routes to a new window instead.
 */
const activeSetups = new Set<number>();

export function setSetupActive(webContentsId: number, active: boolean): void {
  if (active) activeSetups.add(webContentsId);
  else activeSetups.delete(webContentsId);
}

export function hasActiveSetup(webContentsId: number): boolean {
  return activeSetups.has(webContentsId);
}

export function getSession(webContentsId: number): DocumentSession | undefined {
  return sessions.get(webContentsId);
}

export function setSession(webContentsId: number, session: DocumentSession): void {
  sessions.get(webContentsId)?.dispose(); // switching documents replaces the session
  sessions.set(webContentsId, session);
  notifyOtherWindows(session);
}

export function dropSession(webContentsId: number): void {
  sessions.get(webContentsId)?.dispose();
  sessions.delete(webContentsId);
  activeSetups.delete(webContentsId);
  notifyOtherWindows(undefined);
}

/**
 * Tell every other window that the set of open documents changed.
 *
 * The explorer's "open elsewhere" marker is derived from live sessions
 * rather than from disk, so opening, switching or closing a document is
 * exactly the event that makes a sibling's explorer stale — and nothing
 * on the filesystem moves to announce it. Sent to *all* other windows,
 * not just the project's peers: two projects can share a document (§6),
 * so the marker crosses projects even though committed state does not.
 */
function notifyOtherWindows(except: DocumentSession | undefined): void {
  for (const s of sessions.values()) {
    if (s !== except) s.sendToRenderer(IPC.projectChanged);
  }
}

export function findSessionByPath(filePath: string): DocumentSession | undefined {
  for (const s of sessions.values()) if (s.filePath === filePath) return s;
  return undefined;
}

/** Every open document, across every window. */
export function allSessions(): DocumentSession[] {
  return [...sessions.values()];
}

/**
 * The other windows on the same project (spec §8).
 *
 * A project's windows are peers: committed state reaches all of them,
 * and a round running in one is worth saying in the others. Keyed on the
 * workspace root, which is the window's own declared project — not the
 * document's, since a document can belong to several (§6).
 */
export function projectPeers(of: DocumentSession): DocumentSession[] {
  if (!of.hasProject) return []; // nothing declared, so nothing to be a peer of
  return [...sessions.values()].filter((s) => s !== of && s.hasProject && s.workspaceRoot === of.workspaceRoot);
}

/** Paths held by windows other than this one — the explorer's marker. */
export function pathsOpenElsewhere(than: DocumentSession | undefined): Set<string> {
  const paths = new Set<string>();
  for (const s of sessions.values()) if (s !== than) paths.add(s.filePath);
  return paths;
}
