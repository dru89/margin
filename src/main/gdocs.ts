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
