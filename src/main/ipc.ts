import { BrowserWindow, ipcMain, shell } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import type {
  DiscussionMessage,
  ProjectProposal,
  ReviewData,
  SetupMessage,
} from '@shared/types';
import { IPC } from '@shared/ipc';
import { findSessionByPath, getSession } from './session';
import { attachDocument, createWindow, openFile } from './windows';
import { showOpenDialog, showOpenFolderDialog } from './menu';
import { commitCheckpoint, fileLog, initProjectRepo, initRepo, isInRepo, restoreFromCommit } from './git';
import { runSetupTurn } from './agent';
import { getSettings } from './settings';
import { saveDiscussion } from './discussionStore';
import { getWorkspace } from './workspace';
import { getRecentFiles } from './recents';
import {
  acceptProposal,
  loadProposals,
  readProposalContent,
  rejectProposal,
} from './proposalsStore';

function requireSession(webContentsId: number) {
  const session = getSession(webContentsId);
  if (!session) throw new Error('No document open in this window');
  return session;
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.getDoc, (event) => {
    return getSession(event.sender.id)?.toDocState() ?? null;
  });

  ipcMain.handle(IPC.saveDoc, async (event, content: string) => {
    await requireSession(event.sender.id).saveContent(content);
  });

  ipcMain.handle(IPC.updateReview, async (event, review: ReviewData) => {
    await requireSession(event.sender.id).setReview(review);
  });

  ipcMain.handle(IPC.updateDiscussion, async (event, messages: DiscussionMessage[]) => {
    await requireSession(event.sender.id).setDiscussion(messages);
  });

  ipcMain.handle(
    IPC.submitReview,
    async (event, content: string, review: ReviewData, model?: string) => {
      // Fire-and-return: progress flows back through agentStatus events.
      void requireSession(event.sender.id).submitReview(content, review, model);
    },
  );

  ipcMain.handle(IPC.cancelReview, async (event) => {
    await requireSession(event.sender.id).cancelReview();
  });

  ipcMain.handle(IPC.openFileDialog, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    await showOpenDialog(win);
  });

  ipcMain.handle(IPC.openPath, async (_event, filePath: string) => {
    await openFile(filePath);
  });

  ipcMain.handle(IPC.newWindow, () => {
    createWindow();
  });

  ipcMain.handle(IPC.gitInit, async (event) => {
    const session = requireSession(event.sender.id);
    await initRepo(session.filePath);
    const inRepo = await isInRepo(session.filePath);
    session.inGitRepo = inRepo;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) await attachDocument(win, session.filePath); // reload state into renderer
    return inRepo;
  });

  ipcMain.handle(IPC.gitLog, async (event) => {
    const session = requireSession(event.sender.id);
    if (!session.inGitRepo) return [];
    return fileLog(session.filePath);
  });

  ipcMain.handle(IPC.getRecents, async () => {
    return getRecentFiles();
  });

  ipcMain.handle(IPC.openExternal, async (_event, filePath: string) => {
    await shell.openPath(path.resolve(filePath));
  });

  ipcMain.handle(IPC.openFolderDialog, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    await showOpenFolderDialog(win);
  });

  // Re-read the document from disk (external change accepted by the user).
  ipcMain.handle(IPC.reloadDoc, async (event) => {
    const session = requireSession(event.sender.id);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) await attachDocument(win, session.filePath);
  });

  // Restore doc + sidecar to a commit; checkpoint first so it's reversible.
  ipcMain.handle(IPC.gitRestore, async (event, hash: string) => {
    const session = requireSession(event.sender.id);
    if (!session.inGitRepo) throw new Error('Not in a git repository');
    try {
      await commitCheckpoint(session.filePath, `Checkpoint before restoring ${hash}`);
    } catch {
      /* nothing to checkpoint is fine */
    }
    await restoreFromCommit(session.filePath, hash);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) await attachDocument(win, session.filePath); // reload from disk
  });

  ipcMain.handle(IPC.getWorkspace, async (event) => {
    const session = getSession(event.sender.id);
    if (!session) return null;
    return getWorkspace(session.filePath);
  });

  // Switch the sender window to another document. If that document is open
  // in a different window already, focus it there instead (Netscope rule).
  ipcMain.handle(IPC.openInWindow, async (event, filePath: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const current = getSession(event.sender.id);
    const resolved = path.resolve(filePath);
    if (current?.filePath === resolved) return;
    const elsewhere = findSessionByPath(resolved);
    if (elsewhere) {
      await openFile(resolved); // focuses the existing window
      return;
    }
    await attachDocument(win, resolved);
  });

  ipcMain.on(IPC.caretContext, (event, ctx: { inTable: boolean }) => {
    const session = getSession(event.sender.id);
    if (session) session.caretInTable = !!ctx?.inTable;
  });

  ipcMain.handle(IPC.readProposal, async (event, id: string) => {
    const session = requireSession(event.sender.id);
    const { proposals } = await loadProposals(session.workspaceRoot);
    const proposal = proposals.find((p) => p.id === id);
    if (!proposal) return null;
    const content = await readProposalContent(session.workspaceRoot, proposal);
    return { proposal, content };
  });

  ipcMain.handle(IPC.acceptProposal, async (event, id: string) => {
    const session = requireSession(event.sender.id);
    const { absPath } = await acceptProposal(session.workspaceRoot, id);
    return absPath;
  });

  ipcMain.handle(IPC.rejectProposal, async (event, id: string, comment?: string) => {
    const session = requireSession(event.sender.id);
    await rejectProposal(session.workspaceRoot, id, comment);
  });

  ipcMain.handle(IPC.getProjectsDir, async () => (await getSettings()).projectsDir);

  ipcMain.handle(IPC.setupMessage, (_event, transcript: SetupMessage[]) =>
    runSetupTurn(transcript),
  );

  // One confirm materializes the whole project: folder, seed files, git
  // repo, and the setup transcript seeded as the project discussion.
  ipcMain.handle(
    IPC.createProject,
    async (event, proposal: ProjectProposal, transcript: SetupMessage[]) => {
      const { projectsDir } = await getSettings();
      const folder = path.basename(path.normalize(proposal.folderName));
      if (!folder || folder === '.' || folder === '..' || folder.startsWith('.')) {
        throw new Error(`Invalid project folder name: ${proposal.folderName}`);
      }
      const target = path.join(projectsDir, folder);
      let exists = false;
      try {
        await fs.access(target);
        exists = true;
      } catch {
        /* free, as expected */
      }
      if (exists) throw new Error(`${target} already exists — pick another name.`);

      await fs.mkdir(target, { recursive: true });
      let firstMd: string | null = null;
      for (const file of proposal.files) {
        const rel = path.normalize(file.path).replace(/^[/\\]+/, '');
        if (rel.split(/[/\\]/).some((seg) => seg === '..' || seg.startsWith('.'))) {
          throw new Error(`Invalid file path in proposal: ${file.path}`);
        }
        const abs = path.join(target, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, file.content.endsWith('\n') ? file.content : `${file.content}\n`, 'utf8');
        if (!firstMd && /\.(md|markdown|mdx)$/i.test(rel)) firstMd = abs;
      }
      // Seed the project discussion with the setup conversation, so the
      // first review round starts with the framing already in place.
      const messages: DiscussionMessage[] = transcript.map((m) => ({
        id: nanoid(8),
        author: m.author,
        text: m.text,
        createdAt: new Date().toISOString(),
      }));
      await saveDiscussion(target, { version: 1, messages });
      await initProjectRepo(target, `New project: ${proposal.title}`);

      if (!firstMd) throw new Error('The proposal contained no markdown file to open.');
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      await openFile(firstMd, win);
      return target;
    },
  );
}
