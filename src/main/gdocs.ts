/**
 * Google Docs auth bridge: wraps gdocs-sync's OAuth surface for the
 * Settings screen. The library is bundled into the main bundle via the
 * vite alias (see electron.vite.config.ts) — it is standalone and knows
 * nothing about Margin; this file is the integration layer.
 */
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { promises as fs } from 'fs';
import {
  authStatus,
  authorize,
  saveClientConfig,
  setFallbackClient,
  signOut,
} from '@dru89/gdocs-sync';
import type { GdocsAuthStatus } from '@shared/types';
import { IPC } from '@shared/ipc';
import { DEFAULT_OAUTH_CLIENT } from './defaultOAuthClient';

let connecting: AbortController | null = null;

async function currentStatus(): Promise<GdocsAuthStatus> {
  const s = await authStatus();
  return {
    clientSource: s.clientSource === 'fallback' ? 'default' : s.clientSource,
    clientPath: s.clientPath,
    connected: s.connected,
    scopes: s.scopes,
    connecting: connecting !== null,
  };
}

async function broadcastStatus(): Promise<void> {
  const status = await currentStatus();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.gdocsAuthChanged, status);
  }
}

export function registerGdocsIpc(): void {
  setFallbackClient(DEFAULT_OAUTH_CLIENT);

  ipcMain.handle(IPC.gdocsStatus, () => currentStatus());

  // Fire-and-return like submitReview: progress lands via gdocsAuthChanged.
  ipcMain.handle(IPC.gdocsConnect, async () => {
    if (connecting) return;
    connecting = new AbortController();
    const signal = connecting.signal;
    void broadcastStatus();
    try {
      await authorize(undefined, {
        signal,
        onUrl: (url) => void shell.openExternal(url),
      });
    } catch (err) {
      // Cancel is user-initiated; anything else surfaces on next status pull.
      console.warn(`Google auth failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      connecting = null;
      void broadcastStatus();
    }
  });

  ipcMain.handle(IPC.gdocsCancelConnect, () => {
    connecting?.abort();
  });

  ipcMain.handle(IPC.gdocsDisconnect, async () => {
    await signOut();
    await broadcastStatus();
  });

  // Import an OAuth client: from pasted JSON, or via a file picker when
  // no JSON is provided. Returns an error message instead of throwing so
  // the Settings screen can show it inline.
  ipcMain.handle(
    IPC.gdocsImportClient,
    async (event, json?: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        let raw = json;
        if (raw === undefined) {
          const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
          const result = await dialog.showOpenDialog(win!, {
            title: 'Import Google OAuth Client',
            filters: [{ name: 'OAuth client JSON', extensions: ['json'] }],
            properties: ['openFile'],
          });
          if (result.canceled || result.filePaths.length === 0) return { ok: true };
          raw = await fs.readFile(result.filePaths[0], 'utf8');
        }
        await saveClientConfig(raw);
        await broadcastStatus();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}

// ————— Link + push (spec §Product model; DECISIONS §51) —————

import path from 'path';
import {
  createFromMarkdown,
  fetchAsMarkdown,
  updateFromMarkdown,
  getAccessToken,
  makeDocxStager,
  mdToCanonicalWithMeta,
  HttpDocsClient,
} from '@dru89/gdocs-sync';
import type { GdocsSyncState } from '@shared/types';
import { commitCheckpoint } from './git';
import { getSession } from './session';
import { contentRef, linkFor, removeLink, upsertLink } from './gdocsLinks';
import { promises as fsp } from 'fs';

const busyDocs = new Set<string>();

function docUrl(docId: string): string {
  return `https://docs.google.com/document/d/${docId}/edit`;
}

function docsClient(): HttpDocsClient {
  return new HttpDocsClient(async () => (await getAccessToken())!);
}

async function syncState(webContentsId: number): Promise<GdocsSyncState> {
  const session = getSession(webContentsId);
  if (!session) return { linked: false, busy: false, connected: false };
  const rel = path.relative(session.workspaceRoot, session.filePath);
  const link = await linkFor(session.workspaceRoot, rel);
  const status = await authStatus();
  return {
    linked: link !== null,
    docUrl: link ? docUrl(link.docId) : undefined,
    lastSyncAt: link?.lastSyncAt,
    busy: link ? busyDocs.has(link.docId) : busyDocs.has(`create:${session.filePath}`),
    connected: status.connected,
  };
}

async function pushStateTo(event: Electron.IpcMainInvokeEvent): Promise<void> {
  const state = await syncState(event.sender.id);
  event.sender.send(IPC.gdocsSyncChanged, state);
}

export function registerGdocsSyncIpc(): void {
  ipcMain.handle(IPC.gdocsSyncState, (event) => syncState(event.sender.id));

  ipcMain.handle(IPC.openUrl, async (_event, url: string) => {
    if (!/^https:\/\//.test(url)) throw new Error('only https URLs');
    await shell.openExternal(url);
  });

  // "Share to Google Docs": create the Doc from the saved file, link it.
  ipcMain.handle(IPC.gdocsShareCreate, async (event): Promise<{ error?: string }> => {
    const session = getSession(event.sender.id);
    if (!session) return { error: 'No document open' };
    const busyKey = `create:${session.filePath}`;
    if (busyDocs.has(busyKey)) return {};
    busyDocs.add(busyKey);
    void pushStateTo(event);
    try {
      const markdown = await fsp.readFile(session.filePath, 'utf8');
      const fileName = path.basename(session.filePath);
      const title =
        mdToCanonicalWithMeta(markdown).meta.title ?? fileName.replace(/\.(md|markdown|mdx)$/i, '');
      if (session.inGitRepo) {
        await commitCheckpoint(session.filePath, `Before sharing ${fileName} to Google Docs`).catch(() => false);
      }
      const c = docsClient();
      const { documentId } = await createFromMarkdown(c, title, markdown, {
        baseDir: path.dirname(session.filePath),
        imageStager: makeDocxStager(async () => (await getAccessToken())!),
      });
      const revisionId = (await c.getDocument(documentId)).revisionId ?? '';
      await upsertLink(session.workspaceRoot, {
        file: path.relative(session.workspaceRoot, session.filePath),
        docId: documentId,
        revisionId,
        baseRef: contentRef(markdown),
        lastSyncAt: new Date().toISOString(),
      });
      return {};
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      busyDocs.delete(busyKey);
      void pushStateTo(event);
    }
  });

  // Push: doc-readback vs markdown diff inside updateFromMarkdown.
  // Conflict rule (spec): if the Doc moved since last sync, don't
  // proceed silently — the caller re-invokes with force after the user
  // confirms. Refusals (pending suggestions) surface as errors.
  ipcMain.handle(
    IPC.gdocsPushDoc,
    async (
      event,
      force: boolean,
    ): Promise<{ error?: string; conflict?: boolean; regions?: number }> => {
      const session = getSession(event.sender.id);
      if (!session) return { error: 'No document open' };
      const rel = path.relative(session.workspaceRoot, session.filePath);
      const link = await linkFor(session.workspaceRoot, rel);
      if (!link) return { error: 'Not linked to a Google Doc' };
      if (busyDocs.has(link.docId)) return {};
      busyDocs.add(link.docId);
      void pushStateTo(event);
      try {
        const markdown = await fsp.readFile(session.filePath, 'utf8');
        const c = docsClient();
        if (!force) {
          const docRev = (await c.getDocument(link.docId)).revisionId ?? '';
          if (docRev !== link.revisionId) return { conflict: true };
        }
        if (session.inGitRepo) {
          await commitCheckpoint(session.filePath, `Before pushing ${rel} to Google Docs`).catch(() => false);
        }
        const plan = await updateFromMarkdown(c, link.docId, markdown, {
          baseDir: path.dirname(session.filePath),
          imageStager: makeDocxStager(async () => (await getAccessToken())!),
        });
        const revisionId = (await c.getDocument(link.docId)).revisionId ?? '';
        await upsertLink(session.workspaceRoot, {
          ...link,
          revisionId,
          baseRef: contentRef(markdown),
          lastSyncAt: new Date().toISOString(),
        });
        return { regions: plan.regions };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      } finally {
        busyDocs.delete(link.docId);
        void pushStateTo(event);
      }
    },
  );

  // Pull: Doc → markdown → the local file, through the existing
  // external-change path (the session watcher reloads a clean editor).
  // Symmetric conflict rule: pulling reverts local edits, so any local
  // movement since last sync asks first.
  ipcMain.handle(
    IPC.gdocsPullDoc,
    async (
      event,
      force: boolean,
    ): Promise<{ error?: string; conflict?: boolean; upToDate?: boolean }> => {
      const session = getSession(event.sender.id);
      if (!session) return { error: 'No document open' };
      const rel = path.relative(session.workspaceRoot, session.filePath);
      const link = await linkFor(session.workspaceRoot, rel);
      if (!link) return { error: 'Not linked to a Google Doc' };
      if (busyDocs.has(link.docId)) return {};
      busyDocs.add(link.docId);
      void pushStateTo(event);
      try {
        const current = await fsp.readFile(session.filePath, 'utf8');
        if (!force && contentRef(current) !== link.baseRef) return { conflict: true };
        if (session.inGitRepo) {
          await commitCheckpoint(session.filePath, `Before pulling ${rel} from Google Docs`).catch(() => false);
        }
        const c = docsClient();
        const markdown = await fetchAsMarkdown(c, link.docId, {
          preserveFrontmatterFrom: current,
        });
        const revisionId = (await c.getDocument(link.docId)).revisionId ?? '';
        const upToDate = markdown === current;
        if (!upToDate) {
          await fsp.writeFile(session.filePath, markdown, 'utf8');
          if (session.inGitRepo) {
            await commitCheckpoint(session.filePath, `Pulled ${rel} from Google Docs`).catch(() => false);
          }
        }
        await upsertLink(session.workspaceRoot, {
          ...link,
          revisionId,
          baseRef: contentRef(markdown),
          lastSyncAt: new Date().toISOString(),
        });
        return { upToDate };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      } finally {
        busyDocs.delete(link.docId);
        void pushStateTo(event);
      }
    },
  );

  ipcMain.handle(IPC.gdocsUnlink, async (event) => {
    const session = getSession(event.sender.id);
    if (!session) return;
    await removeLink(session.workspaceRoot, path.relative(session.workspaceRoot, session.filePath));
    await pushStateTo(event);
  });
}
